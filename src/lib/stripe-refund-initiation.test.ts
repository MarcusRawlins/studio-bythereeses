// Phase 9b — refund INITIATION tests (the §9 test list; money-critical acceptance criteria).
// Every scenario spies on `fetch` and asserts the count of POST https://api.stripe.com/v1/refunds
// calls. The Stripe call is STUBBED — no real network, no real money.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-refund-initiation-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STRIPE_SECRET_KEY = "sk_test_studio_9b";
process.env.REFUND_INITIATION_ENABLED = "1"; // ON for most scenarios; toggled in the flag test
delete process.env.FINANCE_REFUND_RECORDING; // record_only default (9a recording enabled)

const REFUND_URL = "https://api.stripe.com/v1/refunds";
const NOW = "2026-07-01T12:00:00.000Z";

type StripeCall = { body: string; idempotencyKey: string | undefined; authorization: string | undefined };
const stripeCalls: StripeCall[] = [];
let stripeNextError: { status: number; message: string } | null = null;
let reCounter = 0;
// When set, a refund POST records its call immediately (so the call COUNT reflects how many
// executes reached the money-moving call) then PARKS until released — lets the concurrent-race
// test hold the CAS winner at Stripe while the loser runs its CAS + re-read (§9.23).
let stripeHold: Promise<void> | null = null;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
  const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? "";
  if (url === REFUND_URL) {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bodyText = init?.body != null ? String(init.body) : "";
    stripeCalls.push({ body: bodyText, idempotencyKey: headers["idempotency-key"], authorization: headers.authorization });
    if (stripeHold) await stripeHold;
    if (stripeNextError) {
      const err = stripeNextError;
      stripeNextError = null;
      return new Response(JSON.stringify({ error: { message: err.message } }), { status: err.status, headers: { "content-type": "application/json" } });
    }
    const params = new URLSearchParams(bodyText);
    reCounter += 1;
    const id = `re_9b_${reCounter}`;
    return new Response(JSON.stringify({ id, status: "succeeded", amount: Number(params.get("amount")) }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input as never, init as never);
}) as typeof fetch;

function callCount() {
  return stripeCalls.length;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const mod = await import("./stripe-refund-initiation");
  const flags = await import("./finance-flags");
  const database = rawDb();

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('proj-9b', 'Refund Init Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(NOW, NOW);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-9b', 'Robin', 'Reese', 'robin9b@example.com', ?, ?)
  `).run(NOW, NOW);

  let invCounter = 0;
  function seedInvoice(invId: string, opts: { cardFeePolicy?: string } = {}) {
    invCounter += 1;
    // status 'sent' with a generous total avoids the paid-state + schedule-total triggers
    // (0037/0038); this test exercises refund gating, not invoice-balance math.
    database.prepare(`
      INSERT INTO invoices (id, project_id, invoice_number, status, total_cents, amount_paid_cents, card_fee_policy, card_fee_amount_cents, created_at, updated_at)
      VALUES (?, 'proj-9b', ?, 'sent', 1000000, 0, ?, 0, ?, ?)
    `).run(invId, `INV-9B-${invCounter}`, opts.cardFeePolicy ?? "studio_absorbs", NOW, NOW);
  }
  function seedPayment(payId: string, invId: string, opts: {
    label?: string;
    amountCents?: number;
    paidAmountCents: number;
    grossCollectedCents: number;
    clientFeeCents?: number;
    status?: string;
    pi?: string | null;
    dueDate?: string | null;
    disputeStatus?: string | null;
    disputedAmountCents?: number;
    refundedAmountCents?: number;
  }) {
    database.prepare(`
      INSERT INTO invoice_payments (
        id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
        paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
        net_deposit_cents, external_payment_id, stripe_checkout_status,
        refunded_amount_cents, dispute_status, disputed_amount_cents, last_refund_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'stripe', ?, ?, 0, ?, ?, ?, 'paid', ?, ?, ?, NULL, ?, ?)
    `).run(
      payId, invId, opts.label ?? "Final balance", opts.amountCents ?? opts.paidAmountCents, opts.dueDate ?? "2026-06-01",
      opts.status ?? "paid", opts.status === "paid" || opts.status === undefined ? NOW : null,
      opts.paidAmountCents, opts.clientFeeCents ?? 0, opts.grossCollectedCents,
      opts.grossCollectedCents - (opts.clientFeeCents ?? 0),
      opts.pi === undefined ? `pi_${payId}` : opts.pi,
      opts.refundedAmountCents ?? 0, opts.disputeStatus ?? null, opts.disputedAmountCents ?? 0,
      NOW, NOW,
    );
  }
  function riCount(payId: string) {
    return database.prepare("SELECT COUNT(*) FROM refund_initiations WHERE invoice_payment_id = ?").pluck().get(payId) as number;
  }
  function riRow(id: string) {
    return database.prepare("SELECT * FROM refund_initiations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }
  function activityCount(action: string, paymentId: string) {
    return database.prepare("SELECT COUNT(*) FROM activity_logs WHERE action = ? AND metadata LIKE ?").pluck().get(action, `%${paymentId}%`) as number;
  }

  // ===========================================================================
  // §9.1 Happy path (mocked Stripe) — full refund, non-retainer, service basis.
  // §9.19 studio_absorbs: paidAmountCents == grossCollectedCents.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-happy");
    seedPayment("pay-happy", "inv-happy", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10" });
    // add an earlier retainer so pay-happy is NOT the earliest (keeps it non-retainer)
    seedPayment("pay-happy-ret", "inv-happy", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_happy_ret" });

    const prep = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-happy", paymentId: "pay-happy", actorType: "admin", actorName: "Tyler Reese" });
    assert.equal(prep.maxRefundableCents, 20000, "§9.1 prepare prefills the full service amount");
    assert.equal(riRow(prep.initiationId)?.status, "pending", "§9.1 prepare mints a pending row");

    const res = await mod.initiateInvoicePaymentRefund({
      invoiceId: "inv-happy", paymentId: "pay-happy", initiationId: prep.initiationId,
      amountCents: 20000, confirmAmountCents: 20000, reason: "Wedding cancelled; service not rendered.",
      serviceNotRenderedConfirmed: true, actorType: "admin", actorName: "Tyler Reese",
    });
    assert.equal(res.status, "succeeded", "§9.1 execute succeeds");
    assert.equal(callCount(), 1, "§9.1 exactly one POST /v1/refunds");
    assert.equal(stripeCalls[0].idempotencyKey, prep.initiationId, "§9.1 Idempotency-Key = initiationId");
    const sent = new URLSearchParams(stripeCalls[0].body);
    assert.equal(sent.get("amount"), "20000", "§9.1 amount sent = maxRefundable (service basis)");
    assert.equal(sent.get("payment_intent"), "pi_pay-happy", "§9.1 refunds against the stored payment intent");
    assert.equal(sent.get("metadata[initiation_id]"), prep.initiationId, "§9.1 initiation_id metadata is load-bearing for reconcile");
    const row = riRow(prep.initiationId)!;
    assert.equal(row.status, "succeeded", "§9.1 row → succeeded");
    assert.ok(String(row.stripe_refund_id).startsWith("re_"), "§9.1 row stores re_ id");
    assert.equal(row.service_not_rendered_confirmed, 1, "§9.1 snr affirmation persisted");
    assert.equal(row.reason, "Wedding cancelled; service not rendered.", "§9.1 reason persisted");
    assert.equal(activityCount("invoice.payment_refund_initiated", "pay-happy"), 1, "§9.1 initiated activity logged");
  }

  // ===========================================================================
  // §9.12 No direct payment_refunds write; webhook (9a) creates exactly one row.
  // ===========================================================================
  {
    const re = String(riRow(database.prepare("SELECT id FROM refund_initiations WHERE invoice_payment_id = 'pay-happy'").pluck().get() as string)?.stripe_refund_id);
    assert.equal(database.prepare("SELECT COUNT(*) FROM payment_refunds WHERE stripe_refund_id = ?").pluck().get(re), 0, "§9.12 9b did NOT write payment_refunds");
    assert.equal(database.prepare("SELECT refunded_amount_cents FROM invoice_payments WHERE id = 'pay-happy'").pluck().get(), 0, "§9.12 9b did NOT touch refunded_amount_cents");
    const { recordStripeChargeRefunded } = await import("./stripe-refunds");
    await recordStripeChargeRefunded({
      id: "evt_happy_cr", type: "charge.refunded", created: Math.floor(Date.parse(NOW) / 1000),
      data: { object: { id: "ch_pay-happy", payment_intent: "pi_pay-happy", amount_refunded: 20000, currency: "usd", refunds: { object: "list", data: [{ id: re, amount: 20000, status: "succeeded", currency: "usd", payment_intent: "pi_pay-happy", charge: "ch_pay-happy", created: Math.floor(Date.parse(NOW) / 1000) }] } } },
    });
    assert.equal(database.prepare("SELECT COUNT(*) FROM payment_refunds WHERE stripe_refund_id = ?").pluck().get(re), 1, "§9.12 webhook creates exactly one canonical row");
  }

  // ===========================================================================
  // §9.18 Service-portion ceiling excludes the client card fee (client-pays).
  // §9.3 Over-cap (gross) rejected — service basis, not gross.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-fee", { cardFeePolicy: "client_pays" });
    seedPayment("pay-fee-ret", "inv-fee", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_fee_ret" });
    seedPayment("pay-fee", "inv-fee", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20590, clientFeeCents: 590, dueDate: "2026-06-10" });

    const prep = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-fee", paymentId: "pay-fee", actorType: "admin" });
    assert.equal(prep.maxRefundableCents, 20000, "§9.18 ceiling is the SERVICE portion (20000), not gross (20590)");

    // request for the gross amount is rejected, zero stripe calls
    await assert.rejects(
      () => mod.initiateInvoicePaymentRefund({ invoiceId: "inv-fee", paymentId: "pay-fee", initiationId: prep.initiationId, amountCents: 20590, confirmAmountCents: 20590, reason: "cancel", serviceNotRenderedConfirmed: true, actorType: "admin" }),
      /exceeds the refundable service balance/,
      "§9.3 gross request rejected (service ceiling)",
    );
    assert.equal(callCount(), 0, "§9.3 zero Stripe calls on over-cap");
    assert.equal(activityCount("invoice.payment_refund_initiation_failed", "pay-fee"), 1, "§9.3 initiation_failed logged");
    // 20001 also rejected
    await assert.rejects(
      () => mod.initiateInvoicePaymentRefund({ invoiceId: "inv-fee", paymentId: "pay-fee", initiationId: prep.initiationId, amountCents: 20001, confirmAmountCents: 20001, reason: "cancel", serviceNotRenderedConfirmed: true, actorType: "admin" }),
      /exceeds the refundable service balance/,
      "§9.18 20001 rejected",
    );
    // service amount succeeds, sends 20000 not gross
    const ok = await mod.initiateInvoicePaymentRefund({ invoiceId: "inv-fee", paymentId: "pay-fee", initiationId: prep.initiationId, amountCents: 20000, confirmAmountCents: 20000, reason: "cancel", serviceNotRenderedConfirmed: true, actorType: "admin" });
    assert.equal(ok.status, "succeeded");
    assert.equal(callCount(), 1, "§9.18 exactly one call for the accepted service amount");
    assert.equal(new URLSearchParams(stripeCalls[0].body).get("amount"), "20000", "§9.18 sends service (20000), never gross");
  }

  // ===========================================================================
  // §9.2 Partial refund accepted.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-partial");
    seedPayment("pay-partial-ret", "inv-partial", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_partial_ret" });
    seedPayment("pay-partial", "inv-partial", { label: "Final balance", paidAmountCents: 30000, grossCollectedCents: 30000, dueDate: "2026-06-10" });
    const prep = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-partial", paymentId: "pay-partial", actorType: "admin" });
    const res = await mod.initiateInvoicePaymentRefund({ invoiceId: "inv-partial", paymentId: "pay-partial", initiationId: prep.initiationId, amountCents: 10000, confirmAmountCents: 10000, reason: "partial", serviceNotRenderedConfirmed: true, actorType: "admin" });
    assert.equal(res.status, "succeeded", "§9.2 partial accepted");
    assert.equal(res.amountCents, 10000, "§9.2 partial amount");
    assert.equal(callCount(), 1);
  }

  // ===========================================================================
  // §9.4 DEDUPE-UNION cap: refundedAmountCents=0 but a prior succeeded initiation
  // sums the full service amount → next refund capped to 0, zero Stripe calls.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-union");
    seedPayment("pay-union-ret", "inv-union", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_union_ret" });
    seedPayment("pay-union", "inv-union", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10", refundedAmountCents: 0 });
    // Prior succeeded 9b initiation for the full service amount, webhook not landed (W still 0).
    database.prepare(`
      INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, stripe_refund_id, service_not_rendered_confirmed, created_at, updated_at)
      VALUES ('ri-union-prior', 'pay-union', 20000, 'usd', 'succeeded', 're_union_prior', 1, ?, ?)
    `).run(NOW, NOW);
    const prep = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-union", paymentId: "pay-union", actorType: "admin" }).catch((e: Error) => e);
    // prepare itself refuses because maxRefundable is 0 (Σlocal = 20000 despite W=0)
    assert.ok(prep instanceof Error && /No refundable service balance/.test(prep.message), "§9.4 prepare blocked: Σlocal closes the webhook-lag window");
    assert.equal(callCount(), 0, "§9.4 zero Stripe calls");
    // fresh-ledger re-check at execute: build a pending row directly then execute → still capped
    database.prepare(`
      INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at)
      VALUES ('ri-union-exec', 'pay-union', 20000, 'usd', 'pending', ?, ?)
    `).run(NOW, NOW);
    await assert.rejects(
      () => mod.initiateInvoicePaymentRefund({ invoiceId: "inv-union", paymentId: "pay-union", initiationId: "ri-union-exec", amountCents: 1, confirmAmountCents: 1, reason: "x", serviceNotRenderedConfirmed: true, actorType: "admin" }),
      /exceeds the refundable service balance/,
      "§9.4 fresh-ledger execute re-check also caps to 0",
    );
    assert.equal(callCount(), 0, "§9.4 still zero Stripe calls");
  }

  // ===========================================================================
  // §9.22 External-refund + 9b interleave — dedupe-union blocks the over-refund.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-x", { cardFeePolicy: "client_pays" });
    seedPayment("pay-x-ret", "inv-x", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_x_ret" });
    seedPayment("pay-x", "inv-x", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20590, clientFeeCents: 590, dueDate: "2026-06-10", refundedAmountCents: 5000 });
    // (a) external (non-9b) refund of 5000: a payment_refunds row with NO matching initiation.
    database.prepare(`
      INSERT INTO payment_refunds (id, stripe_refund_id, stripe_payment_intent_id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at)
      VALUES ('pr-x-ext', 're_x_external', 'pi_pay-x', 'pay-x', 5000, 'usd', 'succeeded', ?, ?)
    `).run(NOW, NOW);
    const prepA = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-x", paymentId: "pay-x", actorType: "admin" });
    assert.equal(prepA.maxRefundableCents, 15000, "§9.22(a) max(5000, 0+5000)=5000 → maxRefundable 15000");
    // (b) 9b refund of 15000 succeeds.
    const b = await mod.initiateInvoicePaymentRefund({ invoiceId: "inv-x", paymentId: "pay-x", initiationId: prepA.initiationId, amountCents: 15000, confirmAmountCents: 15000, reason: "cancel", serviceNotRenderedConfirmed: true, actorType: "admin" });
    assert.equal(b.status, "succeeded");
    assert.equal(callCount(), 1, "§9.22(b) one POST for the 15000 refund");
    const re9b = String(riRow(prepA.initiationId)?.stripe_refund_id);
    // (c) webhook lag: W still 5000; Σlocal (submitting+succeeded) = 15000, Σexternal = 5000.
    // dedupe-union = max(5000, 15000+5000)=20000 → maxRefundable 0.
    database.prepare(`
      INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at)
      VALUES ('ri-x-third', 'pay-x', 20000, 'usd', 'pending', ?, ?)
    `).run(NOW, NOW);
    await assert.rejects(
      () => mod.initiateInvoicePaymentRefund({ invoiceId: "inv-x", paymentId: "pay-x", initiationId: "ri-x-third", amountCents: 1, confirmAmountCents: 1, reason: "x", serviceNotRenderedConfirmed: true, actorType: "admin" }),
      /exceeds the refundable service balance/,
      "§9.22(c) further 9b refund REJECTED (dedupe-union caps to 0)",
    );
    assert.equal(callCount(), 1, "§9.22(c) ZERO additional Stripe calls (still just the 15000 one)");
    // The plain max(webhook, Σlocal)=max(5000,15000)=15000 would have returned maxRefundable 5000
    // (the BUG). Prove the dedupe-union differs from plain max on this exact interleave.
    const W = 5000, sigmaLocal = 15000, sigmaExternal = 5000, service = 20000;
    const plainMax = Math.max(service - Math.max(W, sigmaLocal), 0);
    const dedupeUnion = Math.max(service - Math.max(W, sigmaLocal + sigmaExternal), 0);
    assert.equal(plainMax, 5000, "§9.22 plain max would over-permit 5000 (the F1 bug)");
    assert.equal(dedupeUnion, 0, "§9.22 dedupe-union correctly caps to 0");
    // Once the 9b refund's own payment_refunds row lands, it is EXCLUDED from Σexternal (matched
    // on stripe_refund_id) → no double-count.
    database.prepare(`
      INSERT INTO payment_refunds (id, stripe_refund_id, stripe_payment_intent_id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at)
      VALUES ('pr-x-9b', ?, 'pi_pay-x', 'pay-x', 15000, 'usd', 'succeeded', ?, ?)
    `).run(re9b, NOW, NOW);
    // Σexternal still only counts the external 5000 (the 9b row is excluded); union unchanged.
    database.prepare(`
      INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at)
      VALUES ('ri-x-fourth', 'pay-x', 20000, 'usd', 'pending', ?, ?)
    `).run(NOW, NOW);
    await assert.rejects(
      () => mod.initiateInvoicePaymentRefund({ invoiceId: "inv-x", paymentId: "pay-x", initiationId: "ri-x-fourth", amountCents: 1, confirmAmountCents: 1, reason: "x", serviceNotRenderedConfirmed: true, actorType: "admin" }),
      /exceeds the refundable service balance/,
      "§9.22 9b refund not double-counted after its payment_refunds row lands",
    );
  }

  // ===========================================================================
  // §9.5 Dispute block: open rejected; lost && !reinstated rejected; won/reinstated allowed.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-disp");
    seedPayment("pay-disp-ret", "inv-disp", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_disp_ret" });
    seedPayment("pay-disp-open", "inv-disp", { label: "Final balance A", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10", disputeStatus: "open" });
    seedPayment("pay-disp-lost", "inv-disp", { label: "Final balance B", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-11", disputeStatus: "lost", pi: "pi_disp_lost" });
    seedPayment("pay-disp-reinstated", "inv-disp", { label: "Final balance C", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-12", disputeStatus: "reinstated", pi: "pi_disp_reinstated" });

    await assert.rejects(() => mod.prepareInvoicePaymentRefund({ invoiceId: "inv-disp", paymentId: "pay-disp-open", actorType: "admin" }), /open dispute/, "§9.5 open dispute rejected");
    await assert.rejects(() => mod.prepareInvoicePaymentRefund({ invoiceId: "inv-disp", paymentId: "pay-disp-lost", actorType: "admin" }), /lost chargeback/, "§9.5 lost && !reinstated rejected locally");
    const okReinstated = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-disp", paymentId: "pay-disp-reinstated", actorType: "admin" });
    assert.equal(okReinstated.maxRefundableCents, 20000, "§9.5 reinstated dispute is refundable (subject to cap)");
    assert.equal(callCount(), 0, "§9.5 zero Stripe calls on dispute checks");
  }

  // ===========================================================================
  // §9.6 / §9.15 In-flight guard + amount pinning + same-key-different-amount = one refund.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-inflight");
    seedPayment("pay-inflight-ret", "inv-inflight", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_inflight_ret" });
    seedPayment("pay-inflight", "inv-inflight", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10" });
    const prep = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-inflight", paymentId: "pay-inflight", actorType: "admin" });
    // First execute: 12000
    const first = await mod.initiateInvoicePaymentRefund({ invoiceId: "inv-inflight", paymentId: "pay-inflight", initiationId: prep.initiationId, amountCents: 12000, confirmAmountCents: 12000, reason: "cancel", serviceNotRenderedConfirmed: true, actorType: "admin" });
    assert.equal(first.status, "succeeded");
    assert.equal(callCount(), 1, "§9.6 first execute → one call");
    assert.equal(riRow(prep.initiationId)?.amount_cents, 12000, "§9.15 amount PINNED on the row = sent amount");
    assert.equal(new URLSearchParams(stripeCalls[0].body).get("amount"), "12000", "§9.15 Stripe amount = the ROW's persisted amount, not the prepare prefill (20000)");
    // Second execute, SAME id but a DIFFERENT amount → succeeded-guard, ZERO additional calls.
    const second = await mod.initiateInvoicePaymentRefund({ invoiceId: "inv-inflight", paymentId: "pay-inflight", initiationId: prep.initiationId, amountCents: 8000, confirmAmountCents: 8000, reason: "cancel", serviceNotRenderedConfirmed: true, actorType: "admin" });
    assert.equal((second as { alreadyProcessed?: boolean }).alreadyProcessed, true, "§9.6 second execute returns existing result");
    assert.equal(callCount(), 1, "§9.15 same-id different-amount → exactly ONE refund (zero additional calls)");

    // submitting sub-case: a stuck submitting row is NEVER re-POSTed regardless of age.
    database.prepare(`
      INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at)
      VALUES ('ri-stuck', 'pay-inflight', 4000, 'usd', 'submitting', ?, ?)
    `).run(NOW, NOW);
    const stuck = await mod.initiateInvoicePaymentRefund({ invoiceId: "inv-inflight", paymentId: "pay-inflight", initiationId: "ri-stuck", amountCents: 4000, confirmAmountCents: 4000, reason: "cancel", serviceNotRenderedConfirmed: true, actorType: "admin" });
    assert.equal((stuck as { inProgress?: boolean }).inProgress, true, "§9.6 submitting row → in-progress / needs reconciliation, never re-POST");
    assert.equal(callCount(), 1, "§9.6 submitting row makes ZERO Stripe calls");
  }

  // ===========================================================================
  // §9.23 Concurrent double-execute of the SAME initiation → EXACTLY ONE Stripe POST.
  // Regression guard for the CAS-winner detection: the loser's no-op UPDATE matches 0 rows, so a
  // plain status re-read would see 'submitting' for BOTH racers and let the loser POST too. The
  // claim-token disambiguates the winner. The held fetch parks the winner at Stripe so the loser
  // runs its full CAS + re-read while the winner is in flight (the exact race the reviewer found).
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-race");
    seedPayment("pay-race-ret", "inv-race", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_race_ret" });
    seedPayment("pay-race", "inv-race", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10" });
    const prep = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-race", paymentId: "pay-race", actorType: "admin" });

    let release: () => void = () => {};
    stripeHold = new Promise<void>((resolve) => { release = resolve; });
    const args = { invoiceId: "inv-race", paymentId: "pay-race", initiationId: prep.initiationId, amountCents: 15000, confirmAmountCents: 15000, reason: "cancel", serviceNotRenderedConfirmed: true, actorType: "admin" as const };
    const p1 = mod.initiateInvoicePaymentRefund(args).catch((e: Error) => ({ error: e.message }));
    const p2 = mod.initiateInvoicePaymentRefund(args).catch((e: Error) => ({ error: e.message }));
    // Let both racers reach steady state (winner parked at the held POST; loser past its re-read).
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(callCount(), 1, "§9.23 only the CAS winner POSTs — the loser bails at the re-read (never reaches Stripe)");
    release();
    stripeHold = null;
    const [r1, r2] = await Promise.all([p1, p2]);
    const outcomes = [r1, r2];
    assert.equal(outcomes.filter((r) => (r as { status?: string }).status === "succeeded").length, 1, "§9.23 exactly one execute succeeds");
    assert.equal(callCount(), 1, "§9.23 still exactly one Stripe refund after both settle");
    // The winner's re_ id is on the row (not clobbered), and refunded service = 15000 (not 30000).
    const raceRow = riRow(prep.initiationId);
    assert.equal(raceRow?.status, "succeeded", "§9.23 winner row is succeeded");
    assert.ok(typeof raceRow?.stripe_refund_id === "string" && raceRow.stripe_refund_id.length > 0, "§9.23 winner's re_ id persisted");
  }

  // ===========================================================================
  // §9.7 Typed-confirmation mismatch rejected.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-confirm");
    seedPayment("pay-confirm-ret", "inv-confirm", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_confirm_ret" });
    seedPayment("pay-confirm", "inv-confirm", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10" });
    const prep = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-confirm", paymentId: "pay-confirm", actorType: "admin" });
    await assert.rejects(
      () => mod.initiateInvoicePaymentRefund({ invoiceId: "inv-confirm", paymentId: "pay-confirm", initiationId: prep.initiationId, amountCents: 10000, confirmAmountCents: 9999, reason: "cancel", serviceNotRenderedConfirmed: true, actorType: "admin" }),
      /typed confirmation amount does not match/,
      "§9.7 typed-confirm mismatch rejected",
    );
    assert.equal(callCount(), 0, "§9.7 zero Stripe calls");
  }

  // ===========================================================================
  // §9.8 Eligibility: non-paid, null external_payment_id, id mismatch.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-elig");
    seedPayment("pay-elig-ret", "inv-elig", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_elig_ret" });
    seedPayment("pay-unpaid", "inv-elig", { label: "Final balance A", paidAmountCents: 0, grossCollectedCents: 0, status: "pending", dueDate: "2026-06-10", pi: null });
    seedPayment("pay-nopi", "inv-elig", { label: "Final balance B", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-11", pi: null });
    await assert.rejects(() => mod.prepareInvoicePaymentRefund({ invoiceId: "inv-elig", paymentId: "pay-unpaid", actorType: "admin" }), /settled \(paid\)/, "§9.8 non-paid rejected");
    await assert.rejects(() => mod.prepareInvoicePaymentRefund({ invoiceId: "inv-elig", paymentId: "pay-nopi", actorType: "admin" }), /no Stripe charge/, "§9.8 null external_payment_id rejected");
    await assert.rejects(() => mod.prepareInvoicePaymentRefund({ invoiceId: "inv-other", paymentId: "pay-nopi", actorType: "admin" }), /not found/, "§9.8 invoice/payment mismatch rejected");
    assert.equal(callCount(), 0, "§9.8 zero Stripe calls");
  }

  // ===========================================================================
  // §9.16 Retainer refused: both arms (label + earliest); non-retainer allowed; prepare AND execute block.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    // Arm (a): label matches, NOT the earliest.
    seedInvoice("inv-ret");
    seedPayment("pay-ret-first", "inv-ret", { label: "Payment 1", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_ret_first" });
    seedPayment("pay-ret-labeled", "inv-ret", { label: "Deposit top-up", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10", pi: "pi_ret_labeled" });
    await assert.rejects(() => mod.prepareInvoicePaymentRefund({ invoiceId: "inv-ret", paymentId: "pay-ret-labeled", actorType: "admin" }), /retainer is non-refundable/, "§9.16(a) label-match retainer refused at prepare");
    // execute must ALSO block even if a pending row was somehow minted.
    database.prepare(`INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at) VALUES ('ri-ret-a', 'pay-ret-labeled', 20000, 'usd', 'pending', ?, ?)`).run(NOW, NOW);
    await assert.rejects(() => mod.initiateInvoicePaymentRefund({ invoiceId: "inv-ret", paymentId: "pay-ret-labeled", initiationId: "ri-ret-a", amountCents: 20000, confirmAmountCents: 20000, reason: "x", serviceNotRenderedConfirmed: true, actorType: "admin" }), /retainer is non-refundable/, "§9.16(a) label-match retainer refused at execute too");

    // Arm (b): earliest payment, label does NOT match.
    seedInvoice("inv-ret2");
    seedPayment("pay-ret2-earliest", "inv-ret2", { label: "Payment 1", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_ret2_earliest" });
    seedPayment("pay-ret2-late", "inv-ret2", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10", pi: "pi_ret2_late" });
    await assert.rejects(() => mod.prepareInvoicePaymentRefund({ invoiceId: "inv-ret2", paymentId: "pay-ret2-earliest", actorType: "admin" }), /retainer is non-refundable/, "§9.16(b) earliest payment refused even with a non-retainer label");
    // non-retainer, non-earliest → allowed.
    const okLate = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-ret2", paymentId: "pay-ret2-late", actorType: "admin" });
    assert.equal(okLate.maxRefundableCents, 20000, "§9.16 clearly-non-retainer, non-earliest payment allowed");
    assert.equal(callCount(), 0, "§9.16 zero Stripe calls across retainer checks");
  }

  // ===========================================================================
  // §9.17 Missing service-not-rendered affirmation refused; blank reason refused; direct throw.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-affirm");
    seedPayment("pay-affirm-ret", "inv-affirm", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_affirm_ret" });
    seedPayment("pay-affirm", "inv-affirm", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10" });
    const prep = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-affirm", paymentId: "pay-affirm", actorType: "admin" });
    // absent/false affirmation → rejected before network
    await assert.rejects(() => mod.initiateInvoicePaymentRefund({ invoiceId: "inv-affirm", paymentId: "pay-affirm", initiationId: prep.initiationId, amountCents: 20000, confirmAmountCents: 20000, reason: "cancel", serviceNotRenderedConfirmed: false, actorType: "admin" }), /service was not rendered/, "§9.17 missing affirmation refused (server-side)");
    assert.equal(callCount(), 0, "§9.17 zero Stripe calls without affirmation");
    assert.equal(activityCount("invoice.payment_refund_initiation_failed", "pay-affirm"), 1, "§9.17 initiation_failed logged");
    // blank/whitespace reason → rejected
    await assert.rejects(() => mod.initiateInvoicePaymentRefund({ invoiceId: "inv-affirm", paymentId: "pay-affirm", initiationId: prep.initiationId, amountCents: 20000, confirmAmountCents: 20000, reason: "   ", serviceNotRenderedConfirmed: true, actorType: "admin" }), /reason is required/, "§9.17 blank reason refused");
    assert.equal(callCount(), 0, "§9.17 zero Stripe calls with blank reason");
    // happy: both present → stores snr=1 + reason
    const ok = await mod.initiateInvoicePaymentRefund({ invoiceId: "inv-affirm", paymentId: "pay-affirm", initiationId: prep.initiationId, amountCents: 20000, confirmAmountCents: 20000, reason: "service not delivered", serviceNotRenderedConfirmed: true, actorType: "admin" });
    assert.equal(ok.status, "succeeded");
    assert.equal(riRow(prep.initiationId)?.service_not_rendered_confirmed, 1, "§9.17 snr stored on success");
  }

  // ===========================================================================
  // §9.9 Agent/MCP CANNOT initiate.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-agent");
    seedPayment("pay-agent-ret", "inv-agent", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_agent_ret" });
    seedPayment("pay-agent", "inv-agent", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10" });
    database.prepare(`INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at) VALUES ('ri-agent', 'pay-agent', 20000, 'usd', 'pending', ?, ?)`).run(NOW, NOW);
    const before = riCount("pay-agent");
    await assert.rejects(() => mod.initiateInvoicePaymentRefund({ invoiceId: "inv-agent", paymentId: "pay-agent", initiationId: "ri-agent", amountCents: 20000, confirmAmountCents: 20000, reason: "x", serviceNotRenderedConfirmed: true, actorType: "agent" }), /admin-only/, "§9.9 actorType agent throws");
    await assert.rejects(() => mod.prepareInvoicePaymentRefund({ invoiceId: "inv-agent", paymentId: "pay-agent", actorType: "agent" }), /admin-only/, "§9.9 prepare as agent throws");
    assert.equal(callCount(), 0, "§9.9 zero Stripe calls for agent");
    assert.equal(riCount("pay-agent"), before, "§9.9 agent execute writes zero new refund_initiations rows");

    // (a) MCP tools/list exposes no refund-initiation tool.
    const { handleStudioMcpMessage } = await import("./studio-mcp");
    const tools = await handleStudioMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const toolNames = (tools?.result?.tools ?? []).map((t: { name: string }) => t.name);
    assert.ok(!toolNames.some((n: string) => /refund/i.test(n)), "§9.9(a) MCP tools/list has no refund tool");

    // (b) no /api/agent/* route imports the initiation module.
    function walk(dir: string): string[] {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    }
    const agentDir = path.join(process.cwd(), "src/app/api/agent");
    const offenders = walk(agentDir).filter((f) => /\.(ts|tsx)$/.test(f) && fs.readFileSync(f, "utf8").includes("stripe-refund-initiation"));
    assert.equal(offenders.length, 0, "§9.9(b) no /api/agent/* route imports stripe-refund-initiation");
  }

  // ===========================================================================
  // §9.13 Flag off blocks initiation (strict parse + in-helper throw).
  // ===========================================================================
  {
    assert.equal(flags.refundInitiationEnabled({ REFUND_INITIATION_ENABLED: "1" }), true, "§9.13 '1' → ON");
    for (const v of [undefined, "", "0", "true", "on"] as (string | undefined)[]) {
      assert.equal(flags.refundInitiationEnabled({ REFUND_INITIATION_ENABLED: v }), false, `§9.13 '${v}' → OFF (strict === '1')`);
    }
    stripeCalls.length = 0;
    seedInvoice("inv-flag");
    seedPayment("pay-flag-ret", "inv-flag", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_flag_ret" });
    seedPayment("pay-flag", "inv-flag", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10" });
    database.prepare(`INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at) VALUES ('ri-flag', 'pay-flag', 20000, 'usd', 'pending', ?, ?)`).run(NOW, NOW);
    process.env.REFUND_INITIATION_ENABLED = "0";
    await assert.rejects(() => mod.initiateInvoicePaymentRefund({ invoiceId: "inv-flag", paymentId: "pay-flag", initiationId: "ri-flag", amountCents: 20000, confirmAmountCents: 20000, reason: "x", serviceNotRenderedConfirmed: true, actorType: "admin" }), /disabled/, "§9.13 flag off → helper throws before any Stripe call");
    await assert.rejects(() => mod.prepareInvoicePaymentRefund({ invoiceId: "inv-flag", paymentId: "pay-flag", actorType: "admin" }), /disabled/, "§9.13 flag off → prepare throws");
    assert.equal(callCount(), 0, "§9.13 zero Stripe calls while flag off");
    process.env.REFUND_INITIATION_ENABLED = "1";
  }

  // ===========================================================================
  // §9.11 Fail-closed secret: STRIPE_SECRET_KEY unset → throws before any network call.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-secret");
    seedPayment("pay-secret-ret", "inv-secret", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_secret_ret" });
    seedPayment("pay-secret", "inv-secret", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10" });
    const prep = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-secret", paymentId: "pay-secret", actorType: "admin" });
    const savedKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    let thrownMsg = "";
    await assert.rejects(
      () => mod.initiateInvoicePaymentRefund({ invoiceId: "inv-secret", paymentId: "pay-secret", initiationId: prep.initiationId, amountCents: 20000, confirmAmountCents: 20000, reason: "cancel", serviceNotRenderedConfirmed: true, actorType: "admin" }),
      (err: Error) => { thrownMsg = err.message; return /Stripe is not configured/.test(err.message); },
      "§9.11 unset secret → throws",
    );
    assert.equal(callCount(), 0, "§9.11 zero Stripe network calls when the secret is unset");
    assert.ok(!/sk_/.test(thrownMsg), "§9.11 secret never appears in the error");
    process.env.STRIPE_SECRET_KEY = savedKey;
  }

  // ===========================================================================
  // §9.14 Reconciliation tripwires (both), + submitting pins maxRefundable at 0.
  // ===========================================================================
  {
    seedInvoice("inv-recon");
    seedPayment("pay-recon", "inv-recon", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10", pi: "pi_recon" });
    seedPayment("pay-recon-first", "inv-recon", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_recon_first" });
    const oldIso = new Date(Date.parse(NOW) - 26 * 60 * 60 * 1000).toISOString(); // 26h ago
    const stuckIso = new Date(Date.parse(NOW) - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    // (1) succeeded > 24h, no matching payment_refunds row → "not yet recorded"
    database.prepare(`INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, stripe_refund_id, created_at, updated_at) VALUES ('ri-recon-succ', 'pay-recon', 5000, 'usd', 'succeeded', 're_recon_unrecorded', ?, ?)`).run(oldIso, oldIso);
    // (2) submitting > 1h → "stuck in-flight"
    database.prepare(`INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at) VALUES ('ri-recon-stuck', 'pay-recon', 15000, 'usd', 'submitting', ?, ?)`).run(stuckIso, stuckIso);
    const recon = await mod.getRefundInitiationReconciliation({ now: new Date(NOW) });
    assert.ok(recon.initiatedNotRecorded.some((r) => r.initiationId === "ri-recon-succ"), "§9.14(a) succeeded-without-webhook surfaces");
    assert.ok(recon.stuckSubmitting.some((r) => r.initiationId === "ri-recon-stuck"), "§9.14(b) stuck submitting surfaces");
    // the submitting row pins maxRefundable at 0 (Σlocal counts submitting): service 20000, Σlocal = 5000(succ)+15000(submitting) = 20000
    const prepBlocked = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-recon", paymentId: "pay-recon", actorType: "admin" }).catch((e: Error) => e);
    assert.ok(prepBlocked instanceof Error && /No refundable service balance/.test(prepBlocked.message), "§9.14(b) stuck submitting pins maxRefundable at 0");

    // §4.4 context enrichment (Phase 9b UI enable-prep, read-only, additive): the stuck row
    // gets joined invoice/payment display context so the finance view / agent report can link
    // straight to the payment without re-implementing the join at every call site.
    const reconWithContext = await mod.getRefundInitiationReconciliationWithContext({ now: new Date(NOW) });
    const stuckWithContext = reconWithContext.stuckSubmitting.find((r) => r.initiationId === "ri-recon-stuck");
    assert.ok(stuckWithContext, "enriched reconciliation surfaces the stuck row");
    assert.equal(stuckWithContext?.paymentLabel, "Final balance", "enrichment joins the payment label");
    assert.equal(stuckWithContext?.invoiceId, "inv-recon", "enrichment joins the invoice id");
    assert.equal(stuckWithContext?.href, "/invoices/inv-recon#payment-pay-recon", "enrichment builds a direct link");
    const unrecordedWithContext = reconWithContext.initiatedNotRecorded.find((r) => r.initiationId === "ri-recon-succ");
    assert.equal(unrecordedWithContext?.invoiceId, "inv-recon", "enrichment also joins the unrecorded tripwire");
    // Zero-initiations case stays inert (empty arrays, not an error) — proves this is a no-op
    // read while REFUND_INITIATION_ENABLED is off and nobody has ever initiated a refund.
    seedInvoice("inv-recon-empty");
    seedPayment("pay-recon-empty", "inv-recon-empty", { label: "Final balance", paidAmountCents: 10000, grossCollectedCents: 10000, dueDate: "2026-06-10", pi: "pi_recon_empty" });
    const emptyRecon = await mod.getRefundInitiationReconciliationWithContext({ now: new Date(NOW) });
    assert.equal(
      emptyRecon.stuckSubmitting.some((r) => r.invoicePaymentId === "pay-recon-empty"),
      false,
      "a payment with no refund_initiations rows contributes nothing to the reconciliation surface",
    );
  }

  // ===========================================================================
  // UI enable-prep (Phase 9b, read-only, additive) — isRetainerPayment export,
  // isDisputeBlockedForRefundUi, listRefundInitiationsForPayment. These never move money;
  // they exist so the admin refund control can pre-disable a doomed action. The SERVER
  // (resolveEligiblePayment, exercised throughout this file) remains authoritative.
  // ===========================================================================
  {
    seedInvoice("inv-ui");
    seedPayment("pay-ui-retainer", "inv-ui", { label: "Deposit", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_ui_ret" });
    seedPayment("pay-ui-earliest-unlabeled", "inv-ui", { label: "Payment 1", paidAmountCents: 4000, grossCollectedCents: 4000, dueDate: "2026-04-01", pi: "pi_ui_earliest" });
    seedPayment("pay-ui-final", "inv-ui", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10", pi: "pi_ui_final" });
    seedPayment("pay-ui-open-dispute", "inv-ui", { label: "Session fee", paidAmountCents: 8000, grossCollectedCents: 8000, dueDate: "2026-07-01", pi: "pi_ui_dispute", disputeStatus: "open" });
    seedPayment("pay-ui-lost-dispute", "inv-ui", { label: "Print credit", paidAmountCents: 9000, grossCollectedCents: 9000, dueDate: "2026-07-05", pi: "pi_ui_lost", disputeStatus: "lost" });

    const allPayments = database.prepare("SELECT * FROM invoice_payments WHERE invoice_id = 'inv-ui'").all() as Array<{ id: string; label: string; due_date: string | null; created_at: string; dispute_status: string | null }>;
    const asRow = (id: string) => allPayments.find((row) => row.id === id)!;
    const toCamel = (row: ReturnType<typeof asRow>) => ({
      id: row.id,
      label: row.label,
      dueDate: row.due_date,
      createdAt: row.created_at,
      disputeStatus: row.dispute_status,
    }) as unknown as Parameters<typeof mod.isRetainerPayment>[0];
    const allCamel = allPayments.map(toCamel);

    assert.equal(mod.isRetainerPayment(toCamel(asRow("pay-ui-retainer")), allCamel), true, "labeled retainer → retainer (label arm)");
    assert.equal(mod.isRetainerPayment(toCamel(asRow("pay-ui-earliest-unlabeled")), allCamel), true, "earliest unlabeled payment → retainer (earliest arm)");
    assert.equal(mod.isRetainerPayment(toCamel(asRow("pay-ui-final")), allCamel), false, "non-earliest, non-labeled payment → NOT retainer");

    assert.equal(mod.isDisputeBlockedForRefundUi({ disputeStatus: "open" }), true, "open dispute → blocked");
    assert.equal(mod.isDisputeBlockedForRefundUi({ disputeStatus: "lost" }), true, "lost (not reinstated) dispute → blocked");
    assert.equal(mod.isDisputeBlockedForRefundUi({ disputeStatus: "won" }), false, "won dispute → not blocked");
    assert.equal(mod.isDisputeBlockedForRefundUi({ disputeStatus: null }), false, "no dispute → not blocked");

    // listRefundInitiationsForPayment: read-only, newest-first, for the "refund history" display.
    const oldIso = new Date(Date.parse(NOW) - 60 * 60 * 1000).toISOString();
    database.prepare(`INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at) VALUES ('ri-ui-older', 'pay-ui-final', 5000, 'usd', 'failed', ?, ?)`).run(oldIso, oldIso);
    database.prepare(`INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, stripe_refund_id, created_at, updated_at) VALUES ('ri-ui-newer', 'pay-ui-final', 20000, 'usd', 'succeeded', 're_ui_final', ?, ?)`).run(NOW, NOW);
    const history = await mod.listRefundInitiationsForPayment("pay-ui-final");
    assert.deepEqual(history.map((row) => row.id), ["ri-ui-newer", "ri-ui-older"], "listRefundInitiationsForPayment is newest-first");
    assert.equal(history[0]?.status, "succeeded");
    assert.equal(history[0]?.stripeRefundId, "re_ui_final");
    assert.equal(await mod.listRefundInitiationsForPayment("pay-ui-open-dispute").then((rows) => rows.length), 0, "a payment with no initiations returns an empty history");
  }

  // ===========================================================================
  // §9.5b Stripe error surfaced (cleaned) → row failed, initiation_failed logged.
  // ===========================================================================
  {
    stripeCalls.length = 0;
    seedInvoice("inv-err");
    seedPayment("pay-err-ret", "inv-err", { label: "Retainer", paidAmountCents: 5000, grossCollectedCents: 5000, dueDate: "2026-05-01", pi: "pi_err_ret" });
    seedPayment("pay-err", "inv-err", { label: "Final balance", paidAmountCents: 20000, grossCollectedCents: 20000, dueDate: "2026-06-10" });
    const prep = await mod.prepareInvoicePaymentRefund({ invoiceId: "inv-err", paymentId: "pay-err", actorType: "admin" });
    stripeNextError = { status: 400, message: "Charge has already been refunded." };
    await assert.rejects(() => mod.initiateInvoicePaymentRefund({ invoiceId: "inv-err", paymentId: "pay-err", initiationId: prep.initiationId, amountCents: 20000, confirmAmountCents: 20000, reason: "cancel", serviceNotRenderedConfirmed: true, actorType: "admin" }), /already been refunded/, "Stripe error surfaced");
    assert.equal(riRow(prep.initiationId)?.status, "failed", "Stripe error → row failed");
    assert.equal(riRow(prep.initiationId)?.error_message, "Charge has already been refunded.", "cleaned Stripe error stored");
    assert.equal(activityCount("invoice.payment_refund_initiation_failed", "pay-err"), 1, "initiation_failed logged on Stripe error");
  }

  console.log("phase 9b refund initiation tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
