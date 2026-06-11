import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-bookkeeping-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { bookkeepingSummaryCsv, createExpense, expensesCsv, getBookkeepingReport, updateExpenseFromAgent } = await import("./bookkeeping");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-2', 'Other Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'receipt_upload', 'Lens calibration receipt',
      'Receipt OCR for lens calibration.', 'Receipt source summary', 'Studio UI', ?, ?
    ), (
      'other-source', 'project-2', 'receipt_upload', 'Other receipt',
      'Wrong project receipt.', 'Wrong source summary', 'Studio UI', ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents, created_at, updated_at
    ) VALUES ('invoice-1', 'project-1', 'INV-1', 'partially_paid', 900000, 300000, ?, ?),
             ('invoice-old', 'project-1', 'INV-OLD', 'paid', 50000, 50000, ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, status, paid_at, paid_amount_cents,
      client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents,
      created_at, updated_at
    ) VALUES (
      'payment-1', 'invoice-1', 'Retainer', 300000, 'paid', '2026-05-10T10:00:00.000Z',
      300000, 0, 8730, 300000, 291270, ?, ?
    ), (
      'payment-old', 'invoice-old', 'Old payment', 50000, 'paid', '2026-04-10T10:00:00.000Z',
      50000, 0, 0, 50000, 50000, ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, collect_payment, price_cents, created_at, updated_at
    ) VALUES ('meeting-1', 'paid-consult', 'Paid Consultation', 45, 15, 1, 25000, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, client_id, attendee_name, attendee_email,
      start_at, end_at, status, source, payment_status, paid_at, paid_amount_cents,
      client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents,
      created_at, updated_at
    ) VALUES (
      'booking-may', 'meeting-1', 'project-1', NULL, 'Alex Taylor', 'alex@example.com',
      '2026-05-20T14:00:00.000Z', '2026-05-20T14:45:00.000Z', 'confirmed', 'booking_link',
      'paid', '2026-05-20T13:00:00.000Z', 25000, 755, 755, 25755, 25000, ?, ?
    ), (
      'booking-old', 'meeting-1', 'project-1', NULL, 'Alex Taylor', 'alex@example.com',
      '2026-04-20T14:00:00.000Z', '2026-04-20T14:45:00.000Z', 'confirmed', 'booking_link',
      'paid', '2026-04-20T13:00:00.000Z', 25000, 755, 755, 25755, 25000, ?, ?
    )
  `).run(now, now, now, now);

  const firstExpense = await createExpense({
    projectId: "project-1",
    vendorName: "Canon Professional Services",
    category: "equipment",
    description: "Lens calibration",
    amountCents: 12500,
    status: "paid",
    paidAt: "2026-05-11",
    paymentMethod: "amex",
    externalPaymentId: "ch_123",
    receiptUrl: "r2://receipts/lens-calibration.pdf",
    taxDeductible: true,
    notes: "Job-specific equipment service.",
    sourceType: "project_source",
    sourceId: "source-1",
  });

  const secondExpense = await createExpense({
    vendorName: " canon professional services ",
    category: "equipment",
    description: "Backup battery",
    amountCents: 4500,
    status: "paid",
    paidAt: "2026-05-12",
    paymentMethod: "amex",
    taxDeductible: false,
  });

  await createExpense({
    projectId: "project-1",
    vendorName: "Second Shooter Co",
    category: "contractor",
    description: "Assistant photographer balance",
    amountCents: 80000,
    status: "unpaid",
    paidAt: "2026-05-25",
    paymentMethod: "ach",
    taxDeductible: true,
  });

  assert.equal(firstExpense.vendorId, secondExpense.vendorId);

  const duplicateImportedExpense = await createExpense({
    projectId: "project-1",
    vendorName: "Canon Professional Services",
    category: "equipment",
    description: "Lens calibration receipt retry with corrected notes",
    amountCents: 12500,
    status: "paid",
    paidAt: "2026-05-11",
    paymentMethod: "amex",
    externalPaymentId: "ch_123",
    receiptUrl: "r2://receipts/lens-calibration-clean.pdf",
    taxDeductible: true,
    notes: "Updated OCR import should update the canonical charge row.",
    sourceType: "project_source",
    sourceId: "source-1",
  });

  assert.equal(duplicateImportedExpense.id, firstExpense.id);
  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM expenses
    WHERE external_payment_id = 'ch_123'
  `).get(), { count: 1 });
  assert.deepEqual(database.prepare(`
    SELECT description, receipt_url, notes
    FROM expenses
    WHERE id = ?
  `).get(firstExpense.id), {
    description: "Lens calibration receipt retry with corrected notes",
    receipt_url: "r2://receipts/lens-calibration-clean.pdf",
    notes: "Updated OCR import should update the canonical charge row.",
  });

  const vendors = database.prepare("SELECT name, normalized_name FROM vendors").all();
  assert.deepEqual(vendors, [
    { name: "Canon Professional Services", normalized_name: "canon professional services" },
    { name: "Second Shooter Co", normalized_name: "second shooter co" },
  ]);

  const report = await getBookkeepingReport({ status: "paid" });
  assert.equal(report.totals.revenueCents, 400000);
  assert.equal(report.totals.grossCollectedCents, 401510);
  assert.equal(report.totals.clientFeeCents, 1510);
  assert.equal(report.totals.processingFeeCents, 10240);
  assert.equal(report.totals.netDepositCents, 391270);
  assert.equal(report.totals.expenseCents, 17000);
  assert.equal(report.totals.paidExpenseCents, 17000);
  assert.equal(report.totals.openPayableCents, 80000);
  assert.equal(report.totals.netIncomeCents, 374270);
  assert.equal(report.expenses.length, 2);
  assert.equal(report.expenses[0].project?.name, "Alex Wedding");
  assert.equal(report.expenses[0].vendor.name, "Canon Professional Services");
  assert.equal(report.expenses[0].expense.sourceType, "project_source");
  assert.equal(report.expenses[0].expense.sourceId, "source-1");

  const reconciliationReport = await getBookkeepingReport({ status: "needs_reconciliation" });
  assert.deepEqual(reconciliationReport.expenses.map((row) => ({
    vendor: row.vendor.name,
    description: row.expense.description,
    status: row.expense.status,
  })), [
    {
      vendor: "Canon Professional Services",
      description: "Backup battery",
      status: "paid",
    },
  ]);
  assert.equal(reconciliationReport.totals.expenseCents, 4500);

  const mayReport = await getBookkeepingReport({
    status: "paid",
    fromDate: "2026-05-01",
    toDate: "2026-05-31",
  });
  assert.equal(mayReport.totals.revenueCents, 325000);
  assert.equal(mayReport.totals.grossCollectedCents, 325755);
  assert.equal(mayReport.totals.clientFeeCents, 755);
  assert.equal(mayReport.totals.processingFeeCents, 9485);
  assert.equal(mayReport.totals.netDepositCents, 316270);
  assert.equal(mayReport.totals.expenseCents, 17000);
  assert.equal(mayReport.totals.paidExpenseCents, 17000);
  assert.equal(mayReport.totals.openPayableCents, 80000);
  assert.equal(mayReport.totals.taxDeductibleExpenseCents, 12500);
  assert.equal(mayReport.totals.nonDeductibleExpenseCents, 4500);
  assert.equal(mayReport.totals.netIncomeCents, 299270);
  assert.deepEqual(mayReport.expensesByCategory, [
    {
      category: "equipment",
      expenseCents: 17000,
      taxDeductibleExpenseCents: 12500,
      count: 2,
    },
  ]);
  assert.deepEqual(mayReport.expensesByVendor, [
    {
      vendorId: firstExpense.vendorId,
      vendorName: "Canon Professional Services",
      expenseCents: 17000,
      taxDeductibleExpenseCents: 12500,
      count: 2,
    },
  ]);

  const aprilReport = await getBookkeepingReport({
    status: "paid",
    fromDate: "2026-04-01",
    toDate: "2026-04-30",
  });
  assert.equal(aprilReport.totals.revenueCents, 75000);
  assert.equal(aprilReport.totals.grossCollectedCents, 75755);
  assert.equal(aprilReport.totals.clientFeeCents, 755);
  assert.equal(aprilReport.totals.processingFeeCents, 755);
  assert.equal(aprilReport.totals.netDepositCents, 75000);
  assert.equal(aprilReport.totals.expenseCents, 0);
  assert.equal(aprilReport.totals.paidExpenseCents, 0);
  assert.equal(aprilReport.totals.openPayableCents, 0);
  assert.equal(aprilReport.totals.netIncomeCents, 75000);
  assert.equal(aprilReport.expenses.length, 0);

  const csv = expensesCsv(report.expenses);
  assert.ok(csv.startsWith("Date,Status,Vendor,Project,Category,Description,Amount,Payment Method,External Payment ID,Tax Deductible,Receipt URL,Notes,Source Type,Source ID"));
  assert.ok(csv.includes("Canon Professional Services,Alex Wedding,equipment,Lens calibration receipt retry with corrected notes,125.00,amex,ch_123,yes,r2://receipts/lens-calibration-clean.pdf,Updated OCR import should update the canonical charge row.,project_source,source-1"));
  const filteredCsv = expensesCsv(report.expenses, {
    expenseStatus: "paid",
    fromDate: "2026-05-01",
    toDate: "2026-05-31",
  });
  assert.ok(filteredCsv.includes("/finance?expenseId="));
  assert.ok(filteredCsv.includes("&expenseStatus=paid&fromDate=2026-05-01&toDate=2026-05-31"));
  const reconciliationCsv = expensesCsv(reconciliationReport.expenses, {
    expenseStatus: "needs_reconciliation",
  });
  assert.ok(reconciliationCsv.includes("Backup battery"));
  assert.ok(reconciliationCsv.includes("&expenseStatus=needs_reconciliation"));

  const summaryCsv = bookkeepingSummaryCsv(mayReport, {
    expenseStatus: "paid",
    fromDate: "2026-05-01",
    toDate: "2026-05-31",
  });
  assert.ok(summaryCsv.startsWith("Section,Name,Count,Amount,Tax Deductible Amount,Notes"));
  assert.ok(summaryCsv.includes("Period,From,,2026-05-01,,"));
  assert.ok(summaryCsv.includes("Period,To,,2026-05-31,,"));
  assert.ok(summaryCsv.includes("Totals,Service revenue,,3250.00,,Paid invoice and scheduler service revenue"));
  assert.ok(summaryCsv.includes("Totals,Gross collected,,3257.55,,Client payments including client-paid fees"));
  assert.ok(summaryCsv.includes("Totals,Client-paid fees,,7.55,,Fees assigned to clients"));
  assert.ok(summaryCsv.includes("Totals,Processor fees,,94.85,,Processor fees recorded on settlement rows"));
  assert.ok(summaryCsv.includes("Totals,Net deposits,,3162.70,,Cash after processor fees"));
  assert.ok(summaryCsv.includes("Totals,Paid expenses,,170.00,,Paid expenses in the selected expense status view"));
  assert.ok(summaryCsv.includes("Totals,Open payables,,800.00,,Unpaid vendor costs still owed"));
  assert.ok(summaryCsv.includes("Totals,Net income,,2992.70,,Net deposits minus paid expenses"));
  assert.ok(summaryCsv.includes("Expense category,equipment,2,170.00,125.00,"));
  assert.ok(summaryCsv.includes("Vendor,Canon Professional Services,2,170.00,125.00,"));

  const updatedByAgent = await updateExpenseFromAgent("project-1", firstExpense.id, {
    vendorName: "B&H Photo",
    category: "equipment rental",
    description: "Corrected lens calibration receipt",
    amountCents: 13500,
    status: "paid",
    paidAt: "2026-05-13",
    paymentMethod: "visa",
    externalPaymentId: "ch_123_corrected",
    receiptUrl: "r2://receipts/lens-calibration-corrected.pdf",
    taxDeductible: true,
    notes: "Agent corrected OCR vendor and amount.",
    sourceType: "project_source",
    sourceId: "source-1",
  });

  assert.equal(updatedByAgent.id, firstExpense.id);
  assert.equal(updatedByAgent.vendorName, "B&H Photo");
  assert.equal(updatedByAgent.amountCents, 13500);
  assert.equal(updatedByAgent.externalPaymentId, "ch_123_corrected");
  assert.deepEqual(database.prepare(`
    SELECT vendors.name AS vendor_name, expenses.category, expenses.description, expenses.amount_cents,
      expenses.payment_method, expenses.external_payment_id, expenses.receipt_url, expenses.notes,
      expenses.source_type, expenses.source_id
    FROM expenses
    INNER JOIN vendors ON vendors.id = expenses.vendor_id
    WHERE expenses.id = ?
  `).get(firstExpense.id), {
    vendor_name: "B&H Photo",
    category: "equipment rental",
    description: "Corrected lens calibration receipt",
    amount_cents: 13500,
    payment_method: "visa",
    external_payment_id: "ch_123_corrected",
    receipt_url: "r2://receipts/lens-calibration-corrected.pdf",
    notes: "Agent corrected OCR vendor and amount.",
    source_type: "project_source",
    source_id: "source-1",
  });

  const updateActivity = database.prepare(`
    SELECT action, actor_type
    FROM activity_logs
    WHERE action = 'expense.updated_by_agent'
  `).get();
  assert.deepEqual(updateActivity, { action: "expense.updated_by_agent", actor_type: "agent" });

  await assert.rejects(
    () => createExpense({ vendorName: "Missing Amount", category: "software", amountCents: 0 }),
    /Expense amount is required/,
  );
  await assert.rejects(
    () => createExpense({
      projectId: "project-1",
      vendorName: "Half Source",
      category: "equipment",
      amountCents: 1000,
      sourceId: "source-1",
    }),
    /Expense source links require sourceType when sourceId is set/,
  );

  const unlinkedProjectExpense = await createExpense({
    projectId: "project-1",
    vendorName: "Unlinked Source Vendor",
    category: "equipment",
    amountCents: 1000,
  });
  await assert.rejects(
    () => updateExpenseFromAgent("project-1", unlinkedProjectExpense.id, {
      sourceId: "source-1",
    }),
    /Expense source links require sourceType when sourceId is set/,
  );

  await assert.rejects(
    () => createExpense({
      projectId: "project-1",
      vendorName: "Wrong Source",
      category: "equipment",
      amountCents: 1000,
      sourceType: "project_source",
      sourceId: "other-source",
    }),
    /Project source not found/,
  );
  await assert.rejects(
    () => updateExpenseFromAgent("project-1", firstExpense.id, {
      vendorName: "Wrong Source",
      category: "equipment",
      amountCents: 1000,
      sourceType: "project_source",
      sourceId: "other-source",
    }),
    /Project source not found/,
  );
  await assert.rejects(
    () => updateExpenseFromAgent("project-2", firstExpense.id, {
      vendorName: "Wrong Project",
      category: "equipment",
      amountCents: 1000,
    }),
    /Expense not found/,
  );

  console.log("bookkeeping tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
