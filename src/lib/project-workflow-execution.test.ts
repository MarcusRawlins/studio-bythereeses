import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-workflow-execution-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { claimNextAgentTask } = await import("./agent-tasks");
  const { enableSixFigureWorkflowForProject, queueProjectWorkflowSteps } = await import("./project-workflow-automation");
  const { completeProjectWorkflowAgentTask } = await import("./project-workflow-execution");
  const database = rawDb();
  const now = "2026-06-01T22:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);

  const setup = await enableSixFigureWorkflowForProject({
    projectId: "project-1",
    stepKeys: ["lead-introduction-text"],
  });
  const queued = await queueProjectWorkflowSteps(setup.run.id);
  const task = queued.queuedTasks[0];

  const claimed = await claimNextAgentTask({
    taskId: task.id,
    projectId: "project-1",
    assignedAgent: "Communications Agent",
  });
  assert.equal(claimed?.status, "in_progress");
  assert.deepEqual(database.prepare(`
    SELECT status
    FROM project_workflow_steps
    WHERE id = ?
  `).get(queued.steps[0].id), { status: "in_progress" });

  const wrongAgent = await assert.rejects(
    () => completeProjectWorkflowAgentTask(task.id, {
      assignedAgent: "Timeline Agent",
      outputBody: "Timeline agent should not complete communications work.",
    }),
    /Agent task is assigned to a different agent/,
  );
  assert.equal(wrongAgent, undefined);

  const result = await completeProjectWorkflowAgentTask(task.id, {
    assignedAgent: "Communications Agent",
    outputTitle: "Day 1 intro text draft",
    outputBody: "Hi Alex, thank you so much for reaching out. I would love to hear more about what you are dreaming up.",
    outputSummary: "Drafted the Day 1 introduction text for approval.",
    outputKind: "workflow_draft",
    metadata: { channel: "sms", approvalRequired: true },
  });

  assert.equal(result.agentTask.status, "completed");
  assert.equal(result.agentTask.outputJson, JSON.stringify({
    projectId: "project-1",
    projectSourceId: result.projectSource.id,
    workflowRunId: setup.run.id,
    workflowStepId: queued.steps[0].id,
    workflowStepKey: "lead-introduction-text",
  }));
  assert.equal(result.workflowStep?.status, "completed");
  assert.equal(result.workflowRun?.status, "completed");
  assert.deepEqual(database.prepare(`
    SELECT kind, title, body, summary, captured_by, source_type, source_id
    FROM project_sources
    WHERE id = ?
  `).get(result.projectSource.id), {
    kind: "workflow_draft",
    title: "Day 1 intro text draft",
    body: "Hi Alex, thank you so much for reaching out. I would love to hear more about what you are dreaming up.",
    summary: "Drafted the Day 1 introduction text for approval.",
    captured_by: "Communications Agent",
    source_type: "project_workflow_step",
    source_id: queued.steps[0].id,
  });

  const activity = database.prepare(`
    SELECT action, actor_type, actor_name, metadata
    FROM activity_logs
    WHERE action = 'project_workflow.step_completed_by_agent'
  `).get() as { action: string; actor_type: string; actor_name: string; metadata: string };
  assert.equal(activity.actor_name, "Communications Agent");
  assert.deepEqual(JSON.parse(activity.metadata), {
    workflowRunId: setup.run.id,
    workflowStepId: queued.steps[0].id,
    workflowStepKey: "lead-introduction-text",
    agentTaskId: task.id,
    projectSourceId: result.projectSource.id,
  });

  console.log("project workflow execution tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
