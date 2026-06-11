import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-workflow-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-06-01T16:30:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);

  const setupForm = new FormData();
  setupForm.set("_action", "setup");
  setupForm.append("stepKey", "lead-introduction-text");
  setupForm.append("stepKey", "day-1-call");

  const setupResponse = await route.POST(new Request("https://studio.bythereeses.com/api/projects/project-1/workflows", {
    method: "POST",
    body: setupForm,
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(setupResponse.status, 303);
  assert.equal(setupResponse.headers.get("location"), "https://studio.bythereeses.com/projects/project-1?saved=workflow");
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM agent_tasks").get(), { count: 0 });

  const run = database.prepare("SELECT id, selected_step_keys_json FROM project_workflow_runs WHERE project_id = ?").get("project-1") as {
    id: string;
    selected_step_keys_json: string;
  };
  assert.deepEqual(JSON.parse(run.selected_step_keys_json), ["lead-introduction-text", "day-1-call"]);

  const queueForm = new FormData();
  queueForm.set("_action", "queue");
  queueForm.set("workflowRunId", run.id);
  queueForm.append("stepKey", "lead-introduction-text");

  const queueResponse = await route.POST(new Request("https://studio.bythereeses.com/api/projects/project-1/workflows", {
    method: "POST",
    body: queueForm,
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(queueResponse.status, 303);
  assert.equal(queueResponse.headers.get("location"), "https://studio.bythereeses.com/projects/project-1?saved=workflow-queued");
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM agent_tasks").get(), { count: 1 });

  console.log("project workflow route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
