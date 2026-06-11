import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-workflow-result-route-"));
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
  const now = "2026-06-01T22:30:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);

  const setup = await enableSixFigureWorkflowForProject({
    projectId: "project-1",
    stepKeys: ["day-1-call"],
  });
  const queued = await queueProjectWorkflowSteps(setup.run.id);
  const task = queued.queuedTasks[0];

  const unauthorized = await route.POST(new Request(`https://studio.bythereeses.com/api/agent/tasks/${task.id}/workflow-result`, {
    method: "POST",
  }), { params: Promise.resolve({ id: task.id }) });
  assert.equal(unauthorized.status, 401);

  const response = await route.POST(request(`https://studio.bythereeses.com/api/agent/tasks/${task.id}/workflow-result`, {
    method: "POST",
    body: JSON.stringify({
      assignedAgent: "Communications Agent",
      outputTitle: "Day 1 call brief",
      outputBody: "Open by confirming the inquiry source, ask what matters most, and log decision makers before package discussion.",
      outputSummary: "Prepared the Day 1 call brief.",
    }),
  }), { params: Promise.resolve({ id: task.id }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.agentTask.status, "completed");
  assert.equal(body.workflowStep.status, "completed");
  assert.equal(body.projectSource.title, "Day 1 call brief");
  assert.equal(body.projectSource.sourceType, "project_workflow_step");
  assert.equal(body.projectSource.sourceId, queued.steps[0].id);

  assert.deepEqual(database.prepare(`
    SELECT status
    FROM agent_tasks
    WHERE id = ?
  `).get(task.id), { status: "completed" });

  console.log("agent workflow result route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
