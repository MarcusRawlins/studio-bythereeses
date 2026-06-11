import { db } from "@/db/client";
import { projectSources, projects } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { asc, desc, eq } from "drizzle-orm";

type CreateProjectSourceInput = {
  kind: string;
  title: string;
  body: string;
  summary?: string | null;
  occurredAt?: string | null;
  externalUrl?: string | null;
  capturedBy?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  metadata?: unknown;
};

type UpdateProjectSourceInput = Partial<CreateProjectSourceInput>;

type SourceActivityOptions = {
  action: string;
  updateAction?: string;
  actorType: "admin" | "agent";
  actorName: string;
};

function cleanText(value: string | null | undefined) {
  return value?.trim() || null;
}

function metadataJson(value: unknown) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function assertProjectSourceIdentity(sourceType: string | null, sourceId: string | null) {
  if (!sourceType && sourceId) {
    throw new Error("Project source identity requires sourceType when sourceId is set.");
  }
}

async function createProjectSource(
  projectId: string,
  input: CreateProjectSourceInput,
  activity: SourceActivityOptions,
) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new Error("Project not found.");

  const title = cleanText(input.title);
  const body = cleanText(input.body);
  if (!title) throw new Error("Project source title is required.");
  if (!body) throw new Error("Project source body is required.");

  const now = new Date().toISOString();
  const sourceType = cleanText(input.sourceType);
  const sourceId = cleanText(input.sourceId);
  assertProjectSourceIdentity(sourceType, sourceId);
  const existingSource = sourceType && sourceId
    ? await db.query.projectSources.findFirst({
      where: (source, { and, eq }) => and(
        eq(source.projectId, projectId),
        eq(source.sourceType, sourceType),
        eq(source.sourceId, sourceId),
      ),
    })
    : null;

  if (existingSource) {
    const updates = {
      kind: cleanText(input.kind) ?? "note",
      title,
      body,
      summary: cleanText(input.summary),
      occurredAt: cleanText(input.occurredAt),
      externalUrl: cleanText(input.externalUrl),
      capturedBy: cleanText(input.capturedBy) ?? activity.actorName,
      metadataJson: metadataJson(input.metadata),
      updatedAt: now,
    };
    await db.update(projectSources).set(updates).where(eq(projectSources.id, existingSource.id));
    const updated = await db.query.projectSources.findFirst({ where: eq(projectSources.id, existingSource.id) });
    if (!updated) throw new Error("Project source update failed.");
    await logActivity({
      projectId,
      action: activity.updateAction ?? activity.action,
      actorType: activity.actorType,
      actorName: updated.capturedBy,
      metadata: {
        projectSourceId: updated.id,
        kind: updated.kind,
        title: updated.title,
        sourceType: updated.sourceType,
        sourceId: updated.sourceId,
      },
    });
    return updated;
  }

  const source = {
    id: crypto.randomUUID(),
    projectId,
    kind: cleanText(input.kind) ?? "note",
    title,
    body,
    summary: cleanText(input.summary),
    occurredAt: cleanText(input.occurredAt),
    externalUrl: cleanText(input.externalUrl),
    capturedBy: cleanText(input.capturedBy) ?? activity.actorName,
    sourceType,
    sourceId,
    metadataJson: metadataJson(input.metadata),
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(projectSources).values(source);
  await logActivity({
    projectId,
    action: activity.action,
    actorType: activity.actorType,
    actorName: source.capturedBy,
    metadata: {
      projectSourceId: source.id,
      kind: source.kind,
      title: source.title,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
    },
  });

  return source;
}

export async function createProjectSourceFromAgent(projectId: string, input: CreateProjectSourceInput) {
  return createProjectSource(projectId, input, {
    action: "project.source.created_by_agent",
    updateAction: "project.source.updated_by_agent",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
  });
}

export async function updateProjectSourceFromAgent(projectId: string, sourceId: string, input: UpdateProjectSourceInput) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new Error("Project not found.");

  const existingSource = await db.query.projectSources.findFirst({
    where: (source, { and, eq }) => and(eq(source.id, sourceId), eq(source.projectId, projectId)),
  });
  if (!existingSource) throw new Error("Project source not found for this project.");

  const title = Object.prototype.hasOwnProperty.call(input, "title") ? cleanText(input.title) : existingSource.title;
  const body = Object.prototype.hasOwnProperty.call(input, "body") ? cleanText(input.body) : existingSource.body;
  if (!title) throw new Error("Project source title is required.");
  if (!body) throw new Error("Project source body is required.");

  const updates = {
    kind: Object.prototype.hasOwnProperty.call(input, "kind") ? cleanText(input.kind) ?? "note" : existingSource.kind,
    title,
    body,
    summary: Object.prototype.hasOwnProperty.call(input, "summary") ? cleanText(input.summary) : existingSource.summary,
    occurredAt: Object.prototype.hasOwnProperty.call(input, "occurredAt") ? cleanText(input.occurredAt) : existingSource.occurredAt,
    externalUrl: Object.prototype.hasOwnProperty.call(input, "externalUrl") ? cleanText(input.externalUrl) : existingSource.externalUrl,
    capturedBy: Object.prototype.hasOwnProperty.call(input, "capturedBy") ? cleanText(input.capturedBy) ?? "The Reeses Studio Agent" : existingSource.capturedBy,
    sourceType: Object.prototype.hasOwnProperty.call(input, "sourceType") ? cleanText(input.sourceType) : existingSource.sourceType,
    sourceId: Object.prototype.hasOwnProperty.call(input, "sourceId") ? cleanText(input.sourceId) : existingSource.sourceId,
    metadataJson: Object.prototype.hasOwnProperty.call(input, "metadata") ? metadataJson(input.metadata) : existingSource.metadataJson,
    updatedAt: new Date().toISOString(),
  };
  assertProjectSourceIdentity(updates.sourceType, updates.sourceId);

  await db.update(projectSources).set(updates).where(eq(projectSources.id, sourceId));
  const updated = await db.query.projectSources.findFirst({ where: eq(projectSources.id, sourceId) });
  if (!updated) throw new Error("Project source update failed.");

  await logActivity({
    projectId,
    action: "project.source.updated_by_agent",
    actorType: "agent",
    actorName: updated.capturedBy ?? "The Reeses Studio Agent",
    metadata: {
      projectSourceId: updated.id,
      kind: updated.kind,
      title: updated.title,
      sourceType: updated.sourceType,
      sourceId: updated.sourceId,
    },
  });

  return updated;
}

export async function createProjectSourceFromForm(projectId: string, formData: FormData) {
  return createProjectSource(projectId, {
    kind: String(formData.get("kind") ?? "note"),
    title: String(formData.get("title") ?? ""),
    body: String(formData.get("body") ?? ""),
    summary: String(formData.get("summary") ?? ""),
    occurredAt: String(formData.get("occurredAt") ?? ""),
    externalUrl: String(formData.get("externalUrl") ?? ""),
    capturedBy: "Studio UI",
    sourceType: String(formData.get("sourceType") ?? "studio_project"),
    sourceId: String(formData.get("sourceId") ?? ""),
  }, {
    action: "project.source.created",
    updateAction: "project.source.updated",
    actorType: "admin",
    actorName: "Studio UI",
  });
}

export async function listProjectSources(projectId: string, input: { kind?: string | null; limit?: number | null } = {}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50);
  const kind = cleanText(input.kind);

  if (kind) {
    return db.query.projectSources.findMany({
      where: (source, { and, eq }) => and(eq(source.projectId, projectId), eq(source.kind, kind)),
      orderBy: [desc(projectSources.occurredAt), desc(projectSources.createdAt)],
      limit,
    });
  }

  return db.query.projectSources.findMany({
    where: eq(projectSources.projectId, projectId),
    orderBy: [desc(projectSources.occurredAt), desc(projectSources.createdAt), asc(projectSources.title)],
    limit,
  });
}

export async function requireProjectSourceForTask(projectId: string | null, sourceId: string | null) {
  if (!projectId || !sourceId) throw new Error("Project source task links require projectId and sourceId.");

  const source = await db.query.projectSources.findFirst({ where: eq(projectSources.id, sourceId) });
  if (!source || source.projectId !== projectId) throw new Error("Project source not found.");

  return source;
}
