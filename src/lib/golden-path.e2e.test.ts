// GOLDEN-PATH end-to-end integration test.
//
// Every lib in this CRM is unit-tested in isolation, but the HAND-OFFS between
// them have never been exercised against a single real database. This test
// drives the REAL in-house functions in production sequence and asserts that
// canonical state converges correctly at each hop:
//
//   inbound inquiry intake  →  approve → canonical project + client + participant
//        →  invoice + scheduled payments (retainer + installments)
//        →  Stripe checkout link mint (link_ready CAS, canonical URL)
//        →  verified checkout.session.completed webhook → payment settles
//        →  settle is idempotent (replay does not double-count)
//        →  gallery delivery link attached + surfaced on the project.
//
// ONLY genuine external boundaries are stubbed (the Stripe API HTTP call, via
// globalThis.fetch, exactly like unified-sign-pay.test.ts). No business logic is
// re-implemented; no money moves; no canonical schema is changed.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-golden-path-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STRIPE_SECRET_KEY = "sk_test_golden_path";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_golden_path";
process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
delete process.env.RESEND_API_KEY;
delete process.env.INQUIRY_INTAKE_ENABLED;

const CHECKOUT_URL = "https://api.stripe.com/v1/checkout/sessions";

// ---- Stripe API HTTP stub (the ONLY external boundary faked). Records the
// checkout-session create calls and mints a realistic { id, url } session object,
// exactly as the sibling checkout tests do. No real Stripe call is ever made. ----
type CreateCall = { unitAmount: string; customerEmail: string; paymentId: string; invoiceId: string; metadataServiceOpenCents: string; metadataClientPayableOpenCents: string };
const createCalls: CreateCall[] = [];
let sessionCounter = 0;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
  const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? "";
  const method = init?.method ?? "GET";
  if (url === CHECKOUT_URL && method === "POST") {
    const params = new URLSearchParams(init?.body != null ? String(init.body) : "");
    sessionCounter += 1;
    const id = `cs_test_golden_${sessionCounter}`;
    createCalls.push({
      unitAmount: params.get("line_items[0][price_data][unit_amount]") ?? "",
      customerEmail: params.get("customer_email") ?? "",
      paymentId: params.get("metadata[payment_id]") ?? "",
      invoiceId: params.get("metadata[invoice_id]") ?? "",
      metadataServiceOpenCents: params.get("metadata[service_open_cents]") ?? "",
      metadataClientPayableOpenCents: params.get("metadata[client_payable_open_cents]") ?? "",
    });
    return jsonResponse({ id, url: `https://checkout.stripe.com/pay/${id}` });
  }
  // No other external call should occur on the golden path.
  return realFetch(input as never, init as never);
}) as typeof fetch;

function signedHeader(rawBody: string) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET!).update(`${ts}.${rawBody}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { ingestInboundInquiry, approveInquiryProjectCreation } = await import("./inbound-inquiry");
  const { createInvoiceFromForm } = await import("./sales");
  const { createInvoicePaymentCheckoutSession, handleStripeCheckoutWebhook } = await import("./stripe-checkout");
  const { createProjectGallery } = await import("./gallery");
  const { getProject } = await import("./crm");
  const { updateAppSettingsFromForm } = await import("./settings");
  const { invoiceClientPayableBalanceCents } = await import("./invoice-balances");
  const database = rawDb();

  // Turn on Stripe with pass-through card fees so the golden path exercises the
  // client-pays fee columns (a realistic Reese Photography configuration).
  const settingsForm = new FormData();
  settingsForm.set("stripeEnabled", "on");
  settingsForm.set("stripePassFees", "on");
  await updateAppSettingsFromForm(settingsForm);

  // =========================================================================
  // HOP 1 — Inbound inquiry intake  →  approve  →  canonical project.
  // Real functions: ingestInboundInquiry() then approveInquiryProjectCreation()
  // (which calls createProjectFromAgent — the canonical project-create path).
  // =========================================================================
  const raw = [
    'From: "Jordan Blake" <jordan.blake@example.com>',
    "Subject: Wedding photography inquiry",
    "Content-Type: text/plain",
    "",
    "Hi! We are getting married on 2026-10-17. Venue: The Grand Estate.",
    "We would love to talk about coverage.",
  ].join("\n");

  const ingest = await ingestInboundInquiry({
    headerFrom: '"Jordan Blake" <jordan.blake@example.com>',
    envelopeFrom: "jordan.blake@example.com",
    subject: "Wedding photography inquiry",
    messageId: "<golden-path-inquiry-1@example.com>",
    raw,
  });
  assert.equal(ingest.status, "proposed", "HOP1: intake drafts a proposed inquiry (no canonical write yet)");
  assert.equal(ingest.deduped, false, "HOP1: fresh inquiry row");

  const approval = await approveInquiryProjectCreation(ingest.id, { actorName: "Tyler Reese" });
  assert.equal(approval.alreadyApproved, false, "HOP1: first approval creates the project");
  const projectId = approval.projectId;

  // Canonical shape: project + primary participant + client with the parsed email.
  const projectRow = database.prepare("SELECT id, name, type, stage, status, event_date, venue_name FROM projects WHERE id = ?").get(projectId) as Record<string, unknown>;
  assert.ok(projectRow, "HOP1: canonical project row exists");
  assert.equal(projectRow.stage, "inquiry", "HOP1: project starts at the inquiry stage");
  assert.equal(projectRow.status, "active", "HOP1: project active");
  assert.equal(projectRow.type, "wedding", "HOP1: project typed wedding from the draft");
  assert.equal(projectRow.event_date, "2026-10-17", "HOP1: parsed event date carried onto the canonical project");
  assert.equal(projectRow.venue_name, "The Grand Estate", "HOP1: parsed venue carried onto the canonical project");

  const participantRow = database.prepare(
    "SELECT client_id, role, is_primary_contact FROM project_participants WHERE project_id = ?",
  ).get(projectId) as Record<string, unknown>;
  assert.ok(participantRow, "HOP1: a project participant exists");
  assert.equal(participantRow.is_primary_contact, 1, "HOP1: participant is the primary contact");
  assert.equal(participantRow.role, "primary", "HOP1: participant role is primary");

  const clientRow = database.prepare("SELECT id, email, first_name FROM clients WHERE id = ?").get(participantRow.client_id) as Record<string, unknown>;
  assert.equal(clientRow.email, "jordan.blake@example.com", "HOP1: primary client email is the parsed inquiry sender");
  assert.equal(clientRow.first_name, "Jordan", "HOP1: primary client first name parsed from the sender display name");

  // Inquiry is now linked to the canonical project it produced.
  const inquiryAfter = database.prepare("SELECT status, project_id FROM inbound_inquiries WHERE id = ?").get(ingest.id) as Record<string, unknown>;
  assert.equal(inquiryAfter.status, "approved", "HOP1: inquiry marked approved");
  assert.equal(inquiryAfter.project_id, projectId, "HOP1: inquiry links to the created project");

  // =========================================================================
  // HOP 2 — Invoice + scheduled payments (retainer + 2 installments).
  // Real function: createInvoiceFromForm().
  // =========================================================================
  const TOTAL_CENTS = 400000;         // $4,000
  const RETAINER_CENTS = 120000;      // $1,200 retainer
  const INSTALLMENT_CENTS = 140000;   // remaining $2,800 split into two $1,400 installments
  const invoiceForm = new FormData();
  invoiceForm.set("projectId", projectId);
  invoiceForm.set("total", "4000");
  invoiceForm.set("retainerAmount", "1200");
  invoiceForm.set("installmentCount", "2");
  invoiceForm.set("status", "sent");
  invoiceForm.set("acceptedPaymentMethod", "stripe");
  const invoiceResult = await createInvoiceFromForm(invoiceForm);
  const invoiceId = invoiceResult.invoiceId;

  const invoiceRow = database.prepare(
    "SELECT total_cents, amount_paid_cents, status, card_fee_policy, card_fee_amount_cents FROM invoices WHERE id = ?",
  ).get(invoiceId) as Record<string, unknown>;
  assert.equal(invoiceRow.total_cents, TOTAL_CENTS, "HOP2: invoice total is $4,000");
  assert.equal(invoiceRow.amount_paid_cents, 0, "HOP2: nothing paid yet");
  assert.equal(invoiceRow.card_fee_policy, "client_pays", "HOP2: client-pays card fee policy (Stripe pass-through)");
  // 2.9% + $0.30 on $4,000 = $116.30.
  const EXPECTED_CARD_FEE_CENTS = 11630;
  assert.equal(invoiceRow.card_fee_amount_cents, EXPECTED_CARD_FEE_CENTS, "HOP2: card fee = 2.9% + $0.30 on the total");

  const paymentRows = database.prepare(
    "SELECT id, label, amount_cents, status FROM invoice_payments WHERE invoice_id = ? ORDER BY created_at, label",
  ).all(invoiceId) as Array<Record<string, unknown>>;
  assert.equal(paymentRows.length, 3, "HOP2: retainer + two installments scheduled");
  const scheduleTotal = paymentRows.reduce((sum, row) => sum + Number(row.amount_cents), 0);
  assert.equal(scheduleTotal, TOTAL_CENTS, "HOP2: scheduled payments sum to the invoice total (schedule-total guard)");
  const retainer = paymentRows.find((row) => row.label === "Retainer")!;
  assert.ok(retainer, "HOP2: a labeled Retainer payment exists");
  assert.equal(retainer.amount_cents, RETAINER_CENTS, "HOP2: retainer amount is $1,200");
  assert.equal(retainer.status, "pending", "HOP2: retainer starts pending");
  const installments = paymentRows.filter((row) => row.label !== "Retainer");
  assert.equal(installments.length, 2, "HOP2: exactly two installments");
  for (const inst of installments) {
    assert.equal(inst.amount_cents, INSTALLMENT_CENTS, "HOP2: each installment is $1,400");
  }
  const retainerPaymentId = String(retainer.id);

  // =========================================================================
  // HOP 3 — Mint the Stripe checkout link for the retainer.
  // Real function: createInvoicePaymentCheckoutSession() (stubs ONLY the Stripe
  // HTTP call). Asserts the Phase-12 link_ready CAS + canonical URL.
  // =========================================================================
  createCalls.length = 0;
  const checkout = await createInvoicePaymentCheckoutSession(invoiceId, retainerPaymentId, { actorType: "client", actorName: "Jordan Blake" });

  // The retainer's client-payable = service open ($1,200) + its proportional
  // share of the card fee ($116.30 * 1200/4000 = $34.89) = $1,234.89.
  const EXPECTED_CLIENT_PAYABLE_CENTS = 123489;
  assert.equal(createCalls.length, 1, "HOP3: exactly one Stripe checkout-session create call");
  assert.equal(createCalls[0].paymentId, retainerPaymentId, "HOP3: Stripe session is for the retainer payment");
  assert.equal(createCalls[0].unitAmount, String(EXPECTED_CLIENT_PAYABLE_CENTS), "HOP3: charged amount = retainer + proportional card fee");
  assert.equal(createCalls[0].customerEmail, "jordan.blake@example.com", "HOP3: primary client email on the session");
  assert.equal(createCalls[0].metadataServiceOpenCents, String(RETAINER_CENTS), "HOP3: metadata service_open_cents = retainer service amount");
  assert.equal(createCalls[0].metadataClientPayableOpenCents, String(EXPECTED_CLIENT_PAYABLE_CENTS), "HOP3: metadata client_payable_open_cents");

  const sessionId = `cs_test_golden_${sessionCounter}`;
  assert.equal(checkout.checkoutStatus, "link_ready", "HOP3: payment CAS-updated to link_ready");
  assert.equal(checkout.checkoutSessionId, sessionId, "HOP3: canonical session id returned");
  assert.equal(checkout.checkoutUrl, `https://checkout.stripe.com/pay/${sessionId}`, "HOP3: canonical redirect URL is the stored (re-read) session URL");
  assert.equal(checkout.clientPayableOpenCents, EXPECTED_CLIENT_PAYABLE_CENTS, "HOP3: returned client-payable matches the charged amount");

  const retainerAfterMint = database.prepare(
    "SELECT stripe_checkout_status, stripe_checkout_session_id, stripe_checkout_url FROM invoice_payments WHERE id = ?",
  ).get(retainerPaymentId) as Record<string, unknown>;
  assert.equal(retainerAfterMint.stripe_checkout_status, "link_ready", "HOP3: row persisted link_ready (CAS committed)");
  assert.equal(retainerAfterMint.stripe_checkout_session_id, sessionId, "HOP3: row persisted the canonical session id");
  assert.equal(retainerAfterMint.stripe_checkout_url, `https://checkout.stripe.com/pay/${sessionId}`, "HOP3: row persisted the canonical session URL");

  // =========================================================================
  // HOP 4 — Verified checkout.session.completed webhook settles the retainer.
  // Real function: handleStripeCheckoutWebhook() — drives the REAL signature
  // verification (verifyStripeWebhookPayload) then the settle handler.
  // =========================================================================
  const settleEvent = {
    id: "evt_golden_settle",
    type: "checkout.session.completed",
    created: 1780000000,
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        status: "complete",
        payment_status: "paid",
        amount_total: EXPECTED_CLIENT_PAYABLE_CENTS,
        payment_intent: "pi_golden_retainer",
        metadata: {
          invoice_id: invoiceId,
          payment_id: retainerPaymentId,
          project_id: projectId,
          service_open_cents: String(RETAINER_CENTS),
          client_payable_open_cents: String(EXPECTED_CLIENT_PAYABLE_CENTS),
        },
      },
    },
  };
  const settleRaw = JSON.stringify(settleEvent);
  const settleResult = await handleStripeCheckoutWebhook(settleRaw, signedHeader(settleRaw)) as Record<string, unknown>;
  assert.equal(settleResult.ignored, false, "HOP4: verified settle event is processed");
  assert.equal(settleResult.paymentId, retainerPaymentId, "HOP4: settled the retainer payment");

  // Retainer converges to paid with the gross/fee columns set.
  const EXPECTED_CLIENT_FEE_CENTS = 3489; // amount_total - service open
  const retainerSettled = database.prepare(
    "SELECT status, payment_method, paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents, external_payment_id, stripe_checkout_status FROM invoice_payments WHERE id = ?",
  ).get(retainerPaymentId) as Record<string, unknown>;
  assert.deepEqual(retainerSettled, {
    status: "paid",
    payment_method: "stripe",
    paid_amount_cents: RETAINER_CENTS,
    client_fee_cents: EXPECTED_CLIENT_FEE_CENTS,
    processing_fee_cents: EXPECTED_CLIENT_FEE_CENTS,
    gross_collected_cents: EXPECTED_CLIENT_PAYABLE_CENTS,
    net_deposit_cents: RETAINER_CENTS,
    external_payment_id: "pi_golden_retainer",
    stripe_checkout_status: "paid",
  }, "HOP4: retainer settled with correct paid/fee/gross/net ledger columns");

  // Invoice reconciled to partially_paid; amountPaid = retainer service amount.
  const invoiceAfterSettle = database.prepare("SELECT status, amount_paid_cents, paid_at FROM invoices WHERE id = ?").get(invoiceId) as Record<string, unknown>;
  assert.equal(invoiceAfterSettle.status, "partially_paid", "HOP4: invoice reconciled to partially_paid");
  assert.equal(invoiceAfterSettle.amount_paid_cents, RETAINER_CENTS, "HOP4: invoice amountPaid = retainer");
  assert.equal(invoiceAfterSettle.paid_at, null, "HOP4: invoice not fully paid yet");

  // Project auto-advanced inquiry → retainer_paid on the settled retainer.
  const projectAfterSettle = database.prepare("SELECT stage FROM projects WHERE id = ?").get(projectId) as Record<string, unknown>;
  assert.equal(projectAfterSettle.stage, "retainer_paid", "HOP4: project stage auto-advanced to retainer_paid");

  // ---- Idempotency: replay the SAME verified event → no double-count. ----
  const settleActivityCountBefore = database.prepare(
    "SELECT COUNT(*) FROM activity_logs WHERE action = 'invoice.payment_recorded_from_stripe_checkout'",
  ).pluck().get();
  const replay = await handleStripeCheckoutWebhook(settleRaw, signedHeader(settleRaw)) as Record<string, unknown>;
  assert.equal(replay.ignored, true, "HOP4: replayed settle is an idempotent no-op");
  assert.equal(replay.reason, "invoice_payment_already_paid", "HOP4: replay recognized the payment as already paid");

  const retainerAfterReplay = database.prepare(
    "SELECT status, paid_amount_cents, gross_collected_cents FROM invoice_payments WHERE id = ?",
  ).get(retainerPaymentId) as Record<string, unknown>;
  assert.deepEqual(retainerAfterReplay, {
    status: "paid",
    paid_amount_cents: RETAINER_CENTS,
    gross_collected_cents: EXPECTED_CLIENT_PAYABLE_CENTS,
  }, "HOP4: replay did not change the settled ledger (no double-count)");
  const invoiceAfterReplay = database.prepare("SELECT amount_paid_cents FROM invoices WHERE id = ?").pluck().get(invoiceId);
  assert.equal(invoiceAfterReplay, RETAINER_CENTS, "HOP4: replay did not double the invoice amountPaid");
  const settleActivityCountAfter = database.prepare(
    "SELECT COUNT(*) FROM activity_logs WHERE action = 'invoice.payment_recorded_from_stripe_checkout'",
  ).pluck().get();
  assert.equal(settleActivityCountAfter, settleActivityCountBefore, "HOP4: replay logged no second payment-recorded activity");

  // =========================================================================
  // HOP 5 — Gallery delivery link attached + surfaced on the project.
  // Real function: createProjectGallery().
  // =========================================================================
  const DELIVERY_URL = "https://thereeses.pic-time.com/client/jordan-blake-wedding/gallery";
  const gallery = await createProjectGallery({
    projectId,
    title: "Jordan & Blake — Wedding Gallery",
    url: DELIVERY_URL,
    status: "delivered",
    actorName: "Tyler Reese",
  });
  assert.equal(gallery.status, "delivered", "HOP5: gallery marked delivered");
  assert.equal(gallery.provider, "Pic-Time", "HOP5: provider inferred from the Pic-Time host");
  assert.ok(gallery.deliveredAt, "HOP5: server-controlled deliveredAt stamped on delivery");

  const galleryRow = database.prepare("SELECT url, status, delivered_at FROM project_galleries WHERE project_id = ?").get(projectId) as Record<string, unknown>;
  assert.equal(galleryRow.url, DELIVERY_URL, "HOP5: delivery link stored on the project gallery row");
  assert.equal(galleryRow.status, "delivered", "HOP5: stored gallery is delivered");
  assert.ok(galleryRow.delivered_at, "HOP5: deliveredAt persisted");

  // Surfaced through the canonical project reader (the same shape the UI/agent read).
  const projectContext = await getProject(projectId);
  assert.ok(projectContext, "HOP5: project loads");
  assert.equal(projectContext!.galleries.length, 1, "HOP5: exactly one gallery surfaced on the project");
  assert.equal(projectContext!.galleries[0].url, DELIVERY_URL, "HOP5: delivery link surfaced on the project");

  // =========================================================================
  // FINAL end-to-end canonical state.
  // =========================================================================
  const finalInvoice = database.prepare("SELECT total_cents, amount_paid_cents, card_fee_amount_cents, status FROM invoices WHERE id = ?").get(invoiceId) as {
    total_cents: number; amount_paid_cents: number; card_fee_amount_cents: number; status: string;
  };
  const finalPayments = database.prepare(
    "SELECT status, amount_cents, paid_amount_cents, gross_collected_cents FROM invoice_payments WHERE invoice_id = ?",
  ).all(invoiceId) as Array<{ status: string; amountCents: number; paid_amount_cents: number; gross_collected_cents: number }>;
  const remainingBalanceCents = invoiceClientPayableBalanceCents(
    { totalCents: finalInvoice.total_cents, amountPaidCents: finalInvoice.amount_paid_cents, cardFeeAmountCents: finalInvoice.card_fee_amount_cents },
    finalPayments.map((row) => ({ status: row.status, amountCents: (row as unknown as { amount_cents: number }).amount_cents, paidAmountCents: row.paid_amount_cents, grossCollectedCents: row.gross_collected_cents })),
  );
  // Client-payable ($4,000 + $116.30 fee = $4,116.30) minus retainer gross collected ($1,234.89) = $2,881.41.
  assert.equal(remainingBalanceCents, 288141, "FINAL: remaining client-payable balance = total + fee − retainer gross collected");

  assert.equal(projectAfterSettle.stage, "retainer_paid", "FINAL: project is booked (retainer_paid)");
  const paidCount = finalPayments.filter((row) => row.status === "paid").length;
  assert.equal(paidCount, 1, "FINAL: exactly the retainer is paid; installments remain open");
  assert.equal(projectContext!.galleries[0].status, "delivered", "FINAL: delivery gallery present and delivered");

  console.log("golden-path end-to-end integration test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
