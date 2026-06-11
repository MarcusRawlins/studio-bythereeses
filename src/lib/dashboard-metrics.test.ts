import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-dashboard-metrics-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getDashboardMetrics } = await import("./dashboard");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-active-inquiry', 'Active Inquiry', 'wedding', 'inquiry', 'active', ?, ?),
      ('project-archived-inquiry', 'Archived Inquiry', 'wedding', 'inquiry', 'archived', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_amount_cents, created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-DASH-FEE', 'partially_paid', 900000, 300000,
      'client_pays', 26130, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-1', 'invoice-1', 'Retainer', 300000, '2026-06-01', 'paid',
      '2026-06-02T10:00:00.000Z', 'stripe',
      300000, 8730, 8730, 308730,
      300000, ?, ?
    ), (
      'payment-2', 'invoice-1', 'Final payment', 600000, '2026-08-19', 'pending',
      NULL, NULL,
      0, 0, 0, 0,
      0, ?, ?
    )
  `).run(now, now, now, now);

  const metrics = await getDashboardMetrics(new Date("2026-05-31T12:00:00.000Z"));
  assert.equal(metrics.inquiriesThisMonth, 1);
  assert.equal(metrics.outstandingPaymentCents, 600000);
  assert.equal(metrics.clientPayableOutstandingPaymentCents, 617400);

  console.log("dashboard metrics tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
