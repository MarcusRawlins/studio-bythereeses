import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-payment-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { recordInvoicePaymentFromAgent, updateInvoicePaymentFromAgent } = await import("./sales");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Payment Wedding', 'wedding', 'proposal_sent', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_amount_cents, created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-PAY', 'sent', 100000, 0,
      'client_pays', 2930, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
    VALUES ('payment-1', 'invoice-1', 'Retainer', 30000, '2026-06-01', 'pending', ?, ?)
  `).run(now, now);

  await assert.rejects(
    () => recordInvoicePaymentFromAgent("invoice-1", {
      paymentId: "payment-1",
      status: "paid",
      paymentMethod: "stripe",
      paidAmountCents: 30000,
      paidAt: "2026-06-02T10:00:00.000Z",
    }),
    /Payments require Tyler approval/,
  );
  await assert.rejects(
    () => updateInvoicePaymentFromAgent("invoice-1", {
      paymentId: "payment-1",
      status: "paid",
      paidAmountCents: 29000,
    }),
    /Payments require Tyler approval/,
  );

  assert.deepEqual(database.prepare(`
    SELECT status, paid_amount_cents, paid_at
    FROM invoice_payments
    WHERE id = 'payment-1'
  `).get(), {
    status: "pending",
    paid_amount_cents: 0,
    paid_at: null,
  });
  assert.deepEqual(database.prepare(`
    SELECT amount_paid_cents, status
    FROM invoices
    WHERE id = 'invoice-1'
  `).get(), {
    amount_paid_cents: 0,
    status: "sent",
  });

  console.log("agent payment tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
