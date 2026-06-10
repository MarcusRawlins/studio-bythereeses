import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-invoice-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";

function request(url: string, body: unknown, method = "POST", token = "secret") {
  return new Request(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_amount_cents, created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-REST-LOCKED', 'draft', 900000, 0,
      'client_pays', 26130, ?, ?
    )
  `).run(now, now);

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects/project-1/invoices", {
    method: "POST",
    body: JSON.stringify({ totalCents: 900000 }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(unauthorized.status, 401);

  const createResponse = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/invoices", {
    invoiceNumber: "INV-REST-AGENT",
    totalCents: 900000,
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(createResponse.status, 400);
  assert.match((await createResponse.json()).error, /Invoices and payment schedules require Tyler approval/);

  const updateResponse = await route.PATCH(request("https://studio.bythereeses.com/api/agent/projects/project-1/invoices?id=invoice-1", {
    totalCents: 1000000,
  }, "PATCH"), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(updateResponse.status, 400);
  assert.match((await updateResponse.json()).error, /Invoices and payment schedules require Tyler approval/);

  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM invoices
    WHERE invoice_number = 'INV-REST-AGENT'
  `).get(), { count: 0 });
  assert.deepEqual(database.prepare(`
    SELECT total_cents
    FROM invoices
    WHERE id = 'invoice-1'
  `).get(), { total_cents: 900000 });

  console.log("agent invoice route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
