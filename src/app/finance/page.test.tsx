import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-finance-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: FinancePage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-orphan', 'Needs Primary Client Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_amount_cents, created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-FINANCE-FEE', 'partially_paid', 900000, 300000,
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
  database.prepare(`
    INSERT INTO vendors (id, name, normalized_name, created_at, updated_at)
    VALUES ('vendor-1', 'Adobe', 'adobe', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO expenses (
      id, vendor_id, project_id, category, description, amount_cents, status, paid_at,
      payment_method, external_payment_id, tax_deductible, notes, created_at, updated_at
    ) VALUES (
      'expense-1', 'vendor-1', 'project-1', 'software', 'Creative Cloud', 6499, 'paid', '2026-05-20',
      'amex', 'cc_adobe_1', 1, 'Original receipt note.', ?, ?
    ), (
      'expense-unpaid', 'vendor-1', 'project-1', 'contractor', 'Assistant photographer balance', 80000, 'unpaid', '2026-05-25',
      'ach', NULL, 1, 'Pay after final gallery delivery.', ?, ?
    ), (
      'expense-needs-reconciliation', 'vendor-1', 'project-1', 'software', 'Receipt missing charge', 9900, 'paid', '2026-05-26',
      'amex', NULL, 1, 'Needs receipt and card settlement id.', ?, ?
    )
  `).run(now, now, now, now, now, now);

  const markup = renderToStaticMarkup(await FinancePage({
    searchParams: Promise.resolve({ expenseStatus: "all", expenseId: "expense-1" }),
  }));

  assert.match(markup, /Open receivable/);
  assert.match(markup, /Books Summary CSV/);
  assert.match(markup, /href="\/api\/finance\/bookkeeping-summary.csv\?expenseStatus=all"/);
  assert.match(markup, /Accounts payable/);
  assert.match(markup, /Needs reconciliation/);
  assert.match(markup, /<option value="needs_reconciliation">Needs reconciliation<\/option>/);
  assert.match(markup, /Settlement missing/);
  assert.match(markup, /Missing settlement ID/);
  assert.match(markup, /Missing source/);
  assert.match(markup, /\$6,174/);
  assert.match(markup, /\$6,000/);
  assert.match(markup, /\$800/);
  assert.match(markup, /Edit selected expense/);
  assert.match(markup, /name="expenseId" value="expense-1"/);
  assert.match(markup, /name="description" value="Creative Cloud"/);
  assert.match(markup, /Corrected costs update the same canonical ledger row/);
  assert.match(markup, /<option value="project-orphan">Needs Primary Client Wedding<\/option>/);
  assert.match(markup, /href="\/finance\?expenseId=expense-1&amp;status=all&amp;expenseStatus=all#expense-expense-1"/);
  assert.match(markup, />Edit expense</);

  const reconciliationMarkup = renderToStaticMarkup(await FinancePage({
    searchParams: Promise.resolve({ expenseStatus: "needs_reconciliation" }),
  }));
  assert.match(reconciliationMarkup, /Receipt missing charge/);
  assert.match(reconciliationMarkup, /Creative Cloud/);
  assert.match(reconciliationMarkup, /Missing receipt/);
  assert.match(reconciliationMarkup, /Missing source/);
  assert.match(reconciliationMarkup, /Missing settlement ID/);
  assert.match(reconciliationMarkup, /href="\/api\/finance\/expenses.csv\?expenseStatus=needs_reconciliation"/);

  console.log("finance page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
