import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-bookkeeping-summary-csv-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents, created_at, updated_at
    ) VALUES ('invoice-1', 'project-1', 'INV-BOOKS', 'paid', 500000, 500000, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, status, paid_at, paid_amount_cents,
      client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents,
      created_at, updated_at
    ) VALUES (
      'payment-1', 'invoice-1', 'Retainer', 500000, 'paid', '2026-05-12T10:00:00.000Z',
      500000, 14550, 14550, 514550, 500000, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO vendors (id, name, normalized_name, created_at, updated_at)
    VALUES ('vendor-1', 'Canon Professional Services', 'canon professional services', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO expenses (
      id, vendor_id, project_id, category, description, amount_cents, status, paid_at,
      payment_method, external_payment_id, tax_deductible, notes, created_at, updated_at
    ) VALUES (
      'expense-1', 'vendor-1', 'project-1', 'equipment', 'Lens rental',
      12500, 'paid', '2026-05-20', 'amex', 'ch_expense_route_1',
      1, 'Imported from receipt OCR.', ?, ?
    )
  `).run(now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blocked = await route.GET(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/finance/bookkeeping-summary.csv?expenseStatus=paid"));
  assert.equal(blocked.status, 404);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/finance/bookkeeping-summary.csv?expenseStatus=paid&fromDate=2026-05-01&toDate=2026-05-31", {
    headers: { "x-reese-origin-secret": "origin-secret" },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(response.headers.get("content-disposition") ?? "", /the-reeses-studio-bookkeeping-summary-\d{4}-\d{2}-\d{2}\.csv/);
  const csv = await response.text();
  assert.match(csv, /^Section,Name,Count,Amount,Tax Deductible Amount,Notes/m);
  assert.match(csv, /Totals,Service revenue,,5000.00,,Paid invoice and scheduler service revenue/);
  assert.match(csv, /Totals,Net deposits,,5000.00,,Cash after processor fees/);
  assert.match(csv, /Totals,Paid expenses,,125.00,,Paid expenses in the selected expense status view/);
  assert.match(csv, /Expense category,equipment,1,125.00,125.00,/);
  assert.match(csv, /Vendor,Canon Professional Services,1,125.00,125.00,/);

  console.log("bookkeeping summary csv route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
