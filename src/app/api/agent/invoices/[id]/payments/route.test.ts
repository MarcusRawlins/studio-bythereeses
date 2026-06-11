import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-payment-route-"));
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
    VALUES ('project-1', 'Payment Route Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-PAY-REST', 'sent', 100000, 0,
      'client_pays', 290, 30, 2930,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
    VALUES ('payment-1', 'invoice-1', 'Retainer', 30000, '2026-06-01', 'pending', ?, ?)
  `).run(now, now);

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/invoices/invoice-1/payments", {
    method: "POST",
    body: JSON.stringify({ paymentId: "payment-1" }),
  }), { params: Promise.resolve({ id: "invoice-1" }) });
  assert.equal(unauthorized.status, 401);

  const createResponse = await route.POST(request("https://studio.bythereeses.com/api/agent/invoices/invoice-1/payments", {
    paymentId: "payment-1",
    status: "paid",
    paidAmountCents: 30000,
  }), { params: Promise.resolve({ id: "invoice-1" }) });
  assert.equal(createResponse.status, 400);
  assert.match((await createResponse.json()).error, /Payments require Tyler approval/);

  const updateResponse = await route.PATCH(request("https://studio.bythereeses.com/api/agent/invoices/invoice-1/payments", {
    paymentId: "payment-1",
    status: "paid",
    paidAmountCents: 29000,
  }, "PATCH"), { params: Promise.resolve({ id: "invoice-1" }) });
  assert.equal(updateResponse.status, 400);
  assert.match((await updateResponse.json()).error, /Payments require Tyler approval/);

  assert.deepEqual(database.prepare(`
    SELECT status, paid_amount_cents, paid_at
    FROM invoice_payments
    WHERE id = 'payment-1'
  `).get(), {
    status: "pending",
    paid_amount_cents: 0,
    paid_at: null,
  });

  console.log("agent payment route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
