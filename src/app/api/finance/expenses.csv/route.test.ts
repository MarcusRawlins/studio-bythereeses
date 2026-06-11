import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-expenses-csv-route-"));
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
    INSERT INTO project_sources (
      id, project_id, kind, title, body, source_type, source_id, created_at, updated_at
    ) VALUES (
      'source-expense-1', 'project-1', 'receipt', 'Lens rental receipt',
      'OCR text for the lens rental receipt.', 'receipt_upload', 'receipt-route-1', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO vendors (id, name, normalized_name, created_at, updated_at)
    VALUES ('vendor-1', 'Canon Professional Services', 'canon professional services', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO expenses (
      id, vendor_id, project_id, category, description, amount_cents, status, paid_at,
      payment_method, external_payment_id, receipt_url, tax_deductible, notes,
      source_type, source_id, created_at, updated_at
    ) VALUES (
      'expense-1', 'vendor-1', 'project-1', 'equipment', 'Lens rental',
      12500, 'paid', '2026-05-20', 'amex', 'ch_expense_route_1',
      'r2://receipts/lens-rental.pdf', 1, 'Imported from receipt OCR.',
      'project_source', 'source-expense-1', ?, ?
    ), (
      'expense-needs-reconciliation', 'vendor-1', 'project-1', 'equipment', 'Missing receipt',
      7500, 'paid', '2026-05-21', 'amex', NULL,
      NULL, 1, 'Needs receipt upload.',
      NULL, NULL, ?, ?
    )
  `).run(now, now, now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blocked = await route.GET(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/finance/expenses.csv?expenseStatus=paid"));
  assert.equal(blocked.status, 404);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/finance/expenses.csv?expenseStatus=paid&fromDate=2026-05-01&toDate=2026-05-31", {
    headers: { "x-reese-origin-secret": "origin-secret" },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(response.headers.get("content-disposition") ?? "", /the-reeses-studio-expenses-\d{4}-\d{2}-\d{2}\.csv/);
  const csv = await response.text();
  assert.match(csv, /^Date,Status,Vendor,Project,Category,Description,Amount,Payment Method,External Payment ID,Tax Deductible,Receipt URL,Notes,Source Type,Source ID,Expense ID,Link/m);
  assert.match(csv, /2026-05-20,paid,Canon Professional Services,Alex Wedding,equipment,Lens rental,125.00,amex,ch_expense_route_1,yes,r2:\/\/receipts\/lens-rental.pdf,Imported from receipt OCR\.,project_source,source-expense-1,expense-1,\/finance\?expenseId=expense-1&expenseStatus=paid&fromDate=2026-05-01&toDate=2026-05-31/);

  const reconciliationResponse = await route.GET(new Request("https://studio.bythereeses.com/api/finance/expenses.csv?expenseStatus=needs_reconciliation", {
    headers: { "x-reese-origin-secret": "origin-secret" },
  }));
  assert.equal(reconciliationResponse.status, 200);
  const reconciliationCsv = await reconciliationResponse.text();
  assert.match(reconciliationCsv, /Missing receipt/);
  assert.doesNotMatch(reconciliationCsv, /Lens rental/);

  console.log("expenses csv route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
