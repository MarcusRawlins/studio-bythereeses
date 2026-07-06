import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-stripe-refunds-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_studio";
// Default is record_only; individual scenarios toggle enforce for the flip.
delete process.env.FINANCE_REFUND_RECORDING;

function stripeSignature(rawBody: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET ?? "")
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

const NOW = "2026-04-10T12:00:00.000Z";

async function main() {
  const { rawDb, db } = await import("@/db/client");
  const route = await import("@/app/api/stripe/webhook/route");
  const { getPaymentLedgerReport } = await import("./sales");
  const { getBookkeepingReport } = await import("./bookkeeping");
  const { invoicePaymentOpenCents } = await import("./invoice-balances");
  const { createInvoicePaymentCheckoutSession } = await import("./stripe-checkout");
  const database = rawDb();

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('proj-9a', 'Refund Wedding', 'wedding', 'retainer_paid', 'active', ?, ?)
  `).run(NOW, NOW);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-9a', 'Alex', 'Reese', 'alex9a@example.com', ?, ?)
  `).run(NOW, NOW);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('pp-9a', 'proj-9a', 'client-9a', 'primary', 1, ?)
  `).run(NOW);

  function seedPaidPayment(id: string, opts: { gross: number; paid: number; clientFee: number; pi: string; paidAt: string; invoiceNumber: string }) {
    database.prepare(`
      INSERT INTO invoices (id, project_id, invoice_number, status, total_cents, amount_paid_cents, card_fee_policy, card_fee_amount_cents, paid_at, created_at, updated_at)
      VALUES (?, 'proj-9a', ?, 'paid', ?, ?, 'studio_absorbs', 0, ?, ?, ?)
    `).run(`inv-${id}`, opts.invoiceNumber, opts.paid, opts.paid, opts.paidAt, NOW, NOW);
    database.prepare(`
      INSERT INTO invoice_payments (
        id, invoice_id, label, amount_cents, status, paid_at, payment_method,
        paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
        net_deposit_cents, external_payment_id, stripe_checkout_status, created_at, updated_at
      ) VALUES (?, ?, 'Retainer', ?, 'paid', ?, 'stripe', ?, ?, ?, ?, ?, ?, 'paid', ?, ?)
    `).run(
      `pay-${id}`, `inv-${id}`, opts.paid, opts.paidAt, opts.paid, opts.clientFee, opts.clientFee,
      opts.gross, opts.gross - opts.clientFee, opts.pi, NOW, NOW,
    );
  }

  function chargeRefundedEvent(eventId: string, opts: { pi: string; amountRefunded: number; created: number; refunds?: Array<{ id: string; amount: number; status: string }> }) {
    return {
      id: eventId,
      type: "charge.refunded",
      created: opts.created,
      data: { object: {
        id: `ch_${opts.pi}`,
        object: "charge",
        payment_intent: opts.pi,
        amount_refunded: opts.amountRefunded,
        currency: "usd",
        refunds: { object: "list", data: (opts.refunds ?? []).map((r) => ({ id: r.id, amount: r.amount, status: r.status, currency: "usd", payment_intent: opts.pi, charge: `ch_${opts.pi}`, created: opts.created })) },
      } },
    };
  }

  function refundEvent(eventId: string, type: string, opts: { pi: string; refundId: string; amount: number; status: string; created: number; reason?: string }) {
    return {
      id: eventId,
      type,
      created: opts.created,
      data: { object: { id: opts.refundId, object: "refund", payment_intent: opts.pi, charge: `ch_${opts.pi}`, amount: opts.amount, currency: "usd", status: opts.status, reason: opts.reason ?? null, created: opts.created } },
    };
  }

  function disputeEvent(eventId: string, type: string, opts: { pi: string; disputeId: string; amount: number; status: string; created: number }) {
    return {
      id: eventId,
      type,
      created: opts.created,
      data: { object: { id: opts.disputeId, object: "dispute", payment_intent: opts.pi, charge: `ch_${opts.pi}`, amount: opts.amount, currency: "usd", status: opts.status, reason: "fraudulent", created: opts.created } },
    };
  }

  async function postEvent(event: unknown, options: { badSignature?: boolean } = {}) {
    const rawBody = JSON.stringify(event);
    const original = console.error;
    console.error = () => {};
    try {
      return await route.POST(new Request("https://studio.bythereeses.com/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": options.badSignature ? "t=1,v1=bad" : stripeSignature(rawBody) },
        body: rawBody,
      }));
    } finally {
      console.error = original;
    }
  }

  // ---- Test 1: signature ---------------------------------------------------
  seedPaidPayment("sig", { gross: 30000, paid: 30000, clientFee: 0, pi: "pi_sig", paidAt: "2026-04-05T10:00:00.000Z", invoiceNumber: "INV-SIG" });
  const badSig = await postEvent(chargeRefundedEvent("evt_sig", { pi: "pi_sig", amountRefunded: 5000, created: 1775000000, refunds: [{ id: "re_sig", amount: 5000, status: "succeeded" }] }), { badSignature: true });
  assert.equal(badSig.status, 400, "bad signature → 400");
  assert.equal(database.prepare("SELECT COUNT(*) FROM payment_refunds WHERE stripe_refund_id = 're_sig'").pluck().get(), 0, "bad signature records nothing");
  const goodSig = await postEvent(chargeRefundedEvent("evt_sig", { pi: "pi_sig", amountRefunded: 5000, created: 1775000000, refunds: [{ id: "re_sig", amount: 5000, status: "succeeded" }] }));
  assert.equal(goodSig.status, 200, "valid signature → 200");
  assert.equal(database.prepare("SELECT refunded_amount_cents FROM invoice_payments WHERE id = 'pay-sig'").pluck().get(), 5000, "partial refund sets summary");

  // ---- Test 6 (part): missing event id rejected → 400 ----------------------
  const noId = await postEvent({ type: "charge.refunded", created: 1775000000, data: { object: { id: "ch_x", payment_intent: "pi_sig", amount_refunded: 1 } } });
  assert.equal(noId.status, 400, "missing event.id → 400 (never silent-drop)");

  // ---- Test 2: refund recording + partial vs full flip (enforce) -----------
  seedPaidPayment("full", { gross: 30000, paid: 30000, clientFee: 0, pi: "pi_full", paidAt: "2026-04-06T10:00:00.000Z", invoiceNumber: "INV-FULL" });
  // record_only (default): full refund records summary but does NOT flip status.
  await postEvent(chargeRefundedEvent("evt_full_ro", { pi: "pi_full", amountRefunded: 30000, created: 1775100000, refunds: [{ id: "re_full", amount: 30000, status: "succeeded" }] }));
  assert.equal(database.prepare("SELECT status FROM invoice_payments WHERE id = 'pay-full'").pluck().get(), "paid", "record_only does NOT flip status");
  assert.equal(database.prepare("SELECT refunded_amount_cents FROM invoice_payments WHERE id = 'pay-full'").pluck().get(), 30000, "record_only still records summary");
  assert.equal(database.prepare("SELECT COUNT(*) FROM payment_refunds WHERE stripe_refund_id = 're_full'").pluck().get(), 1, "charge.refunded writes embedded child refund");

  // enforce: a NEW full-refund event now flips status to refunded + recomputes invoice.
  process.env.FINANCE_REFUND_RECORDING = "enforce";
  await postEvent(chargeRefundedEvent("evt_full_enf", { pi: "pi_full", amountRefunded: 30000, created: 1775100001, refunds: [{ id: "re_full", amount: 30000, status: "succeeded" }] }));
  assert.equal(database.prepare("SELECT status FROM invoice_payments WHERE id = 'pay-full'").pluck().get(), "refunded", "enforce flips full refund to refunded");
  // Preserved fields (only status changed).
  assert.deepEqual(database.prepare("SELECT paid_amount_cents, gross_collected_cents, net_deposit_cents, paid_at FROM invoice_payments WHERE id = 'pay-full'").get(), {
    paid_amount_cents: 30000, gross_collected_cents: 30000, net_deposit_cents: 30000, paid_at: "2026-04-06T10:00:00.000Z",
  });
  // Invoice recomputed: refunded payment contributes 0 → amount_paid 0, not resurrected to a paid/partially_paid state.
  const invFull = database.prepare("SELECT status, amount_paid_cents FROM invoices WHERE id = 'inv-full'").get() as { status: string; amount_paid_cents: number };
  assert.equal(invFull.amount_paid_cents, 0, "refunded payment contributes 0 to amountPaid");
  assert.ok(["sent", "draft"].includes(invFull.status), "fully-refunded invoice not resurrected to paid/partially_paid");
  process.env.FINANCE_REFUND_RECORDING = "";

  // Refunded reads as settled: openCents 0, no fresh checkout mint.
  const payFullRow = database.prepare("SELECT * FROM invoice_payments WHERE id = 'pay-full'").get() as Record<string, unknown>;
  assert.equal(invoicePaymentOpenCents({ status: "refunded", amount_cents: 30000, paid_amount_cents: 30000 }), 0, "refunded → invoicePaymentOpenCents 0");
  await assert.rejects(
    () => createInvoicePaymentCheckoutSession("inv-full", "pay-full"),
    /Checkout can only be created for an open invoice payment/,
    "no fresh checkout link for a refunded payment",
  );
  assert.ok(payFullRow); // silence unused

  // ---- Test 3: idempotency (convergence) -----------------------------------
  seedPaidPayment("idem", { gross: 30000, paid: 30000, clientFee: 0, pi: "pi_idem", paidAt: "2026-04-07T10:00:00.000Z", invoiceNumber: "INV-IDEM" });
  const first = await postEvent(chargeRefundedEvent("evt_idem", { pi: "pi_idem", amountRefunded: 4000, created: 1775200000, refunds: [{ id: "re_idem", amount: 4000, status: "succeeded" }] }));
  const firstBody = await first.json();
  assert.equal(firstBody.result.recorded, true);
  const replay = await postEvent(chargeRefundedEvent("evt_idem", { pi: "pi_idem", amountRefunded: 4000, created: 1775200000, refunds: [{ id: "re_idem", amount: 4000, status: "succeeded" }] }));
  const replayBody = await replay.json();
  assert.equal(replayBody.result.reason, "duplicate_event", "replayed event.id → duplicate_event");
  assert.equal(database.prepare("SELECT COUNT(*) FROM payment_refunds WHERE stripe_refund_id = 're_idem'").pluck().get(), 1, "one refund row after replay (convergence)");
  assert.equal(database.prepare("SELECT refunded_amount_cents FROM invoice_payments WHERE id = 'pay-idem'").pluck().get(), 4000, "set-to-authoritative, not incremented");

  // Convergence holds even WITHOUT the dedupe row: delete it, reprocess a distinct-but-equivalent
  // event id, assert still one refund row with the same amount (UNIQUE + set-to-authoritative).
  database.prepare("DELETE FROM stripe_webhook_events WHERE event_id = 'evt_idem'").run();
  await postEvent(chargeRefundedEvent("evt_idem_2", { pi: "pi_idem", amountRefunded: 4000, created: 1775200000, refunds: [{ id: "re_idem", amount: 4000, status: "succeeded" }] }));
  assert.equal(database.prepare("SELECT COUNT(*) FROM payment_refunds WHERE stripe_refund_id = 're_idem'").pluck().get(), 1, "still one refund row without dedupe (primary safety)");
  assert.equal(database.prepare("SELECT refunded_amount_cents FROM invoice_payments WHERE id = 'pay-idem'").pluck().get(), 4000, "amount unchanged");

  // dispute replay → one dispute row
  await postEvent(disputeEvent("evt_dispute_idem", "charge.dispute.created", { pi: "pi_idem", disputeId: "dp_idem", amount: 5000, status: "needs_response", created: 1775200500 }));
  await postEvent(disputeEvent("evt_dispute_idem", "charge.dispute.created", { pi: "pi_idem", disputeId: "dp_idem", amount: 5000, status: "needs_response", created: 1775200500 }));
  assert.equal(database.prepare("SELECT COUNT(*) FROM payment_disputes WHERE stripe_dispute_id = 'dp_idem'").pluck().get(), 1, "one dispute row after replay");

  // ---- Test 4: retry-safety without a transaction --------------------------
  seedPaidPayment("retry", { gross: 30000, paid: 30000, clientFee: 0, pi: "pi_retry", paidAt: "2026-04-08T10:00:00.000Z", invoiceNumber: "INV-RETRY" });
  const schema = await import("@/db/schema");
  const dbRecord = db as unknown as Record<string, unknown>;
  const originalInsert = dbRecord.insert as (...args: unknown[]) => unknown;
  let armed = true;
  dbRecord.insert = (...args: unknown[]) => {
    if (armed && args[0] === schema.paymentRefunds) {
      armed = false;
      throw new Error("forced mid-write failure");
    }
    return originalInsert.apply(db, args);
  };
  const faulted = await postEvent(chargeRefundedEvent("evt_retry", { pi: "pi_retry", amountRefunded: 6000, created: 1775300000, refunds: [{ id: "re_retry", amount: 6000, status: "succeeded" }] }));
  dbRecord.insert = originalInsert;
  assert.equal(faulted.status, 400, "mid-write throw → non-2xx so Stripe retries");
  assert.equal(database.prepare("SELECT COUNT(*) FROM stripe_webhook_events WHERE event_id = 'evt_retry'").pluck().get(), 0, "no dedupe row after a mid-write throw (written LAST)");
  // Successful replay converges to exactly one refund row.
  await postEvent(chargeRefundedEvent("evt_retry", { pi: "pi_retry", amountRefunded: 6000, created: 1775300000, refunds: [{ id: "re_retry", amount: 6000, status: "succeeded" }] }));
  assert.equal(database.prepare("SELECT COUNT(*) FROM payment_refunds WHERE stripe_refund_id = 're_retry'").pluck().get(), 1, "replay produces exactly one refund row, not two");

  // ---- Test 4b: cross-period gross immutability ----------------------------
  // pay-full was paid 2026-04-06 ($300) and fully refunded via events created in April
  // above (evt_full_* created 1775100000 ≈ 2026-03-31). To isolate periods cleanly, use a
  // dedicated payment paid in April, refunded (succeeded) with created_at in May.
  // Use clean Aug/Sep windows no other scenario touches (shared DB).
  seedPaidPayment("period", { gross: 30000, paid: 30000, clientFee: 0, pi: "pi_period", paidAt: "2026-08-15T10:00:00.000Z", invoiceNumber: "INV-PERIOD" });
  const sepEpoch = Math.floor(Date.parse("2026-09-20T10:00:00.000Z") / 1000);
  process.env.FINANCE_REFUND_RECORDING = "enforce";
  await postEvent(chargeRefundedEvent("evt_period", { pi: "pi_period", amountRefunded: 30000, created: sepEpoch, refunds: [{ id: "re_period", amount: 30000, status: "succeeded" }] }));
  process.env.FINANCE_REFUND_RECORDING = "";
  const augReport = await getBookkeepingReport({ status: "paid", fromDate: "2026-08-01", toDate: "2026-08-31" });
  // Gross revenue for P1 (Aug) is UNCHANGED by the later refund (paidAt-scoped; refunded settled).
  assert.equal(augReport.totals.revenueCents, 30000, "P1 gross revenue unchanged by a P2 refund (immutable)");
  assert.equal(augReport.totals.refundedCents, 0, "no refund subtracted in P1 (money-event date is P2)");
  assert.equal(augReport.totals.netRevenueCents, 30000, "P1 net revenue is the full gross (refund not yet)");
  const sepReport = await getBookkeepingReport({ status: "paid", fromDate: "2026-09-01", toDate: "2026-09-30" });
  assert.equal(sepReport.totals.refundedCents, 30000, "refund subtracted in P2 (its money-event month)");
  assert.equal(sepReport.totals.netRevenueCents, -30000, "P2 net revenue reduced by the refund only");
  // Net across P1+P2 nets to $0 (gross==service, no fee), not −$30000.
  assert.equal(augReport.totals.netRevenueCents + sepReport.totals.netRevenueCents, 0, "net across both periods nets refunded dollars to zero");

  // ---- Test 4c: payment-ledger surface period attribution (Fable rev-3 #1) -----
  // pay-period is now "refunded" (flipped in enforce above). Its gross must stay
  // attributed to its collection month (Aug = paidAt) on the payment-ledger surface too,
  // NOT re-attributed to dueDate/createdAt. Pre-fix, paymentLedgerDate fell back past the
  // null paidAt-guard to createdAt (≈now), dropping the row out of the Aug window and
  // silently moving Aug gross — disagreeing with the (correct) bookkeeping report above.
  assert.equal(
    database.prepare("SELECT status FROM invoice_payments WHERE id = 'pay-period'").pluck().get(),
    "refunded",
    "pay-period is refunded after the enforce flip (precondition for 4c)",
  );
  const augLedger = await getPaymentLedgerReport({ fromDate: "2026-08-01", toDate: "2026-08-31" });
  assert.ok(
    augLedger.rows.some((row) => row.sourceId === "pay-period" && row.payment.status === "refunded"),
    "refunded payment stays attributed to its collection month (paidAt) on the ledger surface",
  );

  // ---- Test 5: dispute lifecycle ------------------------------------------
  seedPaidPayment("disp", { gross: 30000, paid: 30000, clientFee: 0, pi: "pi_disp", paidAt: "2026-04-09T10:00:00.000Z", invoiceNumber: "INV-DISP" });
  await postEvent(disputeEvent("evt_disp_open", "charge.dispute.created", { pi: "pi_disp", disputeId: "dp_disp", amount: 30000, status: "needs_response", created: 1775400000 }));
  assert.equal(database.prepare("SELECT dispute_status FROM invoice_payments WHERE id = 'pay-disp'").pluck().get(), "open", "dispute created → open");
  assert.equal(database.prepare("SELECT status FROM invoice_payments WHERE id = 'pay-disp'").pluck().get(), "paid", "open dispute does NOT flip payment status");
  // lost
  await postEvent(disputeEvent("evt_disp_lost", "charge.dispute.closed", { pi: "pi_disp", disputeId: "dp_disp", amount: 30000, status: "lost", created: 1775400100 }));
  assert.equal(database.prepare("SELECT dispute_status FROM invoice_payments WHERE id = 'pay-disp'").pluck().get(), "lost", "closed lost → lost");
  // reinstated
  await postEvent(disputeEvent("evt_disp_reinstated", "charge.dispute.funds_reinstated", { pi: "pi_disp", disputeId: "dp_disp", amount: 30000, status: "won", created: 1775400200 }));
  assert.equal(database.prepare("SELECT dispute_status FROM invoice_payments WHERE id = 'pay-disp'").pluck().get(), "reinstated", "funds reinstated → reinstated");
  assert.equal(database.prepare("SELECT funds_reinstated FROM payment_disputes WHERE stripe_dispute_id = 'dp_disp'").pluck().get(), 1, "funds_reinstated latched");

  // Monotonic: a reordered non-terminal 'updated' must NOT demote reinstated back to open.
  await postEvent(disputeEvent("evt_disp_late", "charge.dispute.updated", { pi: "pi_disp", disputeId: "dp_disp", amount: 30000, status: "under_review", created: 1775400050 }));
  assert.equal(database.prepare("SELECT dispute_status FROM invoice_payments WHERE id = 'pay-disp'").pluck().get(), "reinstated", "reordered older update does not demote the resolved summary");

  // ---- Test 6: over-cap clamp/flag + hostile strings + orphan --------------
  seedPaidPayment("cap", { gross: 30000, paid: 30000, clientFee: 0, pi: "pi_cap", paidAt: "2026-04-11T10:00:00.000Z", invoiceNumber: "INV-CAP" });
  await postEvent(chargeRefundedEvent("evt_cap", { pi: "pi_cap", amountRefunded: 50000, created: 1775500000, refunds: [{ id: "re_cap", amount: 50000, status: "succeeded" }] }));
  assert.equal(database.prepare("SELECT refunded_amount_cents FROM invoice_payments WHERE id = 'pay-cap'").pluck().get(), 30000, "summary clamped to gross");
  assert.equal(database.prepare("SELECT amount_cents FROM payment_refunds WHERE stripe_refund_id = 're_cap'").pluck().get(), 50000, "child preserves true amount (for over-cap flag)");
  // hostile long reason capped
  const longReason = "x".repeat(2000);
  await postEvent(refundEvent("evt_hostile", "refund.updated", { pi: "pi_cap", refundId: "re_cap", amount: 50000, status: "succeeded", created: 1775500001, reason: longReason }));
  const storedReason = database.prepare("SELECT reason FROM payment_refunds WHERE stripe_refund_id = 're_cap'").pluck().get() as string | null;
  assert.ok((storedReason?.length ?? 0) <= 500, "hostile long reason capped");
  // orphan refund (no matching pi) recorded with null link
  await postEvent(refundEvent("evt_orphan", "refund.created", { pi: "pi_nomatch", refundId: "re_orphan", amount: 999999999999, status: "succeeded", created: 1775500002 }));
  const orphan = database.prepare("SELECT invoice_payment_id, amount_cents FROM payment_refunds WHERE stripe_refund_id = 're_orphan'").get() as { invoice_payment_id: string | null; amount_cents: number };
  assert.equal(orphan.invoice_payment_id, null, "orphan refund recorded with null link (never dropped)");
  assert.ok(orphan.amount_cents <= 100_000_000, "orphan amount clamped to absolute ceiling");

  // ---- Test 7: reconciliation surfacing -----------------------------------
  const recon = await getPaymentLedgerReport({ status: "needs_reconciliation" });
  const capRow = recon.rows.find((row) => row.payment.id === "pay-cap");
  assert.ok(capRow, "over-cap refunded row appears in needs_reconciliation (refunded rows not filtered out)");
  const dispRecon = await getPaymentLedgerReport({ status: "needs_reconciliation" });
  // open dispute would be flagged; our dp_disp is reinstated now, so use a fresh open one.
  seedPaidPayment("odisp", { gross: 30000, paid: 30000, clientFee: 0, pi: "pi_odisp", paidAt: "2026-04-12T10:00:00.000Z", invoiceNumber: "INV-ODISP" });
  await postEvent(disputeEvent("evt_odisp", "charge.dispute.created", { pi: "pi_odisp", disputeId: "dp_odisp", amount: 30000, status: "needs_response", created: 1775600000 }));
  const recon2 = await getPaymentLedgerReport({ status: "needs_reconciliation" });
  assert.ok(recon2.rows.find((row) => row.payment.id === "pay-odisp"), "open dispute surfaces in needs_reconciliation");
  assert.ok(dispRecon.rows.length >= 0);
  // orphaned events surface in their own section
  assert.ok(recon2.unlinkedMoneyEvents.some((event) => event.stripeId === "re_orphan"), "orphaned refund surfaced in unlinked money events");
  // AR aging still excludes refunded
  const full = await getPaymentLedgerReport({});
  assert.ok(!full.aging.rows.some((row) => row.status === "refunded"), "AR aging excludes refunded rows");

  console.log("stripe refunds/disputes recording tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
