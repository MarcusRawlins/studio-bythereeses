import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-proposal-workflow-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Canonical Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Wrong Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, total_cents, contract_status, invoice_status, signed_at, created_at, updated_at
    ) VALUES (
      'proposal-1', 'project-1', 'Original Proposal', 'draft', 500000, 'ready', 'not_created', NULL, ?, ?
    ), (
      'proposal-accepted', 'project-1', 'Accepted Proposal', 'draft', 970000, 'ready', 'not_created', NULL, ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO proposal_line_items (
      id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at
    ) VALUES
      ('line-1', 'proposal-1', 'Original coverage', 1, 500000, 0, 0, ?, ?),
      ('accepted-line-1', 'proposal-accepted', 'Wedding coverage', 1, 850000, 0, 0, ?, ?),
      ('accepted-line-2', 'proposal-accepted', 'Engagement session', 1, 120000, 0, 1, ?, ?)
  `).run(now, now, now, now, now, now);
  database.prepare(`
    UPDATE proposals
    SET status = 'accepted', contract_status = 'signed', signed_at = ?, accepted_at = ?, updated_at = ?
    WHERE id = 'proposal-accepted'
  `).run(now, now, now);

  const wrongForm = new FormData();
  wrongForm.set("projectId", "project-2");
  wrongForm.set("workflowAction", "send");

  const originalConsoleError = console.error;
  console.error = () => {};
  const wrongResponse = await POST(new Request("https://studio.test/api/proposals/proposal-1/workflow", {
    method: "POST",
    body: wrongForm,
  }), { params: Promise.resolve({ id: "proposal-1" }) }).finally(() => {
    console.error = originalConsoleError;
  });

  assert.equal(wrongResponse.status, 400);
  assert.deepEqual(await wrongResponse.json(), { error: "Proposal does not belong to this project." });
  assert.deepEqual(database.prepare(`
    SELECT status, sent_at
    FROM proposals
    WHERE id = 'proposal-1'
  `).get(), { status: "draft", sent_at: null });

  const formData = new FormData();
  formData.set("projectId", "project-1");
  formData.set("workflowAction", "send");

  const response = await POST(new Request("https://studio.test/api/proposals/proposal-1/workflow", {
    method: "POST",
    body: formData,
  }), { params: Promise.resolve({ id: "proposal-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.test/proposals/proposal-1");
  assert.equal(database.prepare("SELECT status FROM proposals WHERE id = 'proposal-1'").get().status, "sent");

  const invoiceForm = new FormData();
  invoiceForm.set("projectId", "project-1");
  invoiceForm.set("workflowAction", "create_invoice");

  const invoiceResponse = await POST(new Request("https://studio.test/api/proposals/proposal-accepted/workflow", {
    method: "POST",
    body: invoiceForm,
  }), { params: Promise.resolve({ id: "proposal-accepted" }) });

  assert.equal(invoiceResponse.status, 303);
  const createdInvoiceId = database.prepare("SELECT id FROM invoices WHERE proposal_id = 'proposal-accepted'").get().id;
  assert.equal(invoiceResponse.headers.get("location"), `https://studio.test/invoices/${createdInvoiceId}`);
  assert.deepEqual(database.prepare(`
    SELECT project_id, proposal_id, total_cents, amount_paid_cents
    FROM invoices
    WHERE id = ?
  `).get(createdInvoiceId), {
    project_id: "project-1",
    proposal_id: "proposal-accepted",
    total_cents: 970000,
    amount_paid_cents: 0,
  });
  assert.deepEqual(database.prepare(`
    SELECT label, amount_cents
    FROM invoice_payments
    WHERE invoice_id = ?
    ORDER BY amount_cents, label
  `).all(createdInvoiceId), [
    { label: "Retainer", amount_cents: 291000 },
    { label: "Final payment", amount_cents: 679000 },
  ]);
  assert.deepEqual(database.prepare(`
    SELECT invoice_status
    FROM proposals
    WHERE id = 'proposal-accepted'
  `).get(), { invoice_status: "created" });

  const originalConsoleErrorForDuplicate = console.error;
  console.error = () => {};
  const duplicateResponse = await POST(new Request("https://studio.test/api/proposals/proposal-accepted/workflow", {
    method: "POST",
    body: invoiceForm,
  }), { params: Promise.resolve({ id: "proposal-accepted" }) }).finally(() => {
    console.error = originalConsoleErrorForDuplicate;
  });

  assert.equal(duplicateResponse.status, 400);
  assert.deepEqual(await duplicateResponse.json(), { error: "An invoice already exists for this proposal." });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM invoices WHERE proposal_id = 'proposal-accepted'").get().count, 1);

  console.log("proposal workflow route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
