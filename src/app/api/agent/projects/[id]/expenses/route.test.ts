import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-expense-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";

function request(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

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
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-2', 'Other Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'receipt_upload', 'Agent receipt source',
      'Receipt OCR source body.', 'Receipt source summary', 'Studio UI', ?, ?
    ), (
      'other-source', 'project-2', 'receipt_upload', 'Other agent receipt source',
      'Wrong receipt source body.', 'Wrong receipt source summary', 'Studio UI', ?, ?
    )
  `).run(now, now, now, now);

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects/project-1/expenses", {
    method: "POST",
    body: JSON.stringify({ vendorName: "Canon Professional Services", category: "equipment", amountCents: 12500 }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(unauthorized.status, 401);

  const response = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/expenses", {
    method: "POST",
    body: JSON.stringify({
      vendorName: "Canon Professional Services",
      category: "equipment",
      description: "Lens calibration from assistant receipt intake.",
      amountCents: 12500,
      status: "paid",
      paidAt: "2026-05-11",
      paymentMethod: "amex",
      externalPaymentId: "ch_agent_expense_1",
      receiptUrl: "r2://receipts/ch_agent_expense_1.pdf",
      taxDeductible: true,
      notes: "Recorded by agent from receipt.",
      sourceType: "project_source",
      sourceId: "source-1",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.expense.projectId, "project-1");
  assert.equal(body.expense.vendorName, "Canon Professional Services");
  assert.equal(body.expense.amountCents, 12500);
  assert.equal(body.expense.externalPaymentId, "ch_agent_expense_1");
  assert.equal(body.expense.sourceType, "project_source");
  assert.equal(body.expense.sourceId, "source-1");

  const expenseRow = database.prepare(`
    SELECT vendors.name AS vendor_name, expenses.project_id, expenses.category, expenses.description,
      expenses.amount_cents, expenses.payment_method, expenses.external_payment_id, expenses.receipt_url,
      expenses.source_type, expenses.source_id
    FROM expenses
    INNER JOIN vendors ON vendors.id = expenses.vendor_id
  `).get();
  assert.deepEqual(expenseRow, {
    vendor_name: "Canon Professional Services",
    project_id: "project-1",
    category: "equipment",
    description: "Lens calibration from assistant receipt intake.",
    amount_cents: 12500,
    payment_method: "amex",
    external_payment_id: "ch_agent_expense_1",
    receipt_url: "r2://receipts/ch_agent_expense_1.pdf",
    source_type: "project_source",
    source_id: "source-1",
  });

  const activity = database.prepare("SELECT action, actor_type, metadata FROM activity_logs").get() as {
    action: string;
    actor_type: string;
    metadata: string;
  };
  assert.equal(activity.action, "expense.created_by_agent");
  assert.equal(activity.actor_type, "agent");
  assert.deepEqual(JSON.parse(activity.metadata), {
    expenseId: body.expense.id,
    vendorId: body.expense.vendorId,
    category: "equipment",
    amountCents: 12500,
    sourceType: "project_source",
    sourceId: "source-1",
  });

  const updateResponse = await route.PATCH(request(`https://studio.bythereeses.com/api/agent/projects/project-1/expenses?id=${body.expense.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      vendorName: "B&H Photo",
      category: "equipment rental",
      description: "Corrected receipt from agent OCR.",
      amountCents: 13500,
      status: "paid",
      paidAt: "2026-05-13",
      paymentMethod: "visa",
      externalPaymentId: "ch_agent_expense_1_corrected",
      receiptUrl: "r2://receipts/ch_agent_expense_1_corrected.pdf",
      taxDeductible: true,
      notes: "Agent corrected the receipt amount.",
      sourceType: "project_source",
      sourceId: "source-1",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(updateResponse.status, 200);
  const updateBody = await updateResponse.json();
  assert.equal(updateBody.expense.id, body.expense.id);
  assert.equal(updateBody.expense.vendorName, "B&H Photo");
  assert.equal(updateBody.expense.amountCents, 13500);
  assert.equal(updateBody.expense.externalPaymentId, "ch_agent_expense_1_corrected");

  const updatedExpenseRow = database.prepare(`
    SELECT vendors.name AS vendor_name, expenses.category, expenses.amount_cents, expenses.external_payment_id, expenses.source_type, expenses.source_id
    FROM expenses
    INNER JOIN vendors ON vendors.id = expenses.vendor_id
    WHERE expenses.id = ?
  `).get(body.expense.id);
  assert.deepEqual(updatedExpenseRow, {
    vendor_name: "B&H Photo",
    category: "equipment rental",
    amount_cents: 13500,
    external_payment_id: "ch_agent_expense_1_corrected",
    source_type: "project_source",
    source_id: "source-1",
  });

  const missingExpenseId = await route.PATCH(request("https://studio.bythereeses.com/api/agent/projects/project-1/expenses", {
    method: "PATCH",
    body: JSON.stringify({ amountCents: 1000 }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(missingExpenseId.status, 400);
  assert.deepEqual(await missingExpenseId.json(), { error: "Expense id is required." });

  const wrongSource = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/expenses", {
    method: "POST",
    body: JSON.stringify({
      vendorName: "Wrong Source Vendor",
      category: "equipment",
      amountCents: 1000,
      sourceType: "project_source",
      sourceId: "other-source",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(wrongSource.status, 400);
  const wrongSourceBody = await wrongSource.json();
  assert.equal(wrongSourceBody.error, "Project source not found for this project.");

  console.log("agent expense route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
