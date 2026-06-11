import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-dashboard-actions-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { listDashboardActionItems } = await import("./dashboard");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?),
      ('client-2', 'Morgan', 'Lee', 'morgan@example.com', ?, ?),
      ('client-3', 'Casey', 'Stone', 'casey@example.com', ?, ?)
  `).run(now, now, now, now, now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
    VALUES
      ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', '2026-08-01', '2026-05-01T12:00:00.000Z', ?),
      ('project-2', 'Morgan Wedding', 'wedding', 'planning', 'active', '2026-07-01', '2026-05-02T12:00:00.000Z', ?),
      ('project-archived', 'Archived Test Project', 'wedding', 'inquiry', 'archived', NULL, '2026-05-03T12:00:00.000Z', ?)
  `).run(now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-1', 'project-1', 'client-1', 'primary', 1, ?),
      ('participant-2', 'project-2', 'client-2', 'primary', 1, ?),
      ('participant-3', 'project-archived', 'client-3', 'primary', 1, ?)
  `).run(now, now, now);
  database.prepare(`
    INSERT INTO project_events (id, project_id, type, title, event_date, calendar_sync_status, created_at, updated_at)
    VALUES ('event-engagement', 'project-2', 'engagement', 'Engagement session', NULL, 'not_connected', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposals (id, project_id, title, status, total_cents, sent_at, signed_at, created_at, updated_at)
    VALUES
      ('proposal-sent', 'project-2', 'Morgan Proposal', 'sent', 1000000, '2026-05-20T12:00:00.000Z', NULL, '2026-05-20T12:00:00.000Z', ?),
      ('proposal-signed', 'project-2', 'Signed Proposal', 'sent', 1000000, '2026-05-21T12:00:00.000Z', '2026-05-22T12:00:00.000Z', '2026-05-21T12:00:00.000Z', ?),
      ('proposal-accepted', 'project-1', 'Accepted Proposal', 'accepted', 1000000, '2026-05-18T12:00:00.000Z', NULL, '2026-05-18T12:00:00.000Z', ?)
  `).run(now, now, now);
  database.prepare(`
    INSERT INTO invoices (id, project_id, invoice_number, status, total_cents, amount_paid_cents, created_at, updated_at)
    VALUES ('invoice-1', 'project-1', 'INV-ALEX', 'sent', 500000, 0, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
    VALUES ('payment-1', 'invoice-1', 'Retainer', 250000, '2026-05-20', 'pending', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaires (id, title, description, status, created_at, updated_at)
    VALUES ('questionnaire-1', 'Timeline Questionnaire', NULL, 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaire_responses (
      id, questionnaire_id, project_id, client_id, respondent_name, respondent_email,
      submitted_at, answers_json, created_at, updated_at
    ) VALUES (
      'response-draft', 'questionnaire-1', 'project-2', 'client-2', 'Morgan Lee', 'morgan@example.com',
      NULL, '[]', '2026-05-23T12:00:00.000Z', '2026-05-24T12:00:00.000Z'
    ), (
      'response-archived-project-draft', 'questionnaire-1', 'project-archived', 'client-3', 'Casey Stone', 'casey@example.com',
      NULL, '[]', '2026-05-23T12:30:00.000Z', '2026-05-24T12:30:00.000Z'
    ), (
      'response-submitted', 'questionnaire-1', 'project-1', 'client-1', 'Alex Taylor', 'alex@example.com',
      '2026-05-25T12:00:00.000Z', '[]', '2026-05-25T12:00:00.000Z', '2026-05-25T12:00:00.000Z'
    )
  `).run();

  const actions = await listDashboardActionItems(new Date("2026-05-29T12:00:00.000Z"));

  assert.deepEqual(actions.map((item) => ({
    kind: item.kind,
    href: item.href,
    label: item.label,
    projectName: item.projectName,
  })), [
    {
      kind: "engagement_session",
      href: "/projects/project-2#events",
      label: "Schedule engagement session",
      projectName: "Morgan Wedding",
    },
    {
      kind: "invoice_payment",
      href: "/invoices/invoice-1",
      label: "Follow up on overdue payment",
      projectName: "Alex Wedding",
    },
    {
      kind: "proposal_waiting",
      href: "/proposals/proposal-sent",
      label: "Proposal waiting on client",
      projectName: "Morgan Wedding",
    },
    {
      kind: "questionnaire_draft",
      href: "/questionnaires/questionnaire-1/responses/response-draft",
      label: "Questionnaire draft in progress",
      projectName: "Morgan Wedding",
    },
    {
      kind: "inquiry_followup",
      href: "/projects/project-1",
      label: "Follow up on inquiry",
      projectName: "Alex Wedding",
    },
  ]);
  assert.equal(actions.some((item) => item.projectName === "Archived Test Project"), false);

  console.log("dashboard action tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
