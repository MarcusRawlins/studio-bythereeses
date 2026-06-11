import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-expense-route-"));
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

  const formData = new FormData();
  formData.set("projectId", "project-1");
  formData.set("vendorName", "Adobe");
  formData.set("category", "software");
  formData.set("description", "Creative Cloud");
  formData.set("amount", "64.99");
  formData.set("status", "paid");
  formData.set("paidAt", "2026-05-20");
  formData.set("paymentMethod", "amex");
  formData.set("externalPaymentId", "cc_adobe_1");
  formData.set("taxDeductible", "on");
  formData.set("expenseStatus", "paid");
  formData.set("fromDate", "2026-05-01");
  formData.set("toDate", "2026-05-31");
  formData.set("asOfDate", "2026-09-20");

  const response = await route.POST(new Request("https://studio.bythereeses.com/api/finance/expenses", {
    method: "POST",
    body: formData,
  }));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.bythereeses.com/finance?saved=expense&status=paid&expenseStatus=paid&fromDate=2026-05-01&toDate=2026-05-31&asOfDate=2026-09-20");

  const row = database.prepare(`
    SELECT vendors.name AS vendor_name, expenses.project_id, expenses.category, expenses.amount_cents, expenses.tax_deductible
    FROM expenses
    INNER JOIN vendors ON vendors.id = expenses.vendor_id
  `).get();
  assert.deepEqual(row, {
    vendor_name: "Adobe",
    project_id: "project-1",
    category: "software",
    amount_cents: 6499,
    tax_deductible: 1,
  });

  const expenseId = (database.prepare("SELECT id FROM expenses LIMIT 1").get() as { id: string }).id;
  const updateForm = new FormData();
  updateForm.set("_action", "update");
  updateForm.set("expenseId", expenseId);
  updateForm.set("projectId", "project-1");
  updateForm.set("vendorName", "Adobe Systems");
  updateForm.set("category", "software");
  updateForm.set("description", "Creative Cloud team plan");
  updateForm.set("amount", "79.99");
  updateForm.set("status", "unpaid");
  updateForm.set("paidAt", "2026-05-21");
  updateForm.set("paymentMethod", "amex");
  updateForm.set("externalPaymentId", "cc_adobe_1_revised");
  updateForm.set("taxDeductible", "off");
  updateForm.set("notes", "Corrected from Amex export.");
  updateForm.set("ledgerStatus", "all");
  updateForm.set("expenseStatus", "all");
  updateForm.set("fromDate", "2026-05-01");
  updateForm.set("toDate", "2026-05-31");

  const updateResponse = await route.POST(new Request("https://studio.bythereeses.com/api/finance/expenses", {
    method: "POST",
    body: updateForm,
  }));

  assert.equal(updateResponse.status, 303);
  assert.equal(updateResponse.headers.get("location"), `https://studio.bythereeses.com/finance?saved=expense&expenseId=${expenseId}&status=all&expenseStatus=all&fromDate=2026-05-01&toDate=2026-05-31`);

  const updatedRow = database.prepare(`
    SELECT vendors.name AS vendor_name, expenses.project_id, expenses.category, expenses.description,
      expenses.amount_cents, expenses.status, expenses.paid_at, expenses.payment_method,
      expenses.external_payment_id, expenses.tax_deductible, expenses.notes
    FROM expenses
    INNER JOIN vendors ON vendors.id = expenses.vendor_id
    WHERE expenses.id = ?
  `).get(expenseId);
  assert.deepEqual(updatedRow, {
    vendor_name: "Adobe Systems",
    project_id: "project-1",
    category: "software",
    description: "Creative Cloud team plan",
    amount_cents: 7999,
    status: "unpaid",
    paid_at: "2026-05-21",
    payment_method: "amex",
    external_payment_id: "cc_adobe_1_revised",
    tax_deductible: 0,
    notes: "Corrected from Amex export.",
  });
  assert.deepEqual(database.prepare("SELECT action, actor_type FROM activity_logs ORDER BY created_at DESC LIMIT 1").get(), {
    action: "expense.updated",
    actor_type: "admin",
  });

  console.log("expense route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
