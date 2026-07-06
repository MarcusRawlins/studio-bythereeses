import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Locks the blocked finance `*FromAgent` functions (Phase 6 Section 6 /
// docs/specs/phase-6-hardening-r2.md) to their guard-only behavior: each of
// the 6 functions below must reject with its exact Tyler-approval message and
// must never reach a db write. `studio-mcp.test.ts` already asserts the same
// rejection messages through the MCP tool layer, and `agent-invoice.test.ts` /
// `agent-payment.test.ts` / `scheduler-payment.test.ts` already assert
// unchanged rows via a real sqlite db. This test adds the missing piece: a
// db-level write spy so a future accidental un-guarding (e.g. making the
// guard conditional, or reordering statements so code runs before the throw)
// fails immediately even if nobody remembers to update row-state assertions.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-finance-guard-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

type DbWriteMethod = "insert" | "update" | "delete";
const WRITE_METHODS: DbWriteMethod[] = ["insert", "update", "delete"];

function spyOnDbWrites(database: Record<string, unknown>) {
  const calls: Record<DbWriteMethod, number> = { insert: 0, update: 0, delete: 0 };
  const originals = new Map<DbWriteMethod, (...args: unknown[]) => unknown>();

  for (const method of WRITE_METHODS) {
    const original = (database[method] as (...args: unknown[]) => unknown).bind(database);
    originals.set(method, original);
    database[method] = (...args: unknown[]) => {
      calls[method] += 1;
      return original(...args);
    };
  }

  return {
    totalWrites: () => calls.insert + calls.update + calls.delete,
    restore: () => {
      for (const method of WRITE_METHODS) {
        database[method] = originals.get(method);
      }
    },
  };
}

async function main() {
  const { db, rawDb } = await import("@/db/client");
  const {
    createInvoiceFromAgent,
    updateInvoiceFromAgent,
    recordInvoicePaymentFromAgent,
    updateInvoicePaymentFromAgent,
  } = await import("./sales");
  const {
    recordSchedulerBookingPaymentFromAgent,
    updateSchedulerBookingPaymentFromAgent,
  } = await import("./scheduler");

  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-finance-guard-1', 'Finance Guard Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_amount_cents, created_at, updated_at
    ) VALUES (
      'invoice-finance-guard-1', 'project-finance-guard-1', 'INV-FINANCE-GUARD', 'draft', 500000, 0,
      'client_pays', 14500, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
    VALUES ('payment-finance-guard-1', 'invoice-finance-guard-1', 'Retainer', 150000, '2026-06-01', 'pending', ?, ?)
  `).run(now, now);

  const spy = spyOnDbWrites(db as unknown as Record<string, unknown>);

  try {
    await assert.rejects(
      () => createInvoiceFromAgent("project-finance-guard-1", { totalCents: 500000 }),
      /Invoices and payment schedules require Tyler approval before creation or changes\. Agents may draft invoice recommendations as tasks, but cannot create invoices directly\./,
    );
    await assert.rejects(
      () => updateInvoiceFromAgent("project-finance-guard-1", "invoice-finance-guard-1", { totalCents: 600000 }),
      /Invoices and payment schedules require Tyler approval before creation or changes\. Agents may draft invoice recommendations as tasks, but cannot update invoices directly\./,
    );
    await assert.rejects(
      () => recordInvoicePaymentFromAgent("invoice-finance-guard-1", { paymentId: "payment-finance-guard-1", status: "paid" }),
      /Payments require Tyler approval before creation or changes\. Agents may draft payment reconciliation recommendations as tasks, but cannot record payments directly\./,
    );
    await assert.rejects(
      () => updateInvoicePaymentFromAgent("invoice-finance-guard-1", { paymentId: "payment-finance-guard-1", status: "paid" }),
      /Payments require Tyler approval before creation or changes\. Agents may draft payment reconciliation recommendations as tasks, but cannot update payments directly\./,
    );
    await assert.rejects(
      () => recordSchedulerBookingPaymentFromAgent("booking-finance-guard-1", { status: "paid", paidAmountCents: 10000 }),
      /Payments require Tyler approval before creation or changes\. Agents may draft payment reconciliation recommendations as tasks, but cannot record scheduler payments directly\./,
    );
    await assert.rejects(
      () => updateSchedulerBookingPaymentFromAgent("booking-finance-guard-1", { status: "paid", paidAmountCents: 10000 }),
      /Payments require Tyler approval before creation or changes\. Agents may draft payment reconciliation recommendations as tasks, but cannot update scheduler payments directly\./,
    );

    assert.equal(
      spy.totalWrites(),
      0,
      "blocked *FromAgent finance functions must reject before any db insert/update/delete",
    );
  } finally {
    spy.restore();
  }

  // Belt-and-suspenders: confirm the seeded rows genuinely never moved, using
  // the same real-sqlite-row-state style as the existing agent finance tests.
  assert.deepEqual(database.prepare(`
    SELECT total_cents, status FROM invoices WHERE id = 'invoice-finance-guard-1'
  `).get(), { total_cents: 500000, status: "draft" });
  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count FROM invoices WHERE invoice_number != 'INV-FINANCE-GUARD'
  `).get(), { count: 0 });
  assert.deepEqual(database.prepare(`
    SELECT status, paid_amount_cents FROM invoice_payments WHERE id = 'payment-finance-guard-1'
  `).get(), { status: "pending", paid_amount_cents: 0 });

  // Phase 9a — NO agent-callable path may write the new finance-adjacent surfaces:
  // payment_refunds / payment_disputes / mileage_logs / the new invoice_payments summary
  // columns / vendors W-9 columns. The recording of refunds/disputes is system-from-webhook
  // ONLY (src/lib/stripe-refunds.ts) — there is no agent entry point. Assert the spy caught
  // zero writes during the hostile agent calls AND the new tables/columns stay pristine.
  assert.equal(database.prepare("SELECT COUNT(*) FROM payment_refunds").pluck().get(), 0, "no agent path writes payment_refunds");
  assert.equal(database.prepare("SELECT COUNT(*) FROM payment_disputes").pluck().get(), 0, "no agent path writes payment_disputes");
  assert.equal(database.prepare("SELECT COUNT(*) FROM mileage_logs").pluck().get(), 0, "no agent path writes mileage_logs");
  assert.equal(database.prepare("SELECT COUNT(*) FROM stripe_webhook_events").pluck().get(), 0, "no agent path writes stripe_webhook_events");
  assert.deepEqual(database.prepare(`
    SELECT refunded_amount_cents, dispute_status, disputed_amount_cents, last_refund_at
    FROM invoice_payments WHERE id = 'payment-finance-guard-1'
  `).get(), { refunded_amount_cents: 0, dispute_status: null, disputed_amount_cents: 0, last_refund_at: null });
  assert.equal(
    database.prepare("SELECT COUNT(*) FROM vendors WHERE tax_id_last4 IS NOT NULL OR is_1099_tracked = 1 OR legal_name IS NOT NULL OR tax_address IS NOT NULL").pluck().get(),
    0,
    "no agent path writes vendor W-9 tax columns",
  );

  // Also assert the exported studio-mcp agent surface does not re-export any refund/dispute
  // or W-9/mileage WRITE function (recording is system-from-webhook only; agents read via
  // the finance report). getAgentFinanceReport (read) is allowed; write helpers are not.
  const stripeRefunds = await import("./stripe-refunds");
  for (const name of ["recordStripeChargeRefunded", "recordStripeRefund", "recordStripeDispute", "dispatchStripeRefundOrDisputeEvent"]) {
    assert.ok(typeof (stripeRefunds as Record<string, unknown>)[name] === "function", `${name} exists as a system-only recorder`);
  }
  const mcp = await import("./studio-mcp");
  for (const name of Object.keys(mcp)) {
    assert.ok(
      !/refund|dispute|mileage|w9|taxId|updateVendorTax/i.test(name),
      `studio-mcp must not export a refund/dispute/mileage/W-9 write surface (found ${name})`,
    );
  }

  console.log("agent finance guard tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
