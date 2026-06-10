import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-workflows-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "test-token";

function agentRequest(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { GET, POST, PATCH } = await import("./route");
  const database = rawDb();
  const now = "2026-06-01T17:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?),
      ('project-2', 'Other Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now, now, now);

  const listResponse = await GET(agentRequest("https://studio.test/api/agent/projects/project-1/workflows"), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json();
  assert.equal(listBody.availableSteps.length > 5, true);
  assert.deepEqual(listBody.workflowRuns, []);

  const setupResponse = await POST(agentRequest("https://studio.test/api/agent/projects/project-1/workflows", {
    method: "POST",
    body: JSON.stringify({ stepKeys: ["lead-introduction-text", "proposal-retainer-package"] }),
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(setupResponse.status, 201);
  const setupBody = await setupResponse.json();
  assert.equal(setupBody.workflowRun.workflowKey, "six-figure-maximized-workflow");
  assert.deepEqual(setupBody.workflowSteps.map((step: { stepKey: string; status: string }) => ({
    stepKey: step.stepKey,
    status: step.status,
  })), [
    { stepKey: "lead-introduction-text", status: "configured" },
    { stepKey: "proposal-retainer-package", status: "configured" },
  ]);
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM agent_tasks WHERE source_type = 'project_workflow_step'").get(), { count: 0 });

  const wrongProjectQueue = await PATCH(agentRequest("https://studio.test/api/agent/projects/project-2/workflows", {
    method: "PATCH",
    body: JSON.stringify({
      workflowRunId: setupBody.workflowRun.id,
      stepKeys: ["proposal-retainer-package"],
    }),
  }), { params: Promise.resolve({ id: "project-2" }) });
  assert.equal(wrongProjectQueue.status, 400);
  assert.deepEqual(await wrongProjectQueue.json(), { error: "Workflow run does not belong to this project." });
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM agent_tasks WHERE source_type = 'project_workflow_step'").get(), { count: 0 });

  const queueResponse = await PATCH(agentRequest("https://studio.test/api/agent/projects/project-1/workflows", {
    method: "PATCH",
    body: JSON.stringify({
      workflowRunId: setupBody.workflowRun.id,
      stepKeys: ["proposal-retainer-package"],
    }),
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(queueResponse.status, 200);
  const queueBody = await queueResponse.json();
  assert.deepEqual(queueBody.queuedTasks.map((task: { title: string; assignedAgent: string }) => ({
    title: task.title,
    assignedAgent: task.assignedAgent,
  })), [{ title: "Create proposal and retainer task", assignedAgent: "Proposal Agent" }]);

  const unauthorized = await POST(new Request("https://studio.test/api/agent/projects/project-1/workflows", {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ stepKeys: ["lead-introduction-text"] }),
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(unauthorized.status, 401);

  console.log("agent workflow route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
