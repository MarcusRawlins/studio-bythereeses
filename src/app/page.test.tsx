import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-dashboard-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { dashboardDateKeyParts, dashboardDateLabel, dashboardGreeting, default: DashboardPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', '2026-09-19', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
    VALUES ('project-archived-inquiry', 'Archived Inquiry', 'wedding', 'inquiry', 'archived', NULL, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_amount_cents, created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-DASHBOARD-FEE', 'partially_paid', 900000, 300000,
      'client_pays', 26130, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-1', 'invoice-1', 'Retainer', 300000, '2026-06-01', 'paid',
      '2026-06-02T10:00:00.000Z', 'stripe',
      300000, 8730, 8730, 308730,
      300000, ?, ?
    ), (
      'payment-2', 'invoice-1', 'Final payment', 600000, '2026-08-19', 'pending',
      NULL, NULL,
      0, 0, 0, 0,
      0, ?, ?
    )
  `).run(now, now, now, now);

  const markup = renderToStaticMarkup(await DashboardPage());

  assert.equal(dashboardGreeting(new Date("2026-06-01T16:30:00.000Z"), "America/New_York"), "Good afternoon");
  assert.equal(dashboardGreeting(new Date("2026-06-01T22:30:00.000Z"), "America/New_York"), "Good evening");
  assert.equal(dashboardDateLabel(new Date("2026-06-02T02:30:00.000Z"), "America/New_York"), "Monday, June 1");
  assert.deepEqual(dashboardDateKeyParts("2026-06-05"), { month: "Jun", day: "5" });

  assert.match(markup, /Outstanding/);
  assert.match(markup, /\$6,174/);
  assert.match(markup, /0 conversations in motion/);

  console.log("dashboard page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
