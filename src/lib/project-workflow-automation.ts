import { db } from "@/db/client";
import { agentTasks, projectWorkflowRuns, projectWorkflowSteps, projects } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { and, asc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export const sixFigureWorkflowKey = "six-figure-maximized-workflow";
export const sixFigureWorkflowName = "The Reeses Studio Workflow";

export type WorkflowStepDefinition = {
  key: string;
  title: string;
  triggerLabel: string;
  assignedAgent: string;
  instructions: string;
  sortOrder: number;
};

export const postWeddingDeliveryStepKeys = [
  "day-after-touchpoint",
  "sneak-peek-delivery",
  "gallery-delivery",
  "review-request",
  "referral-follow-up",
] as const;

export type PostWeddingDeliveryStepKey = (typeof postWeddingDeliveryStepKeys)[number];

export const sixFigureAutomationSteps: WorkflowStepDefinition[] = [
  {
    key: "lead-introduction-text",
    title: "Draft Day 1 introduction text",
    triggerLabel: "New inquiry received",
    assignedAgent: "Communications Agent",
    instructions: "Draft a short, personal Day 1 introduction text for this inquiry. Use canonical project/client context. Do not send it automatically; create a draft for Tyler to approve.",
    sortOrder: 10,
  },
  {
    key: "day-1-call",
    title: "Prepare Day 1 call",
    triggerLabel: "New inquiry received",
    assignedAgent: "Communications Agent",
    instructions: "Prepare a Day 1 call brief with talking points, open questions, and what to log afterward. Do not place the call automatically.",
    sortOrder: 20,
  },
  {
    key: "day-2-follow-up",
    title: "Draft Day 2 follow-up",
    triggerLabel: "No booked call after Day 1",
    assignedAgent: "Communications Agent",
    instructions: "Draft a warm Day 2 follow-up email/SMS and recommend the next best channel. Do not send automatically.",
    sortOrder: 30,
  },
  {
    key: "final-lead-follow-up",
    title: "Draft final lead follow-up",
    triggerLabel: "Lead still unresponsive after follow-up cadence",
    assignedAgent: "Communications Agent",
    instructions: "Draft a final close-the-loop follow-up that preserves goodwill and leaves the door open. Do not send automatically.",
    sortOrder: 40,
  },
  {
    key: "pre-consultation-prep",
    title: "Prepare pre-consultation touchpoints",
    triggerLabel: "Discovery call booked",
    assignedAgent: "Studio Agent",
    instructions: "Create a pre-consultation checklist for this project: confirmation, source review, personal touchpoint ideas, and any missing context Tyler should gather.",
    sortOrder: 50,
  },
  {
    key: "get-to-know-you-questionnaire",
    title: "Prepare get-to-know-you questionnaire",
    triggerLabel: "Before discovery/design call",
    assignedAgent: "Studio Agent",
    instructions: "Prepare or select a get-to-know-you questionnaire for this project. Use The Reeses tone and keep it useful for proposal and timeline context.",
    sortOrder: 60,
  },
  {
    key: "proposal-retainer-package",
    title: "Create proposal and retainer task",
    triggerLabel: "Discovery call completed",
    assignedAgent: "Proposal Agent",
    instructions: "From the discovery-call source material, draft the proposal package, contract-ready notes, and retainer invoice plan. Cite canonical project sources on generated records.",
    sortOrder: 70,
  },
  {
    key: "booked-client-onboarding",
    title: "Prepare booked-client onboarding",
    triggerLabel: "Project booked",
    assignedAgent: "Studio Agent",
    instructions: "Create a booked-client onboarding checklist: thank-you touchpoint, next planning milestone, questionnaire timing, and open project facts to confirm.",
    sortOrder: 80,
  },
  {
    key: "timeline-questionnaire",
    title: "Prepare timeline questionnaire and planning call",
    triggerLabel: "Planning phase",
    assignedAgent: "Timeline Agent",
    instructions: "Prepare the timeline questionnaire and planning-call handoff. If questionnaire answers already exist, summarize missing details for Tyler.",
    sortOrder: 90,
  },
  {
    key: "one-month-prior",
    title: "Prepare one-month-prior check-in",
    triggerLabel: "One month before event",
    assignedAgent: "Timeline Agent",
    instructions: "Draft a one-month-prior logistics check-in and review the timeline, locations, vendors, family photo needs, and unresolved project fields.",
    sortOrder: 100,
  },
  {
    key: "day-after-touchpoint",
    title: "Prepare day-after touchpoint",
    triggerLabel: "Day after wedding or session",
    assignedAgent: "Communications Agent",
    instructions: "Draft a day-after message celebrating the event and setting expectations for sneak peek and gallery timing. Keep it personal and brief. Do not send automatically.",
    sortOrder: 105,
  },
  {
    key: "sneak-peek-delivery",
    title: "Prepare sneak peek delivery",
    triggerLabel: "Sneak peek ready to share",
    assignedAgent: "Communications Agent",
    instructions: "Draft the sneak peek delivery message with gallery link context, what the client should expect next, and any album or print upsell notes for Tyler to review. Do not send automatically.",
    sortOrder: 106,
  },
  {
    key: "gallery-delivery",
    title: "Prepare full gallery delivery",
    triggerLabel: "Full gallery ready to deliver",
    assignedAgent: "Communications Agent",
    instructions: "Draft the full gallery delivery message with access instructions, download or print guidance, and a warm close to the project experience. Do not send automatically.",
    sortOrder: 107,
  },
  {
    key: "review-request",
    title: "Draft review request",
    triggerLabel: "After positive delivery experience",
    assignedAgent: "Communications Agent",
    instructions: "Draft a review request after delivery. Thank the client personally, name what you enjoyed serving, include the review link, and keep it warm and low-pressure. Do not send automatically.",
    sortOrder: 110,
  },
  {
    key: "referral-follow-up",
    title: "Draft referral follow-up",
    triggerLabel: "After review or strong positive delivery moment",
    assignedAgent: "Communications Agent",
    instructions: "Draft a referral follow-up for clients who loved the experience. Mention how referrals help future couples find the right photographer and keep the ask personal and low-pressure. Do not send automatically.",
    sortOrder: 115,
  },
  {
    key: "anniversary-touchpoint",
    title: "Prepare anniversary touchpoint",
    triggerLabel: "Anniversary",
    assignedAgent: "Communications Agent",
    instructions: "Draft an anniversary touchpoint for this client/project. Keep it personal and aligned with The Reeses voice.",
    sortOrder: 120,
  },
];

type EnableWorkflowInput = {
  projectId: string;
  stepKeys?: string[];
  createdBy?: string;
};

type QueueWorkflowStepsInput = {
  stepKeys?: string[];
};

function selectedDefinitions(stepKeys?: string[]) {
  const requested = new Set((stepKeys ?? []).filter(Boolean));
  const definitions = requested.size
    ? sixFigureAutomationSteps.filter((step) => requested.has(step.key))
    : sixFigureAutomationSteps;
  if (!definitions.length) throw new Error("Choose at least one workflow step.");
  if (requested.size && definitions.length !== requested.size) {
    throw new Error("Unsupported workflow step selected.");
  }
  return definitions;
}

async function assertProjectExists(projectId: string) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new Error("Project not found.");
}

function safeRevalidateProject(projectId: string) {
  try {
    revalidatePath(`/projects/${projectId}`);
    revalidatePath("/inbox");
  } catch (error) {
    if (error instanceof Error && error.message.includes("static generation store missing")) return;
    throw error;
  }
}

export async function enableSixFigureWorkflowForProject({
  projectId,
  stepKeys,
  createdBy = "Tyler",
}: EnableWorkflowInput) {
  await assertProjectExists(projectId);
  const definitions = selectedDefinitions(stepKeys);
  const selectedStepKeys = definitions.map((step) => step.key);
  const now = new Date().toISOString();
  const existing = await db.query.projectWorkflowRuns.findFirst({
    where: and(
      eq(projectWorkflowRuns.projectId, projectId),
      eq(projectWorkflowRuns.workflowKey, sixFigureWorkflowKey),
    ),
  });
  const runId = existing?.id ?? crypto.randomUUID();

  if (existing) {
    await db.update(projectWorkflowRuns).set({
      workflowName: sixFigureWorkflowName,
      status: "active",
      selectedStepKeysJson: JSON.stringify(selectedStepKeys),
      createdBy,
      updatedAt: now,
    }).where(eq(projectWorkflowRuns.id, existing.id));
    await db.delete(projectWorkflowSteps).where(eq(projectWorkflowSteps.workflowRunId, existing.id));
  } else {
    await db.insert(projectWorkflowRuns).values({
      id: runId,
      projectId,
      workflowKey: sixFigureWorkflowKey,
      workflowName: sixFigureWorkflowName,
      status: "active",
      selectedStepKeysJson: JSON.stringify(selectedStepKeys),
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
  }

  await db.insert(projectWorkflowSteps).values(definitions.map((step) => ({
    id: crypto.randomUUID(),
    workflowRunId: runId,
    projectId,
    stepKey: step.key,
    title: step.title,
    instructions: step.instructions,
    assignedAgent: step.assignedAgent,
    triggerLabel: step.triggerLabel,
    status: "configured",
    automationEnabled: true,
    sortOrder: step.sortOrder,
    createdAt: now,
    updatedAt: now,
  })));

  await logActivity({
    projectId,
    action: "project_workflow.configured",
    actorType: "admin",
    actorName: "The Reeses Studio",
    metadata: { workflowKey: sixFigureWorkflowKey, selectedStepKeys },
  });
  safeRevalidateProject(projectId);

  const run = await db.query.projectWorkflowRuns.findFirst({ where: eq(projectWorkflowRuns.id, runId) });
  const steps = await db.query.projectWorkflowSteps.findMany({
    where: eq(projectWorkflowSteps.workflowRunId, runId),
    orderBy: asc(projectWorkflowSteps.sortOrder),
  });
  if (!run) throw new Error("Workflow setup failed.");
  return { run, steps };
}

export async function queueProjectWorkflowSteps(runId: string, { stepKeys }: QueueWorkflowStepsInput = {}) {
  const run = await db.query.projectWorkflowRuns.findFirst({ where: eq(projectWorkflowRuns.id, runId) });
  if (!run) throw new Error("Workflow run not found.");
  if (run.status !== "active") throw new Error("Workflow run is not active.");

  const filters = [eq(projectWorkflowSteps.workflowRunId, runId), eq(projectWorkflowSteps.automationEnabled, true)];
  if (stepKeys?.length) filters.push(inArray(projectWorkflowSteps.stepKey, stepKeys));
  const stepsToQueue = await db.query.projectWorkflowSteps.findMany({
    where: and(...filters),
    orderBy: asc(projectWorkflowSteps.sortOrder),
  });

  const now = new Date().toISOString();
  const queuedTasks: Array<typeof agentTasks.$inferSelect> = [];
  for (const step of stepsToQueue) {
    if (step.agentTaskId || step.status !== "configured") continue;
    const taskId = crypto.randomUUID();
    await db.insert(agentTasks).values({
      id: taskId,
      projectId: step.projectId,
      title: step.title,
      instructions: `${step.instructions}\n\nWorkflow: ${run.workflowName}\nStep: ${step.triggerLabel ?? step.title}`,
      status: "queued",
      priority: "normal",
      requestedBy: run.createdBy,
      assignedAgent: step.assignedAgent,
      sourceType: "project_workflow_step",
      sourceId: step.id,
      createdAt: now,
      updatedAt: now,
    });
    await db.update(projectWorkflowSteps).set({
      status: "queued",
      agentTaskId: taskId,
      updatedAt: now,
    }).where(eq(projectWorkflowSteps.id, step.id));

    const task = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, taskId) });
    if (task) queuedTasks.push(task);
  }

  if (queuedTasks.length) {
    await db.update(projectWorkflowRuns).set({ startedAt: run.startedAt ?? now, updatedAt: now }).where(eq(projectWorkflowRuns.id, runId));
    await logActivity({
      projectId: run.projectId,
      action: "project_workflow.steps_queued",
      actorType: "admin",
      actorName: "The Reeses Studio",
      metadata: { workflowRunId: runId, taskIds: queuedTasks.map((task) => task.id) },
    });
  }
  safeRevalidateProject(run.projectId);

  const steps = await db.query.projectWorkflowSteps.findMany({
    where: eq(projectWorkflowSteps.workflowRunId, runId),
    orderBy: asc(projectWorkflowSteps.sortOrder),
  });
  return { run: { ...run, startedAt: run.startedAt ?? (queuedTasks.length ? now : run.startedAt) }, steps, queuedTasks };
}

export async function queueProjectWorkflowStepsForProject(projectId: string, runId: string, input: QueueWorkflowStepsInput = {}) {
  const run = await db.query.projectWorkflowRuns.findFirst({ where: eq(projectWorkflowRuns.id, runId) });
  if (!run || run.projectId !== projectId) throw new Error("Workflow run does not belong to this project.");
  return queueProjectWorkflowSteps(runId, input);
}

export async function listProjectWorkflowRuns(projectId: string) {
  const runs = await db.query.projectWorkflowRuns.findMany({
    where: eq(projectWorkflowRuns.projectId, projectId),
    orderBy: asc(projectWorkflowRuns.createdAt),
  });
  const definitionsByKey = new Map(sixFigureAutomationSteps.map((step) => [step.key, step]));

  return Promise.all(runs.map(async (run) => {
    const steps = await db.query.projectWorkflowSteps.findMany({
      where: eq(projectWorkflowSteps.workflowRunId, run.id),
      orderBy: asc(projectWorkflowSteps.sortOrder),
    });
    return {
      run,
      steps: steps.map((step) => ({
        step,
        definition: definitionsByKey.get(step.stepKey) ?? {
          key: step.stepKey,
          title: step.title,
          triggerLabel: step.triggerLabel ?? step.title,
          assignedAgent: step.assignedAgent,
          instructions: step.instructions,
          sortOrder: step.sortOrder,
        },
      })),
    };
  }));
}

export async function enableSixFigureWorkflowFromForm(projectId: string, formData: FormData) {
  const stepKeys = formData.getAll("stepKey").map(String).filter(Boolean);
  const start = formData.get("_action") === "start";
  const result = await enableSixFigureWorkflowForProject({ projectId, stepKeys });
  if (start) {
    await queueProjectWorkflowSteps(result.run.id);
  }
  return result;
}

export async function queueProjectWorkflowStepsFromForm(projectId: string, formData: FormData) {
  const runId = String(formData.get("workflowRunId") ?? "").trim();
  if (!runId) throw new Error("Workflow run is required.");
  const stepKeys = formData.getAll("stepKey").map(String).filter(Boolean);
  return queueProjectWorkflowStepsForProject(projectId, runId, { stepKeys: stepKeys.length ? stepKeys : undefined });
}
