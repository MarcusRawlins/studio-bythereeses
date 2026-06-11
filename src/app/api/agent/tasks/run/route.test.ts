import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-task-run-route-"));
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
  const now = "2026-06-01T23:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, source_type, source_id, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'discovery_call', 'Discovery call',
      'Discovery source notes for the agent.', 'call_transcript', 'call-run-1', ?, ?
    )
  `).run(now, now);

  const setup = await enableSixFigureWorkflowForProject({
    projectId: "project-1",
    stepKeys: ["proposal-retainer-package"],
  });
  const queued = await queueProjectWorkflowSteps(setup.run.id);
  const task = queued.queuedTasks[0];

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/tasks/run", {
    method: "POST",
  }));
  assert.equal(unauthorized.status, 401);

  const response = await route.POST(request("https://studio.bythereeses.com/api/agent/tasks/run", {
    method: "POST",
    body: JSON.stringify({
      taskId: task.id,
      projectId: "project-1",
      assignedAgent: "Proposal Agent",
    }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.agentTaskRun.agentTask.id, task.id);
  assert.equal(body.agentTaskRun.agentTask.status, "in_progress");
  assert.equal(body.agentTaskRun.projectContext.project.id, "project-1");
  assert.equal(body.agentTaskRun.projectContext.sources[0].id, "source-1");
  assert.equal(body.agentTaskRun.workflow.step.stepKey, "proposal-retainer-package");
  assert.equal(body.agentTaskRun.executionContract.completion.mcpTool, "studio_submit_workflow_task_result");
  assert.equal(body.agentTaskRun.executionContract.completion.restEndpoint, `/api/agent/tasks/${task.id}/workflow-result`);
  assert.deepEqual(database.prepare(`
    SELECT status
    FROM project_workflow_steps
    WHERE id = ?
  `).get(queued.steps[0].id), { status: "in_progress" });

  const resumed = await route.POST(request("https://studio.bythereeses.com/api/agent/tasks/run", {
    method: "POST",
    body: JSON.stringify({
      taskId: task.id,
      projectId: "project-1",
      assignedAgent: "Proposal Agent",
    }),
  }));
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).agentTaskRun.agentTask.status, "in_progress");

  console.log("agent task run route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
