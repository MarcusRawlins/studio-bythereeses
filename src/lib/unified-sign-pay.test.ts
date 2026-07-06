// Phase 12 — Unified accept-sign-PAY (§9 test plan). Money-critical: no double-charge, correct
// retainer, no regression to existing installment/portal checkout. Every scenario stubs
// globalThis.fetch so NO real Stripe call / money movement happens; api.stripe.com hits are counted.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-unified-sign-pay-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STRIPE_SECRET_KEY = "sk_test_studio_p12";
process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
delete process.env.UNIFIED_SIGN_PAY;

const CHECKOUT_URL = "https://api.stripe.com/v1/checkout/sessions";
const NOW = "2026-07-01T12:00:00.000Z";

type CreateCall = {
  successUrl: string;
  cancelUrl: string;
  mode: string;
  unitAmount: string;
  customerEmail: string;
  paymentId: string;
  invoiceId: string;
  body: string;
};
const createCalls: CreateCall[] = [];
const getCalls: string[] = [];
const expireCalls: string[] = [];
const sessionStore = new Map<string, { successUrl: string; cancelUrl: string; status: string }>();
let sessionCounter = 0;
let holdCreate: Promise<void> | null = null;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
  const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? "";
  const method = init?.method ?? "GET";

  const expireMatch = url.match(/\/v1\/checkout\/sessions\/([^/]+)\/expire$/);
  if (expireMatch) {
    const id = decodeURIComponent(expireMatch[1]);
    expireCalls.push(id);
    const stored = sessionStore.get(id);
    if (stored) stored.status = "expired";
    return jsonResponse({ id, status: "expired" });
  }

  if (url === CHECKOUT_URL && method === "POST") {
    const params = new URLSearchParams(init?.body != null ? String(init.body) : "");
    if (holdCreate) await holdCreate;
    sessionCounter += 1;
    const id = `cs_test_${sessionCounter}`;
    const hostedUrl = `https://checkout.stripe.com/pay/${id}`;
    const successUrl = params.get("success_url") ?? "";
    const cancelUrl = params.get("cancel_url") ?? "";
    sessionStore.set(id, { successUrl, cancelUrl, status: "open" });
    createCalls.push({
      successUrl,
      cancelUrl,
      mode: params.get("mode") ?? "",
      unitAmount: params.get("line_items[0][price_data][unit_amount]") ?? "",
      customerEmail: params.get("customer_email") ?? "",
      paymentId: params.get("metadata[payment_id]") ?? "",
      invoiceId: params.get("metadata[invoice_id]") ?? "",
      body: init?.body != null ? String(init.body) : "",
    });
    return jsonResponse({ id, url: hostedUrl });
  }

  const getMatch = url.match(/\/v1\/checkout\/sessions\/([^/?]+)$/);
  if (getMatch && method === "GET") {
    const id = decodeURIComponent(getMatch[1]);
    getCalls.push(id);
    const stored = sessionStore.get(id);
    if (!stored) return jsonResponse({}, 404);
    return jsonResponse({ id, success_url: stored.successUrl, cancel_url: stored.cancelUrl, status: stored.status });
  }

  return realFetch(input as never, init as never);
}) as typeof fetch;

async function main() {
  const { rawDb } = await import("@/db/client");
  const sales = await import("./sales");
  const checkout = await import("./stripe-checkout");
  const flags = await import("./finance-flags");
  const route = await import("../app/api/proposal/[token]/accept/route");
  const database = rawDb();

  let seq = 0;
  function uid(prefix: string) {
    seq += 1;
    return `${prefix}-${seq}`;
  }

  function seedProject() {
    const id = uid("proj");
    database.prepare(`INSERT INTO projects (id, name, type, stage, status, created_at, updated_at) VALUES (?, 'P12 Wedding', 'wedding', 'proposal_sent', 'active', ?, ?)`).run(id, NOW, NOW);
    return id;
  }
  function seedClient(email: string | null) {
    const id = uid("client");
    database.prepare(`INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at) VALUES (?, 'Robin', 'Reese', ?, ?, ?)`).run(id, email, NOW, NOW);
    return id;
  }
  function seedParticipant(projectId: string, clientId: string, isPrimary = true) {
    database.prepare(`INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at) VALUES (?, ?, ?, 'client', ?, ?)`).run(uid("pp"), projectId, clientId, isPrimary ? 1 : 0, NOW);
  }
  function seedProposal(projectId: string, opts: { status?: string; contractStatus?: string; contractBody?: string | null; signedAt?: string | null; signerName?: string | null } = {}) {
    const id = uid("prop");
    database.prepare(`INSERT INTO proposals (id, project_id, title, status, package_name, total_cents, contract_status, contract_title, contract_body, signed_at, accepted_at, signer_name, created_at, updated_at) VALUES (?, ?, 'Wedding Proposal', ?, 'Signature Collection', 500000, ?, 'Agreement', ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, opts.status ?? "sent", opts.contractStatus ?? "ready", opts.contractBody === undefined ? "Agreement text." : opts.contractBody, opts.signedAt ?? null, opts.signedAt ? NOW : null, opts.signerName ?? null, NOW, NOW);
    return id;
  }
  function seedToken(proposalId: string, projectId: string, clientId: string, opts: { expiresAt?: string; revokedAt?: string | null } = {}) {
    const token = uid("token");
    database.prepare(`INSERT INTO proposal_access_tokens (id, proposal_id, project_id, client_id, token_hash, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uid("tok"), proposalId, projectId, clientId, sales.hashProposalToken(token), opts.expiresAt ?? "2027-01-01T00:00:00.000Z", opts.revokedAt ?? null, NOW);
    return token;
  }
  function seedInvoice(projectId: string, proposalId: string | null, opts: { status?: string; totalCents?: number; cardFeeAmountCents?: number } = {}) {
    const id = uid("inv");
    database.prepare(`INSERT INTO invoices (id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents, card_fee_policy, card_fee_amount_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 'studio_absorbs', ?, ?, ?)`)
      .run(id, projectId, proposalId, uid("INV"), opts.status ?? "sent", opts.totalCents ?? 100000000, opts.cardFeeAmountCents ?? 0, NOW, NOW);
    return id;
  }
  function seedPayment(invoiceId: string, opts: { label?: string; amountCents?: number; paidAmountCents?: number; status?: string; dueDate?: string | null; createdAt?: string; checkoutStatus?: string; checkoutUrl?: string | null; checkoutSessionId?: string | null }) {
    const id = uid("pay");
    database.prepare(`INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents, stripe_checkout_url, stripe_checkout_session_id, stripe_checkout_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?, ?)`)
      .run(id, invoiceId, opts.label ?? "Retainer", opts.amountCents ?? 50000, opts.dueDate ?? "2026-08-01", opts.status ?? "pending", opts.paidAmountCents ?? 0, opts.paidAmountCents ?? 0, opts.checkoutUrl ?? null, opts.checkoutSessionId ?? null, opts.checkoutStatus ?? "not_created", opts.createdAt ?? NOW, NOW);
    return id;
  }
  function paymentRow(id: string) {
    return database.prepare("SELECT * FROM invoice_payments WHERE id = ?").get(id) as Record<string, unknown>;
  }
  function proposalRow(id: string) {
    return database.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Record<string, unknown>;
  }
  async function postAccept(token: string, fields: Record<string, string>) {
    const body = new URLSearchParams(fields);
    const req = new Request(`https://app.example.com/api/proposal/${token}/accept`, { method: "POST", body });
    return route.POST(req, { params: Promise.resolve({ token }) });
  }
  function resetStripe() {
    createCalls.length = 0;
    getCalls.length = 0;
    expireCalls.length = 0;
  }

  // =========================================================================
  // §9.1 Flag helper — strict === "1".
  // =========================================================================
  {
    assert.equal(flags.unifiedSignPayEnabled({ UNIFIED_SIGN_PAY: "1" }), true, "§9.1 '1' → ON");
    for (const v of [undefined, "", "0", "true", "on", "yes"] as (string | undefined)[]) {
      assert.equal(flags.unifiedSignPayEnabled({ UNIFIED_SIGN_PAY: v }), false, `§9.1 '${v}' → OFF`);
    }
  }

  // =========================================================================
  // §9.2 resolveProposalRetainerCheckout — selection rule + edge cases.
  // =========================================================================
  {
    // Labeled retainer + later installments → returns the retainer, ignores later payments.
    const proj = seedProject();
    const prop = seedProposal(proj);
    const inv = seedInvoice(proj, prop);
    const retainer = seedPayment(inv, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01" });
    seedPayment(inv, { label: "Final balance", amountCents: 400000, dueDate: "2026-10-01" });
    const pick = await sales.resolveProposalRetainerCheckout(prop);
    assert.equal(pick?.paymentId, retainer, "§9.2 labeled retainer selected over later installment");
    assert.equal(pick?.clientPayableOpenCents, 100000, "§9.2 retainer client-payable open");
  }
  {
    // No labeled retainer → earliest of ALL payments (dueDate NULLS LAST).
    const proj = seedProject();
    const prop = seedProposal(proj);
    const inv = seedInvoice(proj, prop);
    seedPayment(inv, { label: "Payment 2", amountCents: 200000, dueDate: "2026-10-01" });
    const earliest = seedPayment(inv, { label: "Payment 1", amountCents: 100000, dueDate: "2026-08-01" });
    seedPayment(inv, { label: "Payment 3 (no due)", amountCents: 200000, dueDate: null });
    const pick = await sales.resolveProposalRetainerCheckout(prop);
    assert.equal(pick?.paymentId, earliest, "§9.2 earliest of ALL payments selected (no label)");
  }
  {
    // Single lump-sum → returns that payment.
    const proj = seedProject();
    const prop = seedProposal(proj);
    const inv = seedInvoice(proj, prop);
    const lump = seedPayment(inv, { label: "Balance", amountCents: 500000, dueDate: "2026-09-01" });
    const pick = await sales.resolveProposalRetainerCheckout(prop);
    assert.equal(pick?.paymentId, lump, "§9.2 single lump-sum is the retainer");
  }
  {
    // Retainer already paid → null.
    const proj = seedProject();
    const prop = seedProposal(proj);
    const inv = seedInvoice(proj, prop);
    seedPayment(inv, { label: "Retainer", amountCents: 100000, status: "paid", paidAmountCents: 100000, dueDate: "2026-08-01" });
    const pick = await sales.resolveProposalRetainerCheckout(prop);
    assert.equal(pick, null, "§9.2 paid retainer → null");
  }
  {
    // Finding 2 — retainer PAID + final balance OPEN → null (never falls through to the balance).
    const proj = seedProject();
    const prop = seedProposal(proj);
    const inv = seedInvoice(proj, prop);
    const retainer = seedPayment(inv, { label: "Retainer", amountCents: 100000, status: "paid", paidAmountCents: 100000, dueDate: "2026-08-01" });
    const finalOpen = seedPayment(inv, { label: "Final balance", amountCents: 400000, status: "pending", dueDate: "2026-10-01" });
    const pick = await sales.resolveProposalRetainerCheckout(prop);
    assert.equal(pick, null, "§9.2/Finding 2 retainer paid + final open → NULL, never the balance");
    // Predicate not forked: the retainer identity is unchanged regardless of settlement.
    const allRows = database.prepare("SELECT * FROM invoice_payments WHERE invoice_id = ?").all(inv) as Array<{ id: string; label: string; due_date: string | null; created_at: string }>;
    const camel = allRows.map((r) => ({ id: r.id, label: r.label, dueDate: r.due_date, createdAt: r.created_at }));
    const { resolveRetainerPayment } = await import("./retainer-selection");
    assert.equal(resolveRetainerPayment(camel)?.id, retainer, "§9.2 retainer identity unchanged (over ALL payments)");
    assert.notEqual(resolveRetainerPayment(camel)?.id, finalOpen, "§9.2 identity is NOT the final balance");
  }
  {
    // $0 / no payments → null; void invoice excluded.
    const proj = seedProject();
    const prop = seedProposal(proj);
    seedInvoice(proj, prop); // invoice, no payments
    assert.equal(await sales.resolveProposalRetainerCheckout(prop), null, "§9.2 no payments → null");

    const proj2 = seedProject();
    const prop2 = seedProposal(proj2);
    const voidInv = seedInvoice(proj2, prop2, { status: "void" });
    seedPayment(voidInv, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01" });
    assert.equal(await sales.resolveProposalRetainerCheckout(prop2), null, "§9.2 payment on a void invoice excluded → null");
  }
  {
    // IDOR — selector for proposal A never returns proposal B's payment.
    const projA = seedProject();
    const propA = seedProposal(projA);
    const invA = seedInvoice(projA, propA);
    const payA = seedPayment(invA, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01" });
    const projB = seedProject();
    const propB = seedProposal(projB);
    const invB = seedInvoice(projB, propB);
    const payB = seedPayment(invB, { label: "Retainer", amountCents: 999999, dueDate: "2026-08-01" });
    const pickA = await sales.resolveProposalRetainerCheckout(propA);
    assert.equal(pickA?.paymentId, payA, "§9.2 IDOR: A returns A's payment");
    assert.notEqual(pickA?.paymentId, payB, "§9.2 IDOR: A never returns B's payment");
  }

  // =========================================================================
  // §9.9 returnUrls additivity — existing installment caller byte-identical.
  // =========================================================================
  {
    resetStripe();
    const proj = seedProject();
    const client = seedClient("robin@example.com");
    seedParticipant(proj, client);
    const inv = seedInvoice(proj, null, { totalCents: 100000 });
    const pay = seedPayment(inv, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01" });
    const noOverride = await checkout.createInvoicePaymentCheckoutSession(inv, pay, { actorType: "admin" });
    assert.equal(createCalls.length, 1, "§9.9 one create call (no override)");
    assert.equal(createCalls[0].successUrl, `https://app.example.com/portal?checkout=success&invoiceId=${inv}&paymentId=${pay}`, "§9.9 default success_url = current /portal string (byte-identical, incl query params)");
    assert.equal(createCalls[0].cancelUrl, `https://app.example.com/portal?checkout=cancelled&invoiceId=${inv}&paymentId=${pay}`, "§9.9 default cancel_url = current /portal string");
    assert.equal(noOverride.checkoutUrl, `https://checkout.stripe.com/pay/${createCalls[0] && "cs_test_" + sessionCounter}`, "§9.9 returns the minted (single-caller canonical) url");
    const moneyFieldsNoOverride = { mode: createCalls[0].mode, unitAmount: createCalls[0].unitAmount, email: createCalls[0].customerEmail, paymentId: createCalls[0].paymentId };

    // With override — same money fields, only return routing differs.
    resetStripe();
    const inv2 = seedInvoice(proj, null, { totalCents: 100000 });
    const pay2 = seedPayment(inv2, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01" });
    const withOverride = await checkout.createInvoicePaymentCheckoutSession(inv2, pay2, {
      actorType: "client",
      returnUrls: { successUrl: "https://app.example.com/proposal/tok?booked=1", cancelUrl: "https://app.example.com/proposal/tok?accepted=1&checkout=cancelled" },
    });
    assert.equal(createCalls[0].successUrl, "https://app.example.com/proposal/tok?booked=1", "§9.9 override success_url used");
    assert.equal(createCalls[0].cancelUrl, "https://app.example.com/proposal/tok?accepted=1&checkout=cancelled", "§9.9 override cancel_url used");
    assert.equal(createCalls[0].mode, moneyFieldsNoOverride.mode, "§9.9 mode identical");
    assert.equal(createCalls[0].unitAmount, moneyFieldsNoOverride.unitAmount, "§9.9 unit_amount identical");
    assert.equal(createCalls[0].customerEmail, moneyFieldsNoOverride.email, "§9.9 customer_email identical");
    assert.ok(withOverride.checkoutUrl.startsWith("https://checkout.stripe.com/pay/"), "§9.9 canonical url returned");

    // Open-redirect rejection.
    resetStripe();
    const inv3 = seedInvoice(proj, null, { totalCents: 100000 });
    const pay3 = seedPayment(inv3, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01" });
    await assert.rejects(
      () => checkout.createInvoicePaymentCheckoutSession(inv3, pay3, { actorType: "client", returnUrls: { successUrl: "https://evil.example.com/x", cancelUrl: "https://app.example.com/proposal/tok?accepted=1" } }),
      /return URLs must be on the application origin/,
      "§9.9 off-origin return URL rejected",
    );
    assert.equal(createCalls.length, 0, "§9.9 zero Stripe calls on open-redirect rejection");
  }

  // =========================================================================
  // §9.12 Concurrent accept → EXACTLY ONE canonical session (Finding 1 BLOCKER).
  // =========================================================================
  {
    resetStripe();
    const proj = seedProject();
    const client = seedClient("race@example.com");
    seedParticipant(proj, client);
    const inv = seedInvoice(proj, null, { totalCents: 100000 });
    const pay = seedPayment(inv, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01" });
    const opts = {
      actorType: "client" as const,
      returnUrls: { successUrl: "https://app.example.com/proposal/tok?booked=1", cancelUrl: "https://app.example.com/proposal/tok?accepted=1&checkout=cancelled" },
    };
    let release: () => void = () => {};
    holdCreate = new Promise<void>((resolve) => { release = resolve; });
    const p1 = checkout.createInvoicePaymentCheckoutSession(inv, pay, opts);
    const p2 = checkout.createInvoicePaymentCheckoutSession(inv, pay, opts);
    for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
    release();
    holdCreate = null;
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.checkoutUrl, r2.checkoutUrl, "§9.12 both racers converge on the SAME canonical checkout URL");
    const storedSessionId = paymentRow(pay).stripe_checkout_session_id as string;
    assert.ok(storedSessionId && storedSessionId.length > 0, "§9.12 a single canonical session id is stored");
    assert.equal(r1.checkoutSessionId, storedSessionId, "§9.12 returned session id is the stored canonical one");
    assert.equal(r2.checkoutSessionId, storedSessionId, "§9.12 loser also returns the stored canonical id (not its in-flight session)");
    // Both minted (2 create calls) but only ONE is canonical; the loser's is never handed to a browser.
    assert.equal(createCalls.length, 2, "§9.12 both raced to mint (no lock), but…");
    const canonicalUrl = `https://checkout.stripe.com/pay/${storedSessionId}`;
    assert.equal(r1.checkoutUrl, canonicalUrl, "§9.12 …the redirect target is the STORED canonical URL, never the raw in-flight session.url");
    assert.equal(paymentRow(pay).stripe_checkout_status, "link_ready", "§9.12 canonical row is link_ready");
  }

  // =========================================================================
  // §9.13 Reuse with DIFFERENT return URLs → expire + re-mint (no second payable session).
  // Control: matching return URLs → reuse verbatim (no expire, no re-mint).
  // =========================================================================
  {
    // Admin-pre-minted /portal session on the row → client override differs → expire + re-mint.
    resetStripe();
    const proj = seedProject();
    const client = seedClient("mismatch@example.com");
    seedParticipant(proj, client);
    const inv = seedInvoice(proj, null, { totalCents: 100000 });
    const adminSessionId = "cs_admin_portal";
    sessionStore.set(adminSessionId, {
      successUrl: `https://app.example.com/portal?checkout=success&invoiceId=${inv}`,
      cancelUrl: `https://app.example.com/portal?checkout=cancelled&invoiceId=${inv}`,
      status: "open",
    });
    const pay = seedPayment(inv, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01", checkoutStatus: "link_ready", checkoutUrl: `https://checkout.stripe.com/pay/${adminSessionId}`, checkoutSessionId: adminSessionId });
    const clientReturn = { successUrl: "https://app.example.com/proposal/tok?booked=1", cancelUrl: "https://app.example.com/proposal/tok?accepted=1&checkout=cancelled" };
    const res = await checkout.createInvoicePaymentCheckoutSession(inv, pay, { actorType: "client", returnUrls: clientReturn });
    assert.deepEqual(expireCalls, [adminSessionId], "§9.13 the wrong-return-URL admin session is EXPIRED exactly once");
    assert.equal(createCalls.length, 1, "§9.13 exactly one fresh mint after expire");
    assert.equal(createCalls[0].successUrl, clientReturn.successUrl, "§9.13 re-mint uses client return URLs");
    assert.equal(createCalls[0].unitAmount, "100000", "§9.13 money field unit_amount identical to a normal mint");
    assert.equal(createCalls[0].mode, "payment", "§9.13 mode identical");
    assert.equal(createCalls[0].customerEmail, "mismatch@example.com", "§9.13 customer_email identical");
    assert.equal(res.checkoutSessionId, paymentRow(pay).stripe_checkout_session_id, "§9.13 canonical id stored");
    assert.notEqual(res.checkoutSessionId, adminSessionId, "§9.13 canonical is the fresh session, not the expired admin one");
    assert.equal(sessionStore.get(adminSessionId)?.status, "expired", "§9.13 old session is uncompletable (expired) → no second payable session");

    // Control: stored session's return URLs already MATCH the override → reuse verbatim.
    resetStripe();
    const inv2 = seedInvoice(proj, null, { totalCents: 100000 });
    const matchSessionId = "cs_match_token";
    sessionStore.set(matchSessionId, { successUrl: clientReturn.successUrl, cancelUrl: clientReturn.cancelUrl, status: "open" });
    const pay2 = seedPayment(inv2, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01", checkoutStatus: "link_ready", checkoutUrl: `https://checkout.stripe.com/pay/${matchSessionId}`, checkoutSessionId: matchSessionId });
    const reuse = await checkout.createInvoicePaymentCheckoutSession(inv2, pay2, { actorType: "client", returnUrls: clientReturn });
    assert.equal(expireCalls.length, 0, "§9.13 control: matching URLs → NO expire");
    assert.equal(createCalls.length, 0, "§9.13 control: matching URLs → NO re-mint");
    assert.equal(reuse.reused, true, "§9.13 control: reused verbatim");
    assert.equal(reuse.checkoutSessionId, matchSessionId, "§9.13 control: reuses the stored session");
  }

  // =========================================================================
  // §9.3 Accept route — flag OFF (byte-identical; zero Stripe calls).
  // =========================================================================
  {
    resetStripe();
    delete process.env.UNIFIED_SIGN_PAY;
    const proj = seedProject();
    const client = seedClient("off@example.com");
    seedParticipant(proj, client);
    const prop = seedProposal(proj);
    const token = seedToken(prop, proj, client);
    const inv = seedInvoice(proj, prop, { totalCents: 500000 });
    seedPayment(inv, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01" });
    const res = await postAccept(token, { signatureName: "Robin Reese", signatureConsent: "on", signatureEmail: "off@example.com" });
    assert.equal(res.status, 303, "§9.3 flag off → 303");
    assert.equal(res.headers.get("location"), "https://app.example.com/proposal/" + token + "?accepted=1", "§9.3 flag off → ?accepted=1 (today's dead-end)");
    assert.equal(createCalls.length, 0, "§9.3 flag off → ZERO Stripe calls");
    assert.ok(proposalRow(prop).signed_at, "§9.3 signature persisted");
  }

  // =========================================================================
  // §9.4 Accept route — flag ON, retainer due → 303 to canonical checkout URL.
  // =========================================================================
  {
    resetStripe();
    process.env.UNIFIED_SIGN_PAY = "1";
    const proj = seedProject();
    const client = seedClient("on@example.com");
    seedParticipant(proj, client);
    const prop = seedProposal(proj);
    const token = seedToken(prop, proj, client);
    const inv = seedInvoice(proj, prop, { totalCents: 500000 });
    const retainer = seedPayment(inv, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01" });
    seedPayment(inv, { label: "Final balance", amountCents: 400000, dueDate: "2026-10-01" });
    const res = await postAccept(token, { signatureName: "Robin Reese", signatureConsent: "on", signatureEmail: "on@example.com" });
    assert.equal(res.status, 303, "§9.4 303");
    const loc = res.headers.get("location") ?? "";
    assert.ok(loc.startsWith("https://checkout.stripe.com/pay/"), "§9.4 redirects to the stored canonical checkout URL");
    assert.equal(loc, `https://checkout.stripe.com/pay/${paymentRow(retainer).stripe_checkout_session_id}`, "§9.4 = the re-read stored URL, not the in-flight session.url");
    assert.equal(createCalls.length, 1, "§9.4 exactly one checkout-session create");
    assert.equal(createCalls[0].successUrl, `https://app.example.com/proposal/${token}?booked=1`, "§9.4 success_url = token surface ?booked=1");
    assert.equal(createCalls[0].cancelUrl, `https://app.example.com/proposal/${token}?accepted=1&checkout=cancelled`, "§9.4 cancel_url = ?accepted=1&checkout=cancelled");
    assert.equal(createCalls[0].paymentId, retainer, "§9.4 metadata.payment_id = the retainer (not the final balance)");
  }

  // =========================================================================
  // §9.6 Abandon-at-checkout resumability + resume-CTA payload.
  // =========================================================================
  {
    resetStripe();
    process.env.UNIFIED_SIGN_PAY = "1";
    const proj = seedProject();
    const client = seedClient("resume@example.com");
    seedParticipant(proj, client);
    const prop = seedProposal(proj);
    const token = seedToken(prop, proj, client);
    const inv = seedInvoice(proj, prop, { totalCents: 100000 });
    const retainer = seedPayment(inv, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01" });
    const first = await postAccept(token, { signatureName: "Robin Reese", signatureConsent: "on", signatureEmail: "resume@example.com" });
    assert.equal(createCalls.length, 1, "§9.6 first sign mints one session");
    const firstSignedAt = proposalRow(prop).signed_at;
    const canonicalSession = paymentRow(retainer).stripe_checkout_session_id;
    // Re-POST the resume-CTA payload (recorded signer name + consent=on) → reuses same canonical.
    const resume = await postAccept(token, { signatureName: "Robin Reese", signatureConsent: "on", signatureEmail: "resume@example.com" });
    assert.equal(createCalls.length, 1, "§9.6 resume re-POST reuses the same canonical session (no second create)");
    assert.equal(paymentRow(retainer).stripe_checkout_session_id, canonicalSession, "§9.6 canonical session unchanged");
    assert.equal(proposalRow(prop).signed_at, firstSignedAt, "§9.6 signedAt unchanged (no double-sign)");
    assert.equal(resume.headers.get("location"), first.headers.get("location"), "§9.6 resume redirects to the same canonical URL");

    // Resume-CTA validation guard: missing consent → 303 to ?signature=… and ZERO Stripe sessions.
    resetStripe();
    const bad = await postAccept(token, { signatureName: "Robin Reese", signatureEmail: "resume@example.com" });
    assert.equal(bad.status, 303, "§9.6 missing consent → 303");
    assert.ok((bad.headers.get("location") ?? "").includes("signature=signature_consent_required"), "§9.6 missing consent → ?signature=signature_consent_required");
    assert.equal(createCalls.length, 0, "§9.6 missing consent → ZERO Stripe sessions");
  }

  // =========================================================================
  // §9.5 Flag ON, no retainer ($0 / all settled) → ?accepted=1, zero Stripe calls.
  // §9.7 No-double-charge after paid → selector null → ?accepted=1, zero new calls.
  // =========================================================================
  {
    resetStripe();
    process.env.UNIFIED_SIGN_PAY = "1";
    // $0 / no payments.
    const proj = seedProject();
    const client = seedClient("zero@example.com");
    seedParticipant(proj, client);
    const prop = seedProposal(proj);
    const token = seedToken(prop, proj, client);
    seedInvoice(proj, prop, { totalCents: 0 }); // no payments
    const res = await postAccept(token, { signatureName: "Robin Reese", signatureConsent: "on", signatureEmail: "zero@example.com" });
    assert.equal(res.headers.get("location"), `https://app.example.com/proposal/${token}?accepted=1`, "§9.5 $0/no retainer → ?accepted=1");
    assert.equal(createCalls.length, 0, "§9.5 zero Stripe calls");

    // Already-paid retainer → selector null → ?accepted=1, zero calls (§9.7).
    resetStripe();
    const proj2 = seedProject();
    const client2 = seedClient("paid@example.com");
    seedParticipant(proj2, client2);
    const prop2 = seedProposal(proj2, { status: "sent", contractStatus: "ready" });
    const token2 = seedToken(prop2, proj2, client2);
    const inv2 = seedInvoice(proj2, prop2, { totalCents: 100000 });
    seedPayment(inv2, { label: "Retainer", amountCents: 100000, status: "paid", paidAmountCents: 100000, dueDate: "2026-08-01" });
    const res2 = await postAccept(token2, { signatureName: "Robin Reese", signatureConsent: "on", signatureEmail: "paid@example.com" });
    assert.equal(res2.headers.get("location"), `https://app.example.com/proposal/${token2}?accepted=1`, "§9.7 paid retainer → ?accepted=1");
    assert.equal(createCalls.length, 0, "§9.7 zero new Stripe calls after paid");
  }

  // =========================================================================
  // §9.8 Mint-failure fallback (no client email) → ?accepted=1; signature stands.
  // =========================================================================
  {
    resetStripe();
    process.env.UNIFIED_SIGN_PAY = "1";
    const proj = seedProject();
    const client = seedClient("noprimary@example.com");
    // Non-PRIMARY participant only → token is valid (client belongs to project) but the checkout
    // mint (which joins on isPrimaryContact) finds no primary client email → it throws.
    seedParticipant(proj, client, false);
    const prop = seedProposal(proj);
    const token = seedToken(prop, proj, client);
    const inv = seedInvoice(proj, prop, { totalCents: 100000 });
    seedPayment(inv, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01" });
    const res = await postAccept(token, { signatureName: "Robin Reese", signatureConsent: "on" });
    assert.equal(res.status, 303, "§9.8 303");
    assert.equal(res.headers.get("location"), `https://app.example.com/proposal/${token}?accepted=1`, "§9.8 mint failure → ?accepted=1 fallback");
    assert.equal(createCalls.length, 0, "§9.8 no session minted (no email)");
    assert.ok(proposalRow(prop).signed_at, "§9.8 signature STANDS after mint failure (resumable)");
  }

  // =========================================================================
  // §9.11 Security / no-IDOR at the route: expired/revoked/invalid token → no mint.
  // =========================================================================
  {
    resetStripe();
    process.env.UNIFIED_SIGN_PAY = "1";
    const proj = seedProject();
    const client = seedClient("sec@example.com");
    seedParticipant(proj, client);
    const prop = seedProposal(proj);
    const inv = seedInvoice(proj, prop, { totalCents: 100000 });
    seedPayment(inv, { label: "Retainer", amountCents: 100000, dueDate: "2026-08-01" });
    const expired = seedToken(prop, proj, client, { expiresAt: "2020-01-01T00:00:00.000Z" });
    const revoked = seedToken(prop, proj, client, { revokedAt: NOW });
    for (const [label, token] of [["expired", expired], ["revoked", revoked], ["unknown", "not-a-real-token"]] as const) {
      const res = await postAccept(token, { signatureName: "Robin Reese", signatureConsent: "on", signatureEmail: "sec@example.com" });
      assert.equal(res.status, 404, `§9.11 ${label} token → 404 (unchanged)`);
    }
    assert.equal(createCalls.length, 0, "§9.11 invalid tokens → ZERO Stripe calls");
  }

  console.log("phase 12 unified sign&pay tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
