import { db } from "@/db/client";
import { activityLogs, projectTimelineItems, projects } from "@/db/schema";
import type { TimelineDraft } from "@/lib/timeline-draft";
import { createHash } from "node:crypto";
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

// -----------------------------------------------------------------------------
// Phase 23 (CR-5), D6 — "Apply timeline draft" (the missing step: the draft at
// `timeline-draft.ts` has always dead-ended read-only; this is the first apply
// path). Gated behind QUESTIONNAIRE_AUTOFILL_REVIEW by the caller (the API
// route), same rollout unit as the questionnaire proposal (D6).
// -----------------------------------------------------------------------------

type TimelineDraftOutputJson = {
  projectId?: string;
  projectSourceId?: string;
  timelineDraft?: TimelineDraft;
};

function parseTimelineDraftOutput(outputJson: string | null): TimelineDraftOutputJson | null {
  if (!outputJson) return null;
  try {
    return JSON.parse(outputJson) as TimelineDraftOutputJson;
  } catch {
    return null;
  }
}

// Phase 23 review MEDIUM-1 — anti-TOCTOU version token for the "Apply timeline
// draft" action (the second apply door; mirrors the questionnaire proposal's
// contentHash/D8). The draft card renders this over the CURRENT `outputJson`;
// the apply route recomputes it and rejects when it differs, so a Timeline
// Agent re-run (which rewrites outputJson from client answers) between Tyler's
// review and his click cannot silently apply an UNREVIEWED draft (and delete
// the previously applied items via replace-by-source).
export function timelineDraftVersion(outputJson: string | null): string {
  return createHash("sha256").update(outputJson ?? "").digest("hex").slice(0, 32);
}

// M5: draft `startAt` values are 12-hour strings like "02:00 PM" (the exact
// format `maybeTime` in timeline-draft.ts produces), never ISO. Written
// straight through they break `formatDate` (renders "Date TBD"), the
// `datetime-local` edit input, and the client portal rendering. This composes
// project.eventDate + the parsed time into an ISO `startAt`; when the time is
// unparsable (or there's no event date to anchor to), `startAt` stays null and
// the raw text is carried in the description instead of a non-ISO `startAt`.
function parseTwelveHourTime(value: string): { hour: number; minute: number } | null {
  const match = value.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  const minute = Number(match[2]);
  let hour = Number(match[1]);
  if (!Number.isFinite(hour) || hour < 1 || hour > 12 || !Number.isFinite(minute) || minute < 0 || minute > 59) return null;
  const meridiem = match[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return { hour, minute };
}

function composeTimelineDraftStartAt(
  eventDate: string | null,
  rawStartAt: string | null | undefined,
): { startAt: string | null; unparsedText: string | null } {
  if (!rawStartAt) return { startAt: null, unparsedText: null };
  const parsed = eventDate ? parseTwelveHourTime(rawStartAt) : null;
  if (!parsed) return { startAt: null, unparsedText: rawStartAt };

  const hh = String(parsed.hour).padStart(2, "0");
  const mm = String(parsed.minute).padStart(2, "0");
  // MINOR-5: store a NAIVE local datetime (no `Z`) matching the `datetime-local`
  // edit-input format hand-entered timeline items use. Stamping ET wall-clock as
  // `Z` would shift 4–5h the moment any America/New_York-aware formatter (e.g.
  // the reminder email's formatDateTime) renders the item.
  return { startAt: `${eventDate}T${hh}:${mm}`, unparsedText: null };
}

export type ApplyProjectTimelineDraftResult =
  | { ok: true; timelineItems: Awaited<ReturnType<typeof createProjectTimelineItemsFromAgent>> }
  | { ok: false; error: string }
  | { ok: false; needsConfirm: true; handEditedCount: number };

/**
 * Applies a completed Timeline Agent task's draft (`outputJson.timelineDraft`)
 * via the existing idempotent replace-by-source path
 * (`createProjectTimelineItemsFromAgent`). Rev-2 hardening:
 *   - M4 hand-edit protection: `replaceExistingForSource` deletes ALL rows
 *     carrying that sourceId, including ones Tyler hand-edited after a prior
 *     apply (edits preserve the source link). If any existing source-linked
 *     item has `updatedAt > createdAt` (was hand-edited) and the caller hasn't
 *     confirmed, this returns `needsConfirm` instead of silently replacing.
 *   - M5 ISO `startAt` composition (see `composeTimelineDraftStartAt`).
 *   - Route validation: `outputJson.projectId` must match `projectId` (reject
 *     cross-project apply); friendly errors for a missing `projectSourceId` or
 *     empty `timelineItems` instead of the raw errors
 *     `createProjectTimelineItemsFromAgent` would throw.
 */
export async function applyProjectTimelineDraft({
  projectId,
  outputJson,
  confirmReplace,
  actorName = "Tyler",
}: {
  projectId: string;
  outputJson: string | null;
  confirmReplace: boolean;
  actorName?: string;
}): Promise<ApplyProjectTimelineDraftResult> {
  const parsed = parseTimelineDraftOutput(outputJson);
  if (!parsed?.timelineDraft) {
    return { ok: false, error: "This draft has no timeline items to apply." };
  }
  if (parsed.projectId && parsed.projectId !== projectId) {
    return { ok: false, error: "This draft belongs to a different project." };
  }

  const projectSourceId = cleanText(parsed.projectSourceId ?? null);
  if (!projectSourceId) {
    return { ok: false, error: "This draft has no source link; regenerate it before applying." };
  }

  const timelineItems = parsed.timelineDraft.timelineItems ?? [];
  if (!timelineItems.length) {
    return { ok: false, error: "This draft has no timeline items to apply." };
  }

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) {
    return { ok: false, error: "Project not found." };
  }

  const existingSourceItems = await db.query.projectTimelineItems.findMany({
    where: and(
      eq(projectTimelineItems.projectId, projectId),
      eq(projectTimelineItems.sourceType, "project_source"),
      eq(projectTimelineItems.sourceId, projectSourceId),
    ),
  });
  const handEditedCount = existingSourceItems.filter((item) => item.updatedAt > item.createdAt).length;
  if (handEditedCount > 0 && !confirmReplace) {
    return { ok: false, needsConfirm: true, handEditedCount };
  }

  const mappedItems: CreateProjectTimelineItemInput[] = timelineItems.map((item) => {
    const { startAt, unparsedText } = composeTimelineDraftStartAt(project.eventDate, item.startAt);
    const description = unparsedText
      ? [item.description, `Draft time (unparsed): ${unparsedText}`].filter(Boolean).join("\n\n") || null
      : item.description ?? null;
    return { title: item.title, description, startAt, endAt: null };
  });

  const created = await createProjectTimelineItemsFromAgent(projectId, {
    sourceType: "project_source",
    sourceId: projectSourceId,
    replaceExistingForSource: true,
    timelineItems: mappedItems,
  });

  await db.insert(activityLogs).values({
    id: crypto.randomUUID(),
    projectId,
    clientId: null,
    action: "questionnaire.timeline_draft.applied",
    actorType: "admin",
    actorName,
    metadata: JSON.stringify({ projectSourceId, itemCount: created.length, replacedHandEdited: handEditedCount }),
    createdAt: new Date().toISOString(),
  });

  return { ok: true, timelineItems: created };
}
