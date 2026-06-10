import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-data-health-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { listStudioDataHealth } = await import("./data-health");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-primary', 'Alex', 'Taylor', 'alex@example.com', ?, ?),
      ('client-orphan', 'Bailey', 'Bickley', 'bailey@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-ok', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-unlinked', 'Unlinked Wedding', 'wedding', 'inquiry', 'active', ?, ?),
      ('project-no-primary', 'No Primary Wedding', 'wedding', 'inquiry', 'active', ?, ?),
      ('project-questionnaire-drift', 'Questionnaire Drift Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-agent-output-drift', 'Agent Output Drift Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now, now, now, now, now, now, now);
  database.prepare(`
    UPDATE projects
    SET event_date = '2026-08-01', venue_name = 'Old Venue'
    WHERE id = 'project-questionnaire-drift'
  `).run();
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
    {
      questionId: "question-venue",
      title: "Venue name",
      type: "short_text",
      required: false,
      value: "The Garden House",
    },
  ]), now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-ok', 'project-ok', 'client-primary', 'primary', 1, ?),
      ('participant-no-primary', 'project-no-primary', 'client-primary', 'planner', 0, ?),
      ('participant-questionnaire-drift', 'project-questionnaire-drift', 'client-primary', 'primary', 1, ?),
      ('participant-agent-output-drift', 'project-agent-output-drift', 'client-primary', 'primary', 1, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, source_type, source_id,
      created_at, updated_at
    ) VALUES (
      'source-agent-output-drift', 'project-agent-output-drift', 'discovery_call',
      'Discovery call for agent output drift', 'Discovery notes for source-aware output.',
      'Source summary', 'Studio UI', 'studio_project', 'manual-source-agent-output-drift',
      ?, ?
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
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      created_at, updated_at
    ) VALUES
      ('invoice-paid-drift', 'project-ok', 'INV-PAID-DRIFT', 'partially_paid', 100000, 30000, ?, ?),
      ('invoice-schedule-drift', 'project-ok', 'INV-SCHEDULE-DRIFT', 'sent', 120000, 0, ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_amount_cents,
      created_at, updated_at
    ) VALUES
      ('payment-paid-drift', 'invoice-paid-drift', 'Retainer', 30000, '2026-06-01', 'paid', 20000, ?, ?),
      ('payment-paid-drift-open', 'invoice-paid-drift', 'Final balance', 70000, '2026-08-01', 'pending', 0, ?, ?),
      ('payment-schedule-drift', 'invoice-schedule-drift', 'Retainer', 50000, '2026-06-01', 'pending', 0, ?, ?)
  `).run(now, now, now, now, now, now);

  const health = await listStudioDataHealth();

  assert.deepEqual(health.summary, {
    projectCount: 5,
    clientCount: 2,
    invoiceCount: 2,
    issueCount: 7,
    highIssueCount: 6,
    mediumIssueCount: 1,
  });
  assert.deepEqual(health.issues.map((issue) => issue.type), [
    "project_without_client",
    "project_without_primary_client",
    "questionnaire_project_field_mismatch",
    "agent_task_output_source_mismatch",
    "invoice_paid_amount_mismatch",
    "invoice_payment_schedule_mismatch",
    "client_without_project",
  ]);
  assert.deepEqual(health.issues[0].project, { id: "project-unlinked", name: "Unlinked Wedding" });
  assert.deepEqual(health.issues[0].repair, {
    label: "Link an existing client",
    href: "/projects/project-unlinked",
    agentWorkflow: "Use studio_search_projects and studio_get_client_context to identify the correct existing client, then call studio_link_client_to_project. If that client should be primary, call studio_update_project with primaryClientId.",
    agentTools: ["studio_search_projects", "studio_get_client_context", "studio_link_client_to_project", "studio_update_project"],
  });
  assert.deepEqual(health.issues[1].project, { id: "project-no-primary", name: "No Primary Wedding" });
  assert.deepEqual(health.issues[1].repair, {
    label: "Choose primary client",
    href: "/projects/project-no-primary",
    agentWorkflow: "Use studio_get_project_context to inspect linked clients, then call studio_update_project with primaryClientId for the correct linked client.",
    agentTools: ["studio_get_project_context", "studio_update_project"],
  });
  assert.deepEqual(health.issues[2].project, { id: "project-questionnaire-drift", name: "Questionnaire Drift Wedding" });
  assert.deepEqual(health.issues[2].repair, {
    label: "Review questionnaire sync",
    href: "/projects/project-questionnaire-drift",
    agentWorkflow: "Use studio_get_project_context to compare submitted questionnaire answers with the canonical project fields, then call studio_update_project with the correct date, venue, and location facts.",
    agentTools: ["studio_get_project_context", "studio_update_project"],
  });
  assert.match(health.issues[2].detail, /Wedding date/);
  assert.match(health.issues[2].detail, /Venue name/);
  assert.deepEqual(health.issues[3].project, { id: "project-agent-output-drift", name: "Agent Output Drift Wedding" });
  assert.deepEqual(health.issues[3].repair, {
    label: "Review agent task output",
    href: "/projects/project-agent-output-drift",
    agentWorkflow: "Use studio_get_project_context and studio_list_agent_tasks to inspect the source-linked task, then update the generated output or task result so every cited proposal, invoice, timeline item, event, location, communication, or expense points back to the same project source.",
    agentTools: ["studio_get_project_context", "studio_list_agent_tasks", "studio_update_agent_task", "studio_update_proposal"],
  });
  assert.match(health.issues[3].detail, /Create proposal from discovery call/);
  assert.match(health.issues[3].detail, /proposal proposal-uncited-output/);
  assert.deepEqual(health.issues[4].invoice, {
    id: "invoice-paid-drift",
    name: "INV-PAID-DRIFT",
  });
  assert.deepEqual(health.issues[4].project, { id: "project-ok", name: "Alex Wedding" });
  assert.deepEqual(health.issues[4].repair, {
    label: "Reconcile payment ledger",
    href: "/invoices/invoice-paid-drift",
    agentWorkflow: "Use studio_get_project_context and the invoice payment ledger to compare paid invoice payments with the invoice summary, then use studio_record_invoice_payment or the invoice payment editor to correct the canonical payment rows.",
    agentTools: ["studio_get_project_context", "studio_record_invoice_payment", "studio_update_invoice_payment"],
  });
  assert.deepEqual(health.issues[5].invoice, {
    id: "invoice-schedule-drift",
    name: "INV-SCHEDULE-DRIFT",
  });
  assert.deepEqual(health.issues[5].project, { id: "project-ok", name: "Alex Wedding" });
  assert.deepEqual(health.issues[5].repair, {
    label: "Repair payment schedule",
    href: "/invoices/invoice-schedule-drift",
    agentWorkflow: "Use studio_get_project_context to inspect the invoice and proposal scope, then update the invoice payment schedule so scheduled payments equal the canonical invoice total.",
    agentTools: ["studio_get_project_context", "studio_update_invoice"],
  });
  assert.deepEqual(health.issues[6].client, {
    id: "client-orphan",
    name: "Bailey Bickley",
    email: "bailey@example.com",
  });
  assert.deepEqual(health.issues[6].repair, {
    label: "Create or link project",
    href: "/clients/client-orphan",
    agentWorkflow: "Use studio_get_client_context first. If this client belongs to an existing project, call studio_link_client_to_project. If no project exists yet, call studio_create_project with primaryClient.clientId.",
    agentTools: ["studio_get_client_context", "studio_search_projects", "studio_link_client_to_project", "studio_create_project"],
  });

  console.log("data health tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
