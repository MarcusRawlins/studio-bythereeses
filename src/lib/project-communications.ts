import { db } from "@/db/client";
import { clients, projectCommunications, projectParticipants, projects } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { requireProjectSourceForTask } from "@/lib/agent-sources";
import { and, asc, desc, eq } from "drizzle-orm";

const communicationDirections = ["outbound", "inbound", "internal"] as const;
const communicationChannels = ["email", "sms", "call", "note"] as const;
const communicationStatuses = ["draft", "queued", "sent", "archived"] as const;

type CreateProjectCommunicationInput = {
  clientId?: string | null;
  direction?: string | null;
  channel?: string | null;
  status?: string | null;
  subject?: string | null;
  body?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  scheduledFor?: string | null;
  sentAt?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

type UpdateProjectCommunicationInput = {
  direction?: string | null;
  channel?: string | null;
  status?: string | null;
  subject?: string | null;
  body?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  scheduledFor?: string | null;
  sentAt?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

type CommunicationActor = {
  createdBy?: string;
  createAction: string;
  updateAction: string;
  actorType: "admin" | "agent" | "client" | "system";
  actorName: string;
};

const agentActor: CommunicationActor = {
  createdBy: "agent",
  createAction: "project.communication.created_by_agent",
  updateAction: "project.communication.updated_by_agent",
  actorType: "agent",
  actorName: "The Reeses Studio Agent",
};

const studioActor: CommunicationActor = {
  createdBy: "admin",
  createAction: "project.communication.created_by_admin",
  updateAction: "project.communication.updated_by_admin",
  actorType: "admin",
  actorName: "The Reeses Studio",
};

function cleanText(value: string | null | undefined) {
  return value?.trim() || null;
}

function cleanEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() || null;
}

function enumValue<T extends readonly string[]>(value: string | null | undefined, allowed: T, fallback: T[number]) {
  const cleaned = cleanText(value);
  return allowed.includes(cleaned ?? "") ? cleaned as T[number] : fallback;
}

function hasOwn(input: object, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : null;
}

function clientName(client: typeof clients.$inferSelect) {
  return [client.firstName, client.lastName].filter(Boolean).join(" ");
}

async function resolveRecipient(projectId: string, clientId?: string | null) {
  if (clientId) {
    const row = await db
      .select({ client: clients })
      .from(projectParticipants)
      .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
      .where(and(eq(projectParticipants.projectId, projectId), eq(projectParticipants.clientId, clientId)))
      .limit(1);
    if (!row[0]) throw new Error("Project client not found.");
    return row[0].client;
  }

  const row = await db
    .select({ client: clients, participant: projectParticipants })
    .from(projectParticipants)
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(projectParticipants.projectId, projectId))
    .orderBy(desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt))
    .limit(1);
  return row[0]?.client ?? null;
}

async function createProjectCommunication(projectId: string, input: CreateProjectCommunicationInput, actor: CommunicationActor) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new Error("Project not found.");

  const body = cleanText(input.body);
  if (!body) throw new Error("Communication body is required.");

  const sourceType = cleanText(input.sourceType);
  const sourceId = cleanText(input.sourceId);
  if (!sourceType && sourceId) {
    throw new Error("Project communication source links require sourceType when sourceId is set.");
  }
  if (sourceType === "project_source") {
    await requireProjectSourceForTask(projectId, sourceId);
  }

  const recipientClient = await resolveRecipient(projectId, cleanText(input.clientId));
  const now = new Date().toISOString();
  const status = enumValue(input.status, communicationStatuses, "draft");
  const communication = {
    id: crypto.randomUUID(),
    projectId,
    clientId: recipientClient?.id ?? cleanText(input.clientId),
    direction: enumValue(input.direction, communicationDirections, "outbound"),
    channel: enumValue(input.channel, communicationChannels, "email"),
    status,
    subject: cleanText(input.subject),
    body,
    recipientName: cleanText(input.recipientName) ?? (recipientClient ? clientName(recipientClient) : null),
    recipientEmail: cleanEmail(input.recipientEmail) ?? recipientClient?.email ?? null,
    scheduledFor: cleanText(input.scheduledFor),
    sentAt: cleanText(input.sentAt) ?? (status === "sent" ? now : null),
    sourceType,
    sourceId,
    createdBy: actor.createdBy,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(projectCommunications).values(communication);
  await logActivity({
    projectId,
    clientId: communication.clientId,
    action: actor.createAction,
    actorType: actor.actorType,
    actorName: actor.actorName,
    metadata: {
      communicationId: communication.id,
      channel: communication.channel,
      status: communication.status,
      subject: communication.subject,
      sourceType: communication.sourceType,
      sourceId: communication.sourceId,
    },
  });

  return communication;
}

async function updateProjectCommunication(
  projectId: string,
  communicationId: string,
  input: UpdateProjectCommunicationInput,
  actor: CommunicationActor,
) {
  const communication = await db.query.projectCommunications.findFirst({
    where: (row, { and, eq }) => and(eq(row.id, communicationId), eq(row.projectId, projectId)),
  });
  if (!communication) throw new Error("Communication not found.");

  const nextBody = hasOwn(input, "body") ? cleanText(input.body) : communication.body;
  if (!nextBody) throw new Error("Communication body is required.");

  const now = new Date().toISOString();
  const nextStatus = hasOwn(input, "status") ? enumValue(input.status, communicationStatuses, communication.status as typeof communicationStatuses[number]) : communication.status;
  const nextSentAt = hasOwn(input, "sentAt") ? cleanText(input.sentAt) : communication.sentAt;
  const nextSourceType = hasOwn(input, "sourceType") ? cleanText(input.sourceType) : communication.sourceType;
  const nextSourceId = hasOwn(input, "sourceId") ? cleanText(input.sourceId) : communication.sourceId;
  if (!nextSourceType && nextSourceId) {
    throw new Error("Project communication source links require sourceType when sourceId is set.");
  }
  if (nextSourceType === "project_source") {
    await requireProjectSourceForTask(projectId, nextSourceId);
  }

  const updates = {
    direction: hasOwn(input, "direction") ? enumValue(input.direction, communicationDirections, communication.direction as typeof communicationDirections[number]) : communication.direction,
    channel: hasOwn(input, "channel") ? enumValue(input.channel, communicationChannels, communication.channel as typeof communicationChannels[number]) : communication.channel,
    status: nextStatus,
    subject: hasOwn(input, "subject") ? cleanText(input.subject) : communication.subject,
    body: nextBody,
    recipientName: hasOwn(input, "recipientName") ? cleanText(input.recipientName) : communication.recipientName,
    recipientEmail: hasOwn(input, "recipientEmail") ? cleanEmail(input.recipientEmail) : communication.recipientEmail,
    scheduledFor: hasOwn(input, "scheduledFor") ? cleanText(input.scheduledFor) : communication.scheduledFor,
    sentAt: nextSentAt ?? (nextStatus === "sent" ? now : null),
    sourceType: nextSourceType,
    sourceId: nextSourceId,
    updatedAt: now,
  };

  await db.update(projectCommunications).set(updates).where(eq(projectCommunications.id, communication.id));
  const updated = await db.query.projectCommunications.findFirst({ where: eq(projectCommunications.id, communication.id) });
  if (!updated) throw new Error("Communication update failed.");

  const changedFields = Object.entries(updates)
    .filter(([key, value]) => key !== "updatedAt" && communication[key as keyof typeof communication] !== value)
    .map(([key]) => key);

  await logActivity({
    projectId,
    clientId: updated.clientId,
    action: actor.updateAction,
    actorType: actor.actorType,
    actorName: actor.actorName,
    metadata: {
      communicationId: updated.id,
      status: updated.status,
      changedFields,
      sourceType: updated.sourceType,
      sourceId: updated.sourceId,
    },
  });

  return updated;
}

export async function createProjectCommunicationFromAgent(projectId: string, input: CreateProjectCommunicationInput) {
  return createProjectCommunication(projectId, input, agentActor);
}

export async function createProjectCommunicationFromForm(projectId: string, formData: FormData) {
  const sourceId = cleanText(formString(formData, "sourceId"));
  return createProjectCommunication(projectId, {
    clientId: formString(formData, "clientId"),
    direction: formString(formData, "direction"),
    channel: formString(formData, "channel"),
    status: formString(formData, "status"),
    subject: formString(formData, "subject"),
    body: formString(formData, "body"),
    recipientName: formString(formData, "recipientName"),
    recipientEmail: formString(formData, "recipientEmail"),
    scheduledFor: formString(formData, "scheduledFor"),
    sentAt: formString(formData, "sentAt"),
    sourceType: sourceId ? "project_source" : null,
    sourceId,
  }, studioActor);
}

export async function updateProjectCommunicationFromAgent(
  projectId: string,
  communicationId: string,
  input: UpdateProjectCommunicationInput,
) {
  return updateProjectCommunication(projectId, communicationId, input, agentActor);
}

export async function updateProjectCommunicationFromForm(projectId: string, communicationId: string, formData: FormData) {
  return updateProjectCommunication(projectId, communicationId, {
    direction: formString(formData, "direction"),
    channel: formString(formData, "channel"),
    status: formString(formData, "status"),
    subject: formString(formData, "subject"),
    body: formString(formData, "body"),
    recipientName: formString(formData, "recipientName"),
    recipientEmail: formString(formData, "recipientEmail"),
    scheduledFor: formString(formData, "scheduledFor"),
    sentAt: formString(formData, "sentAt"),
  }, studioActor);
}

export async function listProjectCommunications(projectId: string, input: { status?: string | null; limit?: number | null } = {}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50);
  const status = cleanText(input.status);

  if (status) {
    return db.query.projectCommunications.findMany({
      where: (row, { and, eq }) => and(eq(row.projectId, projectId), eq(row.status, status)),
      orderBy: [desc(projectCommunications.createdAt)],
      limit,
    });
  }

  return db.query.projectCommunications.findMany({
    where: eq(projectCommunications.projectId, projectId),
    orderBy: [desc(projectCommunications.createdAt)],
    limit,
  });
}
