import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-invoice-reminders-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

function reminderForm(values: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }
  return formData;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getInvoice, logInvoiceReminderFromForm } = await import("./sales");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Reminder Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-REMINDER', 'sent', 500000, 0,
      'studio_absorbs', 0, 0, 0,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
    VALUES ('payment-1', 'invoice-1', 'Final balance', 500000, '2026-06-15', 'pending', ?, ?)
  `).run(now, now);

  await assert.rejects(
    () => logInvoiceReminderFromForm(reminderForm({
      invoiceId: "invoice-1",
      projectId: "missing-project",
      channel: "email",
      note: "Wrong project.",
    })),
    /Invoice does not belong to this project/,
  );

  const result = await logInvoiceReminderFromForm(reminderForm({
    invoiceId: "invoice-1",
    projectId: "project-1",
    paymentId: "payment-1",
    channel: "email",
    note: "Sent a kind final balance follow-up manually.",
  }));
  assert.equal(typeof result.activityLogId, "string");
  assert.deepEqual({ ...result, activityLogId: "activity-log-id" }, {
    invoiceId: "invoice-1",
    projectId: "project-1",
    activityLogId: "activity-log-id",
  });

  const activity = database.prepare(`
    SELECT id, action, project_id, actor_type, metadata
    FROM activity_logs
    WHERE action = 'invoice.reminder_logged'
  `).get() as { id: string; action: string; project_id: string; actor_type: string; metadata: string };
  assert.equal(activity.id, result.activityLogId);
  assert.equal(activity.project_id, "project-1");
  assert.equal(activity.actor_type, "admin");
  assert.deepEqual(JSON.parse(activity.metadata), {
    invoiceId: "invoice-1",
    invoiceNumber: "INV-REMINDER",
    paymentId: "payment-1",
    channel: "email",
    note: "Sent a kind final balance follow-up manually.",
  });

  const invoice = await getInvoice("invoice-1");
  assert.ok(invoice);
  assert.deepEqual(invoice.reminders.map((reminder) => ({
    action: reminder.action,
    note: JSON.parse(reminder.metadata ?? "{}").note,
    paymentId: JSON.parse(reminder.metadata ?? "{}").paymentId,
  })), [{
    action: "invoice.reminder_logged",
    note: "Sent a kind final balance follow-up manually.",
    paymentId: "payment-1",
  }]);

  console.log("invoice reminder tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
