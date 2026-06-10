import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-invoice-status-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

function form(values: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }
  return formData;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Invoice Route Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Wrong Invoice Route Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-ROUTE', 'draft', 500000, 0,
      'studio_absorbs', 0, 0, 0,
      ?, ?
    )
  `).run(now, now);

  const originalConsoleError = console.error;
  console.error = () => {};
  const wrongResponse = await POST(new Request("https://studio.test/api/invoices/invoice-1/status", {
    method: "POST",
    body: form({ projectId: "project-2", status: "paid" }),
  }), { params: Promise.resolve({ id: "invoice-1" }) }).finally(() => {
    console.error = originalConsoleError;
  });

  assert.equal(wrongResponse.status, 400);
  assert.deepEqual(await wrongResponse.json(), { error: "Invoice does not belong to this project." });
  assert.deepEqual(database.prepare(`
    SELECT status, sent_at, paid_at
    FROM invoices
    WHERE id = 'invoice-1'
  `).get(), {
    status: "draft",
    sent_at: null,
    paid_at: null,
  });

  console.error = () => {};
  const paidResponse = await POST(new Request("https://studio.test/api/invoices/invoice-1/status", {
    method: "POST",
    body: form({ projectId: "project-1", status: "paid" }),
  }), { params: Promise.resolve({ id: "invoice-1" }) }).finally(() => {
    console.error = originalConsoleError;
  });

  assert.equal(paidResponse.status, 400);
  assert.deepEqual(await paidResponse.json(), { error: "Use the invoice payment endpoint to record paid invoice state." });
  assert.deepEqual(database.prepare(`
    SELECT status, amount_paid_cents, paid_at
    FROM invoices
    WHERE id = 'invoice-1'
  `).get(), {
    status: "draft",
    amount_paid_cents: 0,
    paid_at: null,
  });

  const response = await POST(new Request("https://studio.test/api/invoices/invoice-1/status", {
    method: "POST",
    body: form({ projectId: "project-1", status: "sent" }),
  }), { params: Promise.resolve({ id: "invoice-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.test/invoices/invoice-1");
  assert.equal(database.prepare("SELECT status FROM invoices WHERE id = 'invoice-1'").get().status, "sent");

  console.log("invoice status route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
