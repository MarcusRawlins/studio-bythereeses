import { db } from "@/db/client";
import { agentTasks, projectWorkflowRuns, projectWorkflowSteps } from "@/db/schema";
import { createProjectSourceFromAgent } from "@/lib/agent-sources";
import { claimNextAgentTask, hydrateAgentTaskLinkedSource, updateAgentTaskStatus } from "@/lib/agent-tasks";
import { logActivity } from "@/lib/activity";
import { and, eq } from "drizzle-orm";

type CompleteProjectWorkflowAgentTaskInput = {
  assignedAgent?: string | null;
  outputTitle?: string | null;
  outputBody: string;
  outputSummary?: string | null;
  outputKind?: string | null;
  metadata?: unknown;
};

function cleanText(value: string | null | undefined) {
  return value?.trim() || null;
}

function metadataObject(value: unknown) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workflow result metadata must be an object.");
  }
  return value as Record<string, unknown>;
}

function assertAgentCanComplete(task: typeof agentTasks.$inferSelect, assignedAgent: string) {
  const assignedToSpecialist = task.assignedAgent && task.assignedAgent !== "The Reeses Studio Agent";
  if (assignedToSpecialist && task.assignedAgent !== assignedAgent) {
    throw new Error("Agent task is assigned to a different agent.");
  }
}

export async function completeProjectWorkflowAgentTask(taskId: string, input: CompleteProjectWorkflowAgentTaskInput) {
  const task = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, taskId) });
  if (!task) throw new Error("Agent task not found.");
  if (!task.projectId || task.sourceType !== "project_workflow_step" || !task.sourceId) {
    throw new Error("Agent task is not linked to a project workflow step.");
  }
  if (["completed", "failed", "cancelled"].includes(task.status)) {
    throw new Error("Terminal agent tasks cannot receive workflow results.");
  }

  const assignedAgent = cleanText(input.assignedAgent) ?? task.assignedAgent ?? "The Reeses Studio Agent";
  assertAgentCanComplete(task, assignedAgent);

  const step = await db.query.projectWorkflowSteps.findFirst({
    where: and(
      eq(projectWorkflowSteps.id, task.sourceId),
      eq(projectWorkflowSteps.projectId, task.projectId),
    ),
  });
  if (!step || step.agentTaskId !== task.id) {
    throw new Error("Workflow step is not linked to this agent task.");
  }

  const run = await db.query.projectWorkflowRuns.findFirst({ where: eq(projectWorkflowRuns.id, step.workflowRunId) });
  if (!run) throw new Error("Workflow run not found.");

  const body = cleanText(input.outputBody);
  if (!body) throw new Error("Workflow result body is required.");

  const claimedTask = task.status === "queued"
    ? await claimNextAgentTask({
      taskId: task.id,
      projectId: task.projectId,
      assignedAgent,
    })
    : task;
  if (!claimedTask) throw new Error("Agent task claim failed.");

  const projectSource = await createProjectSourceFromAgent(task.projectId, {
    kind: cleanText(input.outputKind) ?? "workflow_result",
    title: cleanText(input.outputTitle) ?? `${step.title} draft`,
    body,
    summary: cleanText(input.outputSummary),
    capturedBy: assignedAgent,
    sourceType: "project_workflow_step",
    sourceId: step.id,
    metadata: {
      workflowRunId: run.id,
      workflowKey: run.workflowKey,
      workflowName: run.workflowName,
      workflowStepId: step.id,
      workflowStepKey: step.stepKey,
      agentTaskId: task.id,
      ...metadataObject(input.metadata),
    },
  });

  const updatedTask = await updateAgentTaskStatus(task.id, {
    status: "completed",
    assignedAgent,
    resultSummary: cleanText(input.outputSummary) ?? `Completed ${step.title}.`,
    outputJson: {
      projectId: task.projectId,
      projectSourceId: projectSource.id,
      workflowRunId: run.id,
      workflowStepId: step.id,
      workflowStepKey: step.stepKey,
    },
  });

  const now = new Date().toISOString();
  await db.update(projectWorkflowSteps).set({
    status: "completed",
    updatedAt: now,
  }).where(eq(projectWorkflowSteps.id, step.id));

  const remainingOpenSteps = await db.query.projectWorkflowSteps.findMany({
    where: and(
      eq(projectWorkflowSteps.workflowRunId, run.id),
      eq(projectWorkflowSteps.automationEnabled, true),
    ),
  });
  if (remainingOpenSteps.length && remainingOpenSteps.every((workflowStep) => workflowStep.id === step.id || workflowStep.status === "completed")) {
    await db.update(projectWorkflowRuns).set({
      status: "completed",
      updatedAt: now,
    }).where(eq(projectWorkflowRuns.id, run.id));
  }

  await logActivity({
    projectId: task.projectId,
    action: "project_workflow.step_completed_by_agent",
    actorType: "agent",
    actorName: assignedAgent,
    metadata: {
      workflowRunId: run.id,
      workflowStepId: step.id,
      workflowStepKey: step.stepKey,
      agentTaskId: task.id,
      projectSourceId: projectSource.id,
    },
  });

  const refreshedStep = await db.query.projectWorkflowSteps.findFirst({ where: eq(projectWorkflowSteps.id, step.id) });
  const refreshedRun = await db.query.projectWorkflowRuns.findFirst({ where: eq(projectWorkflowRuns.id, run.id) });

  return {
    agentTask: await hydrateAgentTaskLinkedSource(updatedTask),
    projectSource,
    workflowStep: refreshedStep,
    workflowRun: refreshedRun,
  };
}
