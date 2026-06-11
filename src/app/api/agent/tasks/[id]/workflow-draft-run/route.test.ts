import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-workflow-draft-run-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "agent-token";

function request(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      authorization: "Bearer agent-token",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { enableSixFigureWorkflowForProject, queueProjectWorkflowSteps } = await import("@/lib/project-workflow-automation");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-06-01T23:20:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, preferred_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'Lex', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, venue_name, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', '2026-10-10', 'The Harbor Room', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, source_type, source_id, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'inquiry', 'Inquiry notes',
      'They care about candid family moments and a calm planning process.',
      'Candid family moments and calm planning process.', 'inquiry_form', 'inq-1', ?, ?
    )
  `).run(now, now);

  const setup = await enableSixFigureWorkflowForProject({
    projectId: "project-1",
    stepKeys: ["lead-introduction-text"],
  });
  const queued = await queueProjectWorkflowSteps(setup.run.id);
  const task = queued.queuedTasks[0];

  const unauthorized = await route.POST(new Request(`https://studio.bythereeses.com/api/agent/tasks/${task.id}/workflow-draft-run`, {
    method: "POST",
  }), { params: Promise.resolve({ id: task.id }) });
  assert.equal(unauthorized.status, 401);

  const preview = await route.POST(request(`https://studio.bythereeses.com/api/agent/tasks/${task.id}/workflow-draft-run`, {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      assignedAgent: "Communications Agent",
      previewOnly: true,
    }),
  }), { params: Promise.resolve({ id: task.id }) });
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.equal(previewBody.workflowDraftRun.completed, false);
  assert.match(previewBody.workflowDraftRun.draft.outputBody, /Hi Lex/);
  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM project_sources
    WHERE source_type = 'project_workflow_step'
  `).get(), { count: 0 });

  const response = await route.POST(request(`https://studio.bythereeses.com/api/agent/tasks/${task.id}/workflow-draft-run`, {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      assignedAgent: "Communications Agent",
    }),
  }), { params: Promise.resolve({ id: task.id }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.workflowDraftRun.completed, true);
  assert.equal(body.workflowDraftRun.completion.agentTask.status, "completed");
  assert.equal(body.workflowDraftRun.completion.workflowStep.status, "completed");
  assert.match(body.workflowDraftRun.draft.outputBody, /The Harbor Room/);
  assert.deepEqual(database.prepare(`
    SELECT kind, title, captured_by, source_type, source_id
    FROM project_sources
    WHERE source_type = 'project_workflow_step'
  `).get(), {
    kind: "workflow_draft",
    title: "Draft Day 1 introduction text - draft",
    captured_by: "Communications Agent",
    source_type: "project_workflow_step",
    source_id: queued.steps[0].id,
  });

  console.log("agent workflow draft run route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
