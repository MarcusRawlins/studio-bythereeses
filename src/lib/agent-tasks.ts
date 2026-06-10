import { db } from "@/db/client";
import {
  agentTasks,
  activityLogs,
  expenses,
  invoices,
  invoicePayments,
  projectCommunications,
  projectEvents,
  projectLocations,
  projectParticipants,
  projectWorkflowSteps,
  projectSources,
  projectTimelineItems,
  projects,
  proposals,
  questionnaireResponses,
  schedulerBookings,
} from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { requireProjectSourceForTask } from "@/lib/agent-sources";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

const agentTaskStatuses = ["queued", "in_progress", "completed", "failed", "cancelled"] as const;
type AgentTaskStatus = typeof agentTaskStatuses[number];

type CreateAgentTaskInput = {
  projectId?: string | null;
  title: string;
  instructions?: string | null;
  priority?: string | null;
  requestedBy?: string | null;
  assignedAgent?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

type UpdateAgentTaskInput = {
  status: string;
  assignedAgent?: string | null;
  resultSummary?: string | null;
  outputJson?: unknown;
  errorMessage?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

type ClaimAgentTaskInput = {
  taskId?: string | null;
  projectId?: string | null;
  assignedAgent?: string | null;
};

type AgentTaskRow = typeof agentTasks.$inferSelect;

type AgentTaskActor = {
  action: string;
  actorType: "admin" | "agent" | "client" | "system";
  actorName: string;
};

const agentTaskActor: AgentTaskActor = {
  action: "agent.task.updated",
  actorType: "agent",
  actorName: "The Reeses Studio Agent",
};

const studioTaskActor: AgentTaskActor = {
  action: "agent.task.updated_by_admin",
  actorType: "admin",
  actorName: "The Reeses Studio",
};

function linkedSourcePayload(source: typeof projectSources.$inferSelect) {
  return {
    id: source.id,
    kind: source.kind,
    title: source.title,
    body: source.body,
    summary: source.summary,
    occurredAt: source.occurredAt,
    externalUrl: source.externalUrl,
    capturedBy: source.capturedBy,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
  };
}

function cleanText(value: string | null | undefined) {
  return value?.trim() || null;
}

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : null;
}

function parseOutputJson(value: string | null) {
  const cleaned = cleanText(value);
  if (!cleaned) return undefined;
  return JSON.parse(cleaned);
}

function statusValue(value: string) {
  if (!agentTaskStatuses.includes(value as AgentTaskStatus)) {
    throw new Error("Unsupported agent task status.");
  }
  return value as AgentTaskStatus;
}

function assertCompleteSourceLink(sourceType: string | null, sourceId: string | null) {
  if (!sourceType && sourceId) {
    throw new Error("Agent task source links require sourceType and sourceId together.");
  }
  if (sourceType === "project_source" && !sourceId) {
    throw new Error("Project source task links require projectId and sourceId.");
  }
}

function assertAgentTaskTransition(currentStatus: string, nextStatus: AgentTaskStatus) {
  if (currentStatus === nextStatus) return;
  if (currentStatus === "completed") {
    throw new Error("Completed agent tasks cannot be reopened.");
  }
  if (currentStatus === "failed") {
    throw new Error("Failed agent tasks cannot be reopened.");
  }
  if (currentStatus === "cancelled") {
    throw new Error("Cancelled agent tasks cannot be reopened.");
  }
}

const outputReferenceError = "Agent task output references must be non-empty string ids.";

function cleanOutputReference(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(outputReferenceError);
  }
  return value.trim();
}

function outputStrings(value: unknown, singularKey: string, arrayKey: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const ids: string[] = [];

  if (Object.prototype.hasOwnProperty.call(record, singularKey)) {
    ids.push(cleanOutputReference(record[singularKey]));
  }
  if (Object.prototype.hasOwnProperty.call(record, arrayKey)) {
    const rawArray = record[arrayKey];
    if (!Array.isArray(rawArray)) {
      throw new Error(outputReferenceError);
    }
    ids.push(...rawArray.map(cleanOutputReference));
  }

  return Array.from(new Set(ids));
}

function hasAllProjectRows<Row extends { id: string; projectId: string | null }>(
  rows: Row[],
  ids: string[],
  projectId: string,
) {
  return rows.length === ids.length && rows.every((row) => row.projectId === projectId);
}

function hasAllTaskSourceRows<Row extends { sourceType: string | null; sourceId: string | null }>(
  task: AgentTaskRow,
  rows: Row[],
) {
  if (task.sourceType !== "project_source" || !task.sourceId) return true;
  return rows.every((row) => row.sourceType === task.sourceType && row.sourceId === task.sourceId);
}

function assertStructuredOutput(outputJson: unknown) {
  if (outputJson === undefined) return;
  if (!outputJson || typeof outputJson !== "object" || Array.isArray(outputJson)) {
    throw new Error("Agent task output must be a structured object.");
  }
}

async function assertAgentTaskOutputBelongsToProject(task: AgentTaskRow, outputJson: unknown) {
  if (!task.projectId || outputJson === undefined) return;
  assertStructuredOutput(outputJson);

  const projectIds = outputStrings(outputJson, "projectId", "projectIds");
  for (const projectId of projectIds) {
    if (projectId !== task.projectId) {
      throw new Error("Agent task output project does not match this task.");
    }
  }

  const clientIds = outputStrings(outputJson, "clientId", "clientIds");
  if (clientIds.length) {
    const participantRows = await db.query.projectParticipants.findMany({
      where: and(
        eq(projectParticipants.projectId, task.projectId),
        inArray(projectParticipants.clientId, clientIds),
      ),
    });
    if (participantRows.length !== clientIds.length) {
      throw new Error("Agent task output client does not belong to this project.");
    }
  }

  const activityLogIds = outputStrings(outputJson, "activityLogId", "activityLogIds");
  if (activityLogIds.length) {
    const activityLogRows = await db.query.activityLogs.findMany({ where: inArray(activityLogs.id, activityLogIds) });
    if (!hasAllProjectRows(activityLogRows, activityLogIds, task.projectId)) {
      throw new Error("Agent task output activity log does not belong to this project.");
    }
  }

  const proposalIds = outputStrings(outputJson, "proposalId", "proposalIds");
  if (proposalIds.length) {
    const proposalRows = await db.query.proposals.findMany({ where: inArray(proposals.id, proposalIds) });
    if (!hasAllProjectRows(proposalRows, proposalIds, task.projectId)) {
      throw new Error("Agent task output proposal does not belong to this project.");
    }
    if (!hasAllTaskSourceRows(task, proposalRows)) {
      throw new Error("Agent task output proposal must cite the task project source.");
    }
  }

  const invoiceIds = outputStrings(outputJson, "invoiceId", "invoiceIds");
  if (invoiceIds.length) {
    const invoiceRows = await db.query.invoices.findMany({ where: inArray(invoices.id, invoiceIds) });
    if (!hasAllProjectRows(invoiceRows, invoiceIds, task.projectId)) {
      throw new Error("Agent task output invoice does not belong to this project.");
    }
    if (!hasAllTaskSourceRows(task, invoiceRows)) {
      throw new Error("Agent task output invoice must cite the task project source.");
    }
  }

  const invoicePaymentIds = Array.from(new Set([
    ...outputStrings(outputJson, "invoicePaymentId", "invoicePaymentIds"),
    ...outputStrings(outputJson, "paymentId", "paymentIds"),
  ]));
  if (invoicePaymentIds.length) {
    const rows = await db
      .select({ paymentId: invoicePayments.id, projectId: invoices.projectId })
      .from(invoicePayments)
      .innerJoin(invoices, eq(invoicePayments.invoiceId, invoices.id))
      .where(inArray(invoicePayments.id, invoicePaymentIds));
    if (rows.length !== invoicePaymentIds.length || rows.some((row) => row.projectId !== task.projectId)) {
      throw new Error("Agent task output invoice payment does not belong to this project.");
    }
  }

  const timelineIds = outputStrings(outputJson, "timelineId", "timelineIds");
  if (timelineIds.length) {
    const timelineRows = await db.query.projectTimelineItems.findMany({ where: inArray(projectTimelineItems.id, timelineIds) });
    if (!hasAllProjectRows(timelineRows, timelineIds, task.projectId)) {
      throw new Error("Agent task output timeline item does not belong to this project.");
    }
    if (!hasAllTaskSourceRows(task, timelineRows)) {
      throw new Error("Agent task output timeline item must cite the task project source.");
    }
  }

  const eventIds = outputStrings(outputJson, "eventId", "eventIds");
  if (eventIds.length) {
    const eventRows = await db.query.projectEvents.findMany({ where: inArray(projectEvents.id, eventIds) });
    if (!hasAllProjectRows(eventRows, eventIds, task.projectId)) {
      throw new Error("Agent task output project event does not belong to this project.");
    }
    if (!hasAllTaskSourceRows(task, eventRows)) {
      throw new Error("Agent task output project event must cite the task project source.");
    }
  }

  const locationIds = outputStrings(outputJson, "locationId", "locationIds");
  if (locationIds.length) {
    const locationRows = await db.query.projectLocations.findMany({ where: inArray(projectLocations.id, locationIds) });
    if (!hasAllProjectRows(locationRows, locationIds, task.projectId)) {
      throw new Error("Agent task output project location does not belong to this project.");
    }
    if (!hasAllTaskSourceRows(task, locationRows)) {
      throw new Error("Agent task output project location must cite the task project source.");
    }
  }

  const communicationIds = outputStrings(outputJson, "communicationId", "communicationIds");
  if (communicationIds.length) {
    const communicationRows = await db.query.projectCommunications.findMany({ where: inArray(projectCommunications.id, communicationIds) });
    if (!hasAllProjectRows(communicationRows, communicationIds, task.projectId)) {
      throw new Error("Agent task output communication does not belong to this project.");
    }
    if (!hasAllTaskSourceRows(task, communicationRows)) {
      throw new Error("Agent task output communication must cite the task project source.");
    }
  }

  const expenseIds = outputStrings(outputJson, "expenseId", "expenseIds");
  if (expenseIds.length) {
    const expenseRows = await db.query.expenses.findMany({ where: inArray(expenses.id, expenseIds) });
    if (!hasAllProjectRows(expenseRows, expenseIds, task.projectId)) {
      throw new Error("Agent task output expense does not belong to this project.");
    }
    if (!hasAllTaskSourceRows(task, expenseRows)) {
      throw new Error("Agent task output expense must cite the task project source.");
    }
  }

  const projectSourceIds = outputStrings(outputJson, "projectSourceId", "projectSourceIds");
  if (projectSourceIds.length) {
    const sourceRows = await db.query.projectSources.findMany({ where: inArray(projectSources.id, projectSourceIds) });
    if (!hasAllProjectRows(sourceRows, projectSourceIds, task.projectId)) {
      throw new Error("Agent task output project source does not belong to this project.");
    }
  }

  const questionnaireResponseIds = outputStrings(outputJson, "questionnaireResponseId", "questionnaireResponseIds");
  if (questionnaireResponseIds.length) {
    const responseRows = await db.query.questionnaireResponses.findMany({ where: inArray(questionnaireResponses.id, questionnaireResponseIds) });
    if (!hasAllProjectRows(responseRows, questionnaireResponseIds, task.projectId)) {
      throw new Error("Agent task output questionnaire response does not belong to this project.");
    }
  }

  const schedulerBookingIds = outputStrings(outputJson, "schedulerBookingId", "schedulerBookingIds");
  if (schedulerBookingIds.length) {
    const bookingRows = await db.query.schedulerBookings.findMany({ where: inArray(schedulerBookings.id, schedulerBookingIds) });
    if (!hasAllProjectRows(bookingRows, schedulerBookingIds, task.projectId)) {
      throw new Error("Agent task output scheduler booking does not belong to this project.");
    }
  }
}

export async function createAgentTask(input: CreateAgentTaskInput) {
  const title = cleanText(input.title);
  if (!title) throw new Error("Agent task title is required.");

  const projectId = cleanText(input.projectId);
  if (projectId) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (!project) throw new Error("Project not found.");
  }
  const sourceType = cleanText(input.sourceType);
  const sourceId = cleanText(input.sourceId);
  assertCompleteSourceLink(sourceType, sourceId);
  if (sourceType === "project_source") {
    await requireProjectSourceForTask(projectId, sourceId);
  }
  if (projectId && sourceType && sourceId) {
    const existingActiveTask = await db.query.agentTasks.findFirst({
      where: and(
        eq(agentTasks.projectId, projectId),
        eq(agentTasks.title, title),
        eq(agentTasks.sourceType, sourceType),
        eq(agentTasks.sourceId, sourceId),
        inArray(agentTasks.status, ["queued", "in_progress"]),
      ),
      orderBy: desc(agentTasks.createdAt),
    });
    if (existingActiveTask) {
      return existingActiveTask;
    }
  }

  const now = new Date().toISOString();
  const task = {
    id: crypto.randomUUID(),
    projectId,
    title,
    instructions: cleanText(input.instructions),
    status: "queued",
    priority: cleanText(input.priority) ?? "normal",
    requestedBy: cleanText(input.requestedBy),
    assignedAgent: cleanText(input.assignedAgent) ?? "The Reeses Studio Agent",
    sourceType,
    sourceId,
    resultSummary: null,
    outputJson: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(agentTasks).values(task);
  await logActivity({
    projectId,
    action: "agent.task.created",
    actorType: "agent",
    actorName: task.assignedAgent,
    metadata: {
      agentTaskId: task.id,
      title,
      status: task.status,
      sourceType: task.sourceType,
      sourceId: task.sourceId,
    },
  });

  return task;
}

export async function createProjectAgentTaskFromForm(projectId: string, formData: FormData) {
  const projectSourceId = cleanText(String(formData.get("projectSourceId") ?? ""));
  return createAgentTask({
    projectId,
    title: cleanText(String(formData.get("title") ?? "")) ?? "",
    instructions: cleanText(String(formData.get("instructions") ?? "")),
    priority: cleanText(String(formData.get("priority") ?? "")),
    requestedBy: "Studio UI",
    assignedAgent: cleanText(String(formData.get("assignedAgent") ?? "")),
    sourceType: projectSourceId ? "project_source" : "studio_project",
    sourceId: projectSourceId,
  });
}

async function updateAgentTask(taskId: string, input: UpdateAgentTaskInput, actor: AgentTaskActor) {
  const task = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, taskId) });
  if (!task) throw new Error("Agent task not found.");

  const status = statusValue(input.status);
  const updatingAgent = actor.actorType === "agent" ? cleanText(input.assignedAgent) : null;
  const isSpecialistOwnedTask = Boolean(task.assignedAgent && task.assignedAgent !== "The Reeses Studio Agent");
  if (actor.actorType === "agent" && isSpecialistOwnedTask && !updatingAgent) {
    throw new Error("Agent task updates for specialist-owned tasks require assignedAgent.");
  }
  if (
    updatingAgent
    && task.assignedAgent
    && task.assignedAgent !== updatingAgent
    && task.assignedAgent !== "The Reeses Studio Agent"
  ) {
    throw new Error("Agent task is assigned to a different agent.");
  }
  assertAgentTaskTransition(task.status, status);
  assertStructuredOutput(input.outputJson);
  await assertAgentTaskOutputBelongsToProject(task, input.outputJson);
  const sourceType = Object.prototype.hasOwnProperty.call(input, "sourceType") ? cleanText(input.sourceType) : task.sourceType;
  const sourceId = Object.prototype.hasOwnProperty.call(input, "sourceId") ? cleanText(input.sourceId) : task.sourceId;
  assertCompleteSourceLink(sourceType, sourceId);
  if (sourceType === "project_source") {
    await requireProjectSourceForTask(task.projectId, sourceId);
  }
  const now = new Date().toISOString();
  const isTerminalStatus = ["completed", "failed", "cancelled"].includes(status);
  const assignedAgent = updatingAgent && task.assignedAgent === "The Reeses Studio Agent"
    ? updatingAgent
    : task.assignedAgent;
  const patch = {
    status,
    assignedAgent,
    resultSummary: input.resultSummary === undefined ? task.resultSummary : cleanText(input.resultSummary),
    outputJson: input.outputJson === undefined ? task.outputJson : JSON.stringify(input.outputJson),
    errorMessage: input.errorMessage === undefined ? task.errorMessage : cleanText(input.errorMessage),
    sourceType,
    sourceId,
    startedAt: status === "in_progress" && !task.startedAt ? now : task.startedAt,
    completedAt: isTerminalStatus ? task.completedAt ?? now : null,
    updatedAt: now,
  };

  await db.update(agentTasks).set(patch).where(eq(agentTasks.id, taskId));
  const updated = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, taskId) });
  if (!updated) throw new Error("Agent task update failed.");

  await logActivity({
    projectId: updated.projectId,
    action: actor.action,
    actorType: actor.actorType,
    actorName: actor.actorName === agentTaskActor.actorName ? updatingAgent ?? updated.assignedAgent ?? actor.actorName : actor.actorName,
    metadata: {
      agentTaskId: taskId,
      status,
      assignedAgent: updatingAgent ?? updated.assignedAgent,
      sourceType,
      sourceId,
    },
  });

  return updated;
}

export async function updateAgentTaskStatus(taskId: string, input: UpdateAgentTaskInput) {
  return updateAgentTask(taskId, input, agentTaskActor);
}

export async function updateAgentTaskFromForm(taskId: string, formData: FormData) {
  return updateAgentTask(taskId, {
    status: formString(formData, "status") ?? "",
    resultSummary: formString(formData, "resultSummary"),
    outputJson: parseOutputJson(formString(formData, "outputJson")),
    errorMessage: formString(formData, "errorMessage"),
  }, studioTaskActor);
}

export async function updateProjectAgentTaskFromForm(projectId: string, taskId: string, formData: FormData) {
  const task = await db.query.agentTasks.findFirst({
    where: and(eq(agentTasks.id, taskId), eq(agentTasks.projectId, projectId)),
  });
  if (!task) throw new Error("Agent task not found.");
  return updateAgentTaskFromForm(task.id, formData);
}

export async function claimNextAgentTask(input: ClaimAgentTaskInput = {}) {
  const taskId = cleanText(input.taskId);
  const projectId = cleanText(input.projectId);
  const assignedAgent = cleanText(input.assignedAgent) ?? "The Reeses Studio Agent";
  const now = new Date().toISOString();

  const task = await db.query.agentTasks.findFirst({
    where: taskId
      ? projectId
        ? (row, { and, eq, or }) => and(
          eq(row.id, taskId),
          eq(row.projectId, projectId),
          eq(row.status, "queued"),
          or(eq(row.assignedAgent, assignedAgent), eq(row.assignedAgent, "The Reeses Studio Agent")),
        )
        : (row, { and, eq, or }) => and(
          eq(row.id, taskId),
          eq(row.status, "queued"),
          or(eq(row.assignedAgent, assignedAgent), eq(row.assignedAgent, "The Reeses Studio Agent")),
        )
      : projectId
      ? (row, { and, eq, or }) => and(
        eq(row.projectId, projectId),
        eq(row.status, "queued"),
        or(eq(row.assignedAgent, assignedAgent), eq(row.assignedAgent, "The Reeses Studio Agent")),
      )
      : (row, { and, eq, or }) => and(
        eq(row.status, "queued"),
        or(eq(row.assignedAgent, assignedAgent), eq(row.assignedAgent, "The Reeses Studio Agent")),
      ),
    orderBy: agentTasks.createdAt,
  });
  if (!task) return null;

  await db.update(agentTasks).set({
    status: "in_progress",
    assignedAgent,
    startedAt: task.startedAt ?? now,
    updatedAt: now,
  }).where(eq(agentTasks.id, task.id));
  if (task.sourceType === "project_workflow_step" && task.sourceId) {
    await db.update(projectWorkflowSteps).set({
      status: "in_progress",
      updatedAt: now,
    }).where(eq(projectWorkflowSteps.id, task.sourceId));
  }

  const updated = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) });
  if (!updated) throw new Error("Agent task claim failed.");

  await logActivity({
    projectId: updated.projectId,
    action: "agent.task.claimed",
    actorType: "agent",
    actorName: assignedAgent,
    metadata: {
      agentTaskId: updated.id,
      status: updated.status,
      assignedAgent,
      sourceType: updated.sourceType,
      sourceId: updated.sourceId,
    },
  });

  return updated;
}

export async function listAgentTasks(input: { projectId?: string | null; status?: string | null; assignedAgent?: string | null; limit?: number | null } = {}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50);
  const projectId = cleanText(input.projectId);
  const status = cleanText(input.status);
  const assignedAgent = cleanText(input.assignedAgent);

  if (status) statusValue(status);

  const filters = [
    projectId ? eq(agentTasks.projectId, projectId) : null,
    status ? eq(agentTasks.status, status) : null,
    assignedAgent
      ? or(
        eq(agentTasks.assignedAgent, assignedAgent),
        eq(agentTasks.assignedAgent, "The Reeses Studio Agent"),
      )
      : null,
  ].filter((filter) => filter !== null);
  const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);

  return db.query.agentTasks.findMany({
    ...(where ? { where } : {}),
    orderBy: status === "queued" ? asc(agentTasks.createdAt) : desc(agentTasks.createdAt),
    limit,
  });
}

export async function hydrateAgentTaskLinkedSources<T extends AgentTaskRow>(tasks: T[]) {
  const sourceIds = Array.from(new Set(tasks
    .filter((task) => task.sourceType === "project_source" && task.sourceId)
    .map((task) => task.sourceId as string)));

  if (sourceIds.length === 0) {
    return tasks.map((task) => ({ ...task, linkedSource: null }));
  }

  const sources = await db.query.projectSources.findMany({
    where: (source, { inArray }) => inArray(source.id, sourceIds),
  });
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  return tasks.map((task) => {
    const source = task.sourceType === "project_source" && task.sourceId ? sourceById.get(task.sourceId) : null;
    const canonicalSource = source && source.projectId === task.projectId ? source : null;
    return {
      ...task,
      linkedSource: canonicalSource ? linkedSourcePayload(canonicalSource) : null,
    };
  });
}

export async function hydrateAgentTaskLinkedSource<T extends AgentTaskRow>(task: T | null) {
  if (!task) return null;
  const [hydrated] = await hydrateAgentTaskLinkedSources([task]);
  return hydrated;
}

type AgentTaskInboxInput = {
  status?: string | null;
  assignedAgent?: string | null;
  limit?: number | null;
};

function agentTaskInboxFilters(input: AgentTaskInboxInput, includeStatus = true) {
  const status = cleanText(input.status);
  const assignedAgent = cleanText(input.assignedAgent);

  if (status) statusValue(status);

  return [
    includeStatus && status ? eq(agentTasks.status, status) : null,
    assignedAgent
      ? or(
        eq(agentTasks.assignedAgent, assignedAgent),
        eq(agentTasks.assignedAgent, "The Reeses Studio Agent"),
      )
      : null,
  ].filter((filter) => filter !== null);
}

export async function getAgentTaskInbox(input: number | AgentTaskInboxInput = 50) {
  const inboxInput = typeof input === "number" ? { limit: input } : input;
  const rowFilters = agentTaskInboxFilters(inboxInput);
  const countFilters = agentTaskInboxFilters(inboxInput, false);
  const rowWhere = rowFilters.length === 0 ? undefined : rowFilters.length === 1 ? rowFilters[0] : and(...rowFilters);
  const countWhere = countFilters.length === 0 ? undefined : countFilters.length === 1 ? countFilters[0] : and(...countFilters);
  const [rows, countRows] = await Promise.all([
    db
    .select({
      task: agentTasks,
      project: projects,
    })
    .from(agentTasks)
    .leftJoin(projects, eq(agentTasks.projectId, projects.id))
    .$dynamic()
    .where(rowWhere)
    .orderBy(desc(agentTasks.createdAt))
      .limit(Math.min(Math.max(Math.trunc(inboxInput.limit ?? 50), 1), 100)),
    db
      .select({
        status: agentTasks.status,
        count: sql<number>`count(*)`,
      })
      .from(agentTasks)
      .$dynamic()
      .where(countWhere)
      .groupBy(agentTasks.status),
  ]);

  const counts = {
    queued: 0,
    inProgress: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const row of countRows) {
    const count = Number(row.count);
    if (row.status === "queued") counts.queued = count;
    if (row.status === "in_progress") counts.inProgress = count;
    if (row.status === "completed") counts.completed = count;
    if (row.status === "failed") counts.failed = count;
    if (row.status === "cancelled") counts.cancelled = count;
  }

  return { tasks: rows, counts };
}
