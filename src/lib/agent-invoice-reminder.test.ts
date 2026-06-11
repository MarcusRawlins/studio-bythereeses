import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-invoice-reminder-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getInvoice, logInvoiceReminderFromAgent } = await import("./sales");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Agent Reminder Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Other Agent Reminder Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'email', 'Invoice follow-up draft',
      'Agent drafted a final balance reminder.', 'Follow-up source summary', 'The Reeses Studio Agent', ?, ?
    ), (
      'other-source', 'project-2', 'email', 'Other invoice follow-up',
      'Wrong project source.', 'Wrong source summary', 'The Reeses Studio Agent', ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-AGENT-REMINDER', 'sent', 500000, 0,
      'studio_absorbs', 0, 0, 0,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
    VALUES ('payment-1', 'invoice-1', 'Final balance', 500000, '2026-06-15', 'pending', ?, ?)
  `).run(now, now);

  await assert.rejects(
    () => logInvoiceReminderFromAgent("invoice-1", {
      paymentId: "payment-1",
      sourceType: "project_source",
      sourceId: "other-source",
    }),
    /Project source not found for this project/,
  );

  await assert.rejects(
    () => logInvoiceReminderFromAgent("invoice-1", {
      paymentId: "missing-payment",
      channel: "email",
    }),
    /Payment does not belong to this invoice/,
  );

  const result = await logInvoiceReminderFromAgent("invoice-1", {
    paymentId: "payment-1",
    channel: "email",
    note: "Drafted a kind final balance reminder for Tyler to send.",
    sourceType: "project_source",
    sourceId: "source-1",
  });
  assert.equal(typeof result.activityLogId, "string");
  assert.deepEqual({
    ...result,
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

  const activity = database.prepare(`
    SELECT id, action, project_id, actor_type, actor_name, metadata
    FROM activity_logs
    WHERE action = 'invoice.reminder_logged_by_agent'
  `).get() as {
    id: string;
    action: string;
    project_id: string;
    actor_type: string;
    actor_name: string;
    metadata: string;
  };
  assert.equal(activity.id, result.activityLogId);
  assert.equal(activity.project_id, "project-1");
  assert.equal(activity.actor_type, "agent");
  assert.equal(activity.actor_name, "The Reeses Studio Agent");
  assert.deepEqual(JSON.parse(activity.metadata), {
    invoiceId: "invoice-1",
    invoiceNumber: "INV-AGENT-REMINDER",
    paymentId: "payment-1",
    channel: "email",
    note: "Drafted a kind final balance reminder for Tyler to send.",
    sourceType: "project_source",
    sourceId: "source-1",
  });

  const invoice = await getInvoice("invoice-1");
  assert.ok(invoice);
  assert.deepEqual(invoice.reminders.map((reminder) => reminder.action), ["invoice.reminder_logged_by_agent"]);

  console.log("agent invoice reminder tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
