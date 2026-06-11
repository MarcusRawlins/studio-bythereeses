import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-reminder-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";

function request(url: string, body: unknown, token = "secret") {
  return new Request(url, {
    method: "POST",
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
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Agent Reminder Route Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'email', 'Reminder route source',
      'Agent route reminder source.', 'Route reminder summary', 'The Reeses Studio Agent', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-AGENT-ROUTE-REMINDER', 'sent', 500000, 0,
      'studio_absorbs', 0, 0, 0,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
    VALUES ('payment-1', 'invoice-1', 'Final balance', 500000, '2026-06-15', 'pending', ?, ?)
  `).run(now, now);

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/invoices/invoice-1/reminders", {
    method: "POST",
    body: JSON.stringify({ paymentId: "payment-1" }),
  }), { params: Promise.resolve({ id: "invoice-1" }) });
  assert.equal(unauthorized.status, 401);

  const response = await route.POST(request("https://studio.bythereeses.com/api/agent/invoices/invoice-1/reminders", {
    paymentId: "payment-1",
    channel: "email",
    note: "Logged from REST agent after drafting follow-up.",
    sourceType: "project_source",
    sourceId: "source-1",
  }), { params: Promise.resolve({ id: "invoice-1" }) });

  assert.equal(response.status, 201);
  const body = await response.json() as {
    reminder: {
      invoiceId: string;
      projectId: string;
      paymentId: string;
      channel: string;
      sourceType: string;
      sourceId: string;
      activityLogId: string;
    };
  };
  assert.equal(typeof body.reminder.activityLogId, "string");
  assert.deepEqual({
    ...body.reminder,
    activityLogId: "activity-log-id",
  }, {
    invoiceId: "invoice-1",
    projectId: "project-1",
    paymentId: "payment-1",
    channel: "email",
    sourceType: "project_source",
    sourceId: "source-1",
    activityLogId: "activity-log-id",
  });

  assert.deepEqual(database.prepare(`
    SELECT id, action, actor_type
    FROM activity_logs
    WHERE action = 'invoice.reminder_logged_by_agent'
  `).get(), {
    id: body.reminder.activityLogId,
    action: "invoice.reminder_logged_by_agent",
    actor_type: "agent",
  });

  console.log("agent reminder route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
