import { db } from "@/db/client";
import { activityLogs, projectTimelineItems, projects } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";

export type CreateProjectTimelineItemInput = {
  title: string;
  description?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

export type CreateProjectTimelineItemsFromAgentInput = {
  sourceType?: string | null;
  sourceId?: string | null;
  replaceExistingForSource?: boolean;
  timelineItems: CreateProjectTimelineItemInput[];
};

export type UpdateProjectTimelineItemInput = {
  title?: string | null;
  description?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  sortOrder?: number | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

type TimelineActor = "admin" | "agent";

function cleanText(value: string | null | undefined) {
  return value?.trim() || null;
}

async function assertProjectExists(projectId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) {
    throw new Error("Project not found.");
  }
}

async function assertSourceBelongsToProject(projectId: string, sourceType: string | null, sourceId: string | null) {
  if (!sourceType && sourceId) {
    throw new Error("Project timeline source links require sourceType when sourceId is set.");
  }
  if (sourceType !== "project_source") return;
  if (!sourceId) {
    throw new Error("Project source id is required.");
  }

  const source = await db.query.projectSources.findFirst({
    where: (row, { and, eq }) => and(eq(row.id, sourceId), eq(row.projectId, projectId)),
  });
  if (!source) {
    throw new Error("Project source not found for this project.");
  }
}

async function nextTimelineSortOrder(projectId: string) {
  const latestItem = await db.query.projectTimelineItems.findFirst({
    where: eq(projectTimelineItems.projectId, projectId),
    orderBy: desc(projectTimelineItems.sortOrder),
  });
  return latestItem ? latestItem.sortOrder + 1 : 0;
}

function timelineItemValues(
  projectId: string,
  input: CreateProjectTimelineItemInput,
  sortOrder: number,
  now: string,
  fallbackSourceType?: string | null,
  fallbackSourceId?: string | null,
) {
  const title = cleanText(input.title);
  if (!title) {
    throw new Error("Timeline item title is required.");
  }

  return {
    id: crypto.randomUUID(),
    projectId,
    title,
    description: cleanText(input.description),
    startAt: cleanText(input.startAt),
    endAt: cleanText(input.endAt),
    sortOrder,
    sourceType: cleanText(input.sourceType) ?? cleanText(fallbackSourceType),
    sourceId: cleanText(input.sourceId) ?? cleanText(fallbackSourceId),
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
  };
}

async function logTimelineItemCreated(item: typeof projectTimelineItems.$inferInsert, now: string) {
  await db.insert(activityLogs).values({
    id: crypto.randomUUID(),
    projectId: item.projectId,
    clientId: null,
    action: "project.timeline_item.created",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
    metadata: JSON.stringify({
      timelineItemId: item.id,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
    }),
    createdAt: now,
  });
}

function hasOwn(input: object, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function hasProvided(input: UpdateProjectTimelineItemInput, key: keyof UpdateProjectTimelineItemInput) {
  return hasOwn(input, key) && input[key] !== undefined;
}

function timelineActorName(actor: TimelineActor) {
  return actor === "agent" ? "The Reeses Studio Agent" : "The Reeses Studio";
}

export async function createProjectTimelineItem(projectId: string, input: CreateProjectTimelineItemInput) {
  await assertProjectExists(projectId);
  const sourceType = cleanText(input.sourceType);
  const sourceId = cleanText(input.sourceId);
  await assertSourceBelongsToProject(projectId, sourceType, sourceId);

  const sortOrder = await nextTimelineSortOrder(projectId);
  const now = new Date().toISOString();
  const item = timelineItemValues(projectId, { ...input, sourceType, sourceId }, sortOrder, now);

  await db.insert(projectTimelineItems).values(item);
  await logTimelineItemCreated(item, now);

  return item;
}

export async function createProjectTimelineItemsFromAgent(projectId: string, input: CreateProjectTimelineItemsFromAgentInput) {
  await assertProjectExists(projectId);

  if (!Array.isArray(input.timelineItems) || input.timelineItems.length === 0) {
    throw new Error("At least one timeline item is required.");
  }

  const sourceType = cleanText(input.sourceType);
  const sourceId = cleanText(input.sourceId);
  await assertSourceBelongsToProject(projectId, sourceType, sourceId);

  if (input.replaceExistingForSource) {
    if (!sourceType || !sourceId) {
      throw new Error("Source type and source id are required to replace generated timeline items.");
    }
    await db.delete(projectTimelineItems).where(and(
      eq(projectTimelineItems.projectId, projectId),
      eq(projectTimelineItems.sourceType, sourceType),
      eq(projectTimelineItems.sourceId, sourceId),
    ));
  }

  const firstSortOrder = await nextTimelineSortOrder(projectId);
  const now = new Date().toISOString();
  const items = input.timelineItems.map((item, index) => timelineItemValues(
    projectId,
    item,
    firstSortOrder + index,
    now,
    sourceType,
    sourceId,
  ));

  await db.insert(projectTimelineItems).values(items);
  for (const item of items) {
    await logTimelineItemCreated(item, now);
  }

  return items;
}

export async function updateProjectTimelineItem(
  projectId: string,
  timelineItemId: string,
  input: UpdateProjectTimelineItemInput,
  actor: TimelineActor = "agent",
) {
  await assertProjectExists(projectId);

  const existingItem = await db.query.projectTimelineItems.findFirst({
    where: (row, { and, eq }) => and(eq(row.id, timelineItemId), eq(row.projectId, projectId)),
  });
  if (!existingItem) {
    throw new Error("Timeline item not found.");
  }

  const nextTitle = hasProvided(input, "title") ? cleanText(input.title) : existingItem.title;
  if (!nextTitle) {
    throw new Error("Timeline item title is required.");
  }

  const nextSourceType = hasProvided(input, "sourceType") ? cleanText(input.sourceType) : existingItem.sourceType;
  const nextSourceId = hasProvided(input, "sourceId") ? cleanText(input.sourceId) : existingItem.sourceId;
  await assertSourceBelongsToProject(projectId, nextSourceType, nextSourceId);

  const now = new Date().toISOString();
  const updates = {
    title: nextTitle,
    description: hasProvided(input, "description") ? cleanText(input.description) : existingItem.description,
    startAt: hasProvided(input, "startAt") ? cleanText(input.startAt) : existingItem.startAt,
    endAt: hasProvided(input, "endAt") ? cleanText(input.endAt) : existingItem.endAt,
    sortOrder: hasProvided(input, "sortOrder") && Number.isFinite(input.sortOrder)
      ? Math.round(Number(input.sortOrder))
      : existingItem.sortOrder,
    sourceType: nextSourceType,
    sourceId: nextSourceId,
    updatedAt: now,
  };

  await db.update(projectTimelineItems).set(updates).where(eq(projectTimelineItems.id, existingItem.id));
  const updatedItem = await db.query.projectTimelineItems.findFirst({
    where: eq(projectTimelineItems.id, existingItem.id),
  });
  if (!updatedItem) {
    throw new Error("Timeline item update failed.");
  }

  const changedFields = Object.entries(updates)
    .filter(([key, value]) => key !== "updatedAt" && existingItem[key as keyof typeof existingItem] !== value)
    .map(([key]) => key);

  await db.insert(activityLogs).values({
    id: crypto.randomUUID(),
    projectId,
    clientId: null,
    action: "project.timeline_item.updated",
    actorType: actor,
    actorName: timelineActorName(actor),
    metadata: JSON.stringify({
      timelineItemId: updatedItem.id,
      changedFields,
      sourceType: updatedItem.sourceType,
      sourceId: updatedItem.sourceId,
    }),
    createdAt: now,
  });

  return updatedItem;
}

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : null;
}

function formNumber(formData: FormData, key: string) {
  const value = formString(formData, key);
  if (!value?.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export async function updateProjectTimelineItemFromForm(projectId: string, formData: FormData) {
  const timelineItemId = formString(formData, "timelineItemId")?.trim();
  if (!timelineItemId) {
    throw new Error("Timeline item id is required.");
  }

  return updateProjectTimelineItem(projectId, timelineItemId, {
    title: formString(formData, "title"),
    description: formString(formData, "description"),
    startAt: formString(formData, "startAt"),
    endAt: formString(formData, "endAt"),
    sortOrder: formNumber(formData, "sortOrder"),
  }, "admin");
}
