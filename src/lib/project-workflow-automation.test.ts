import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-workflows-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const {
    enableSixFigureWorkflowForProject,
    listProjectWorkflowRuns,
    queueProjectWorkflowSteps,
    sixFigureAutomationSteps,
  } = await import("./project-workflow-automation");
  const database = rawDb();
  const now = "2026-06-01T16:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', '2026-10-10', ?, ?)
  `).run(now, now);

  assert.equal(sixFigureAutomationSteps.length > 5, true);

  const setup = await enableSixFigureWorkflowForProject({
    projectId: "project-1",
    stepKeys: ["lead-introduction-text", "day-1-call"],
  });

  assert.equal(setup.run.projectId, "project-1");
  assert.equal(setup.run.workflowKey, "six-figure-maximized-workflow");
  assert.equal(setup.run.status, "active");
  assert.deepEqual(setup.steps.map((step) => step.stepKey), ["lead-introduction-text", "day-1-call"]);
  assert.deepEqual(setup.steps.map((step) => step.status), ["configured", "configured"]);
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM agent_tasks").get(), { count: 0 });

  const listed = await listProjectWorkflowRuns("project-1");
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].steps.map((step) => ({
    key: step.step.stepKey,
    title: step.definition.title,
    enabled: step.step.automationEnabled,
    agentTaskId: step.step.agentTaskId,
  })), [
    {
      key: "lead-introduction-text",
      title: "Draft Day 1 introduction text",
      enabled: true,
      agentTaskId: null,
    },
    {
      key: "day-1-call",
      title: "Prepare Day 1 call",
      enabled: true,
      agentTaskId: null,
    },
  ]);

  const queued = await queueProjectWorkflowSteps(setup.run.id, { stepKeys: ["day-1-call"] });
  assert.equal(queued.queuedTasks.length, 1);
  assert.equal(queued.steps.find((step) => step.stepKey === "day-1-call")?.status, "queued");
  assert.equal(queued.steps.find((step) => step.stepKey === "lead-introduction-text")?.status, "configured");

  const taskRows = database.prepare(`
    SELECT title, assigned_agent, source_type, source_id, status
    FROM agent_tasks
    ORDER BY created_at
  `).all() as Array<{
    title: string;
    assigned_agent: string;
    source_type: string;
    source_id: string;
    status: string;
  }>;
  assert.deepEqual(taskRows, [
    {
      title: "Prepare Day 1 call",
      assigned_agent: "Communications Agent",
      source_type: "project_workflow_step",
      source_id: queued.steps.find((step) => step.stepKey === "day-1-call")?.id,
      status: "queued",
    },
  ]);

  await queueProjectWorkflowSteps(setup.run.id, { stepKeys: ["day-1-call"] });
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM agent_tasks").get(), { count: 1 });

  const replacement = await enableSixFigureWorkflowForProject({
    projectId: "project-1",
    stepKeys: ["review-request"],
  });
  assert.deepEqual(replacement.steps.map((step) => step.stepKey), ["review-request"]);
  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM project_workflow_steps
    WHERE workflow_run_id = ?
  `).get(setup.run.id), { count: 1 });

  console.log("project workflow automation tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
