import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-data-health-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: DataHealthPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-orphan', 'Bailey', 'Bickley', 'bailey@example.com', ?, ?),
      ('client-primary', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-unlinked', 'Unlinked Wedding', 'wedding', 'inquiry', 'active', ?, ?),
      ('project-questionnaire-drift', 'Questionnaire Drift Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-agent-output-drift', 'Agent Output Drift Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now, now, now);
  database.prepare(`
    UPDATE projects
    SET event_date = '2026-08-01', venue_name = 'Old Venue'
    WHERE id = 'project-questionnaire-drift'
  `).run();
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-questionnaire-drift', 'project-questionnaire-drift', 'client-primary', 'primary', 1, ?),
      ('participant-agent-output-drift', 'project-agent-output-drift', 'client-primary', 'primary', 1, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, source_type, source_id, created_at, updated_at
    ) VALUES (
      'source-agent-output-drift', 'project-agent-output-drift', 'discovery_call',
      'Discovery call for agent output drift', 'Discovery notes for source-aware output.',
      'studio_project', 'manual-source-agent-output-drift', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposals (id, project_id, title, status, total_cents, created_at, updated_at)
    VALUES ('proposal-uncited-output', 'project-agent-output-drift', 'Uncited Proposal', 'draft', 500000, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO agent_tasks (
      id, project_id, title, status, priority, assigned_agent, source_type, source_id,
      result_summary, output_json, created_at, updated_at, completed_at
    ) VALUES (
      'agent-task-output-drift', 'project-agent-output-drift',
      'Create proposal from discovery call', 'completed', 'high', 'Proposal Agent',
      'project_source', 'source-agent-output-drift',
      'Proposal drafted, but output row lost its source citation.',
      ?, ?, ?, ?
    )
  `).run(JSON.stringify({ proposalId: "proposal-uncited-output" }), now, now, now);
  database.prepare(`
    INSERT INTO questionnaires (id, title, status, created_at, updated_at)
    VALUES ('questionnaire-1', 'Timeline Questionnaire', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaire_responses (
      id, questionnaire_id, project_id, client_id, respondent_name, submitted_at,
      answers_json, created_at, updated_at
    ) VALUES (
      'response-project-drift', 'questionnaire-1', 'project-questionnaire-drift', 'client-primary',
      'Alex Taylor', '2026-05-31T12:30:00.000Z', ?, ?, ?
    )
  `).run(JSON.stringify([
    {
      questionId: "question-date",
      title: "Wedding date",
      type: "short_text",
      required: false,
      value: "2026-09-19",
    },
  ]), now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      created_at, updated_at
    ) VALUES ('invoice-schedule-drift', 'project-unlinked', 'INV-SCHEDULE-DRIFT', 'sent', 120000, 0, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, status, paid_amount_cents, created_at, updated_at
    ) VALUES ('payment-schedule-drift', 'invoice-schedule-drift', 'Retainer', 50000, 'pending', 0, ?, ?)
  `).run(now, now);

  const markup = renderToStaticMarkup(await DataHealthPage());

  assert.match(markup, /Data health/);
  assert.match(markup, /3 projects/);
  assert.match(markup, /2 clients/);
  assert.match(markup, /5 issues/);
  assert.match(markup, /Project has no linked client/);
  assert.match(markup, /Unlinked Wedding/);
  assert.match(markup, /Questionnaire project facts differ from project record/);
  assert.match(markup, /Questionnaire Drift Wedding/);
  assert.match(markup, /Review questionnaire sync/);
  assert.match(markup, /Agent task output is missing source citation/);
  assert.match(markup, /Agent Output Drift Wedding/);
  assert.match(markup, /Review agent task output/);
  assert.match(markup, /Invoice payment schedule does not match invoice total/);
  assert.match(markup, /INV-SCHEDULE-DRIFT/);
  assert.match(markup, /Repair payment schedule/);
  assert.match(markup, /Client is not linked to a project/);
  assert.match(markup, /Bailey Bickley/);
  assert.match(markup, /bailey@example.com/);
  assert.match(markup, /Link an existing client/);
  assert.match(markup, /Create or link project/);
  assert.match(markup, /Use studio_get_client_context first/);

  console.log("data health page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
