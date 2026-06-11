import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-invoice-reminder-route-"));
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
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Reminder Route Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
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
      'invoice-1', 'project-1', 'INV-ROUTE-REMINDER', 'sent', 500000, 0,
      'studio_absorbs', 0, 0, 0,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO templates (id, type, name, trigger, subject, body, status, created_at, updated_at)
    VALUES (
      'template-reminder-1', 'reminder', 'Balance Due Follow-up', '3 days before due date',
      'Balance reminder',
      'Hi {{client.name}}, {{invoice.number}} for {{project.name}} has {{invoice.balanceDue}} remaining.',
      'active', ?, ?
    )
  `).run(now, now);

  const response = await route.POST(new Request("https://studio.test/api/invoices/invoice-1/reminders", {
    method: "POST",
    body: form({
      projectId: "project-1",
      templateId: "template-reminder-1",
      channel: "email",
    }),
  }), { params: Promise.resolve({ id: "invoice-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.test/invoices/invoice-1");
  assert.deepEqual(database.prepare(`
    SELECT action, project_id
    FROM activity_logs
    WHERE action = 'invoice.reminder_logged'
  `).get(), {
    action: "invoice.reminder_logged",
    project_id: "project-1",
  });
  const activity = database.prepare(`
    SELECT metadata
    FROM activity_logs
    WHERE action = 'invoice.reminder_logged'
  `).get() as { metadata: string };
  assert.deepEqual(JSON.parse(activity.metadata), {
    invoiceId: "invoice-1",
    invoiceNumber: "INV-ROUTE-REMINDER",
    paymentId: null,
    channel: "email",
    note: "Hi Alex Taylor, INV-ROUTE-REMINDER for Reminder Route Wedding has $5,000 remaining.",
    templateId: "template-reminder-1",
    templateName: "Balance Due Follow-up",
  });

  console.log("invoice reminder route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
