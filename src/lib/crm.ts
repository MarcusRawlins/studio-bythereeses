import { db } from "@/db/client";
import { activityLogs, clients, invoicePayments, invoices, portalAccessTokens, projectCommunications, projectEvents, projectGalleries, projectLocations, projectParticipants, projectSources, projectTimelineItems, projects, proposalAccessTokens, proposals, questionnaireResponses, questionnaires, schedulerBookings, schedulerMeetingTypes } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { createGoogleCalendarAllDayEvent, deleteGoogleCalendarEvent, updateGoogleCalendarAllDayEvent } from "@/lib/google-calendar";
import { invoiceClientPayableBalanceCents } from "@/lib/invoice-balances";
import { generatePortalLink, revokePortalToken } from "@/lib/portal";
import { projectEventCalendarStatusAfterEdit } from "@/lib/project-event-calendar";
import { getSchedulerSettings } from "@/lib/scheduler";
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const projectStages = [
  "inquiry",
  "proposal_sent",
  "retainer_paid",
  "planning",
  "editing",
  "delivered",
  "completed",
];

export const projectStageOptions = projectStages.map((value) => ({
  value,
  label: value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()),
}));

export type ProjectIndexSort = "eventDate" | "createdAt" | "name";

export type AgentProjectUpdateInput = {
  name?: string | null;
  type?: string | null;
  stage?: string | null;
  status?: string | null;
  primaryClientId?: string | null;
  eventDate?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  city?: string | null;
  state?: string | null;
  budgetCents?: number | null;
  notes?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

export type AgentProjectCreateInput = {
  name?: string | null;
  type?: string | null;
  stage?: string | null;
  status?: string | null;
  eventDate?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  city?: string | null;
  state?: string | null;
  budgetCents?: number | null;
  notes?: string | null;
  primaryClient?: {
    clientId?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    preferredName?: string | null;
    email?: string | null;
    phone?: string | null;
    instagramHandle?: string | null;
    communicationPreference?: string | null;
    referralSource?: string | null;
    role?: string | null;
  } | null;
  intakeSource?: {
    kind?: string | null;
    title?: string | null;
    body?: string | null;
    summary?: string | null;
    occurredAt?: string | null;
    externalUrl?: string | null;
    capturedBy?: string | null;
    sourceType?: string | null;
    sourceId?: string | null;
    metadata?: unknown;
  } | null;
};

export type AgentClientUpdateInput = {
  firstName?: string | null;
  lastName?: string | null;
  preferredName?: string | null;
  email?: string | null;
  phone?: string | null;
  instagramHandle?: string | null;
  communicationPreference?: string | null;
  referralSource?: string | null;
  notes?: string | null;
};

export type AgentProjectEventInput = {
  type?: string | null;
  title?: string | null;
  eventDate?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  city?: string | null;
  state?: string | null;
  notes?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

export type AgentProjectLocationInput = {
  type?: string | null;
  name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  notes?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

function toCents(value: FormDataEntryValue | null) {
  const number = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number * 100);
}

function textValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function nullableTextValue(formData: FormData, key: string) {
  return textValue(formData, key) || null;
}

function checkedValue(formData: FormData, key: string) {
  return formData.get(key) === "on" || formData.get(key) === "true";
}

function formValues(formData: FormData, key: string) {
  return formData.getAll(key).map((value) => String(value ?? "").trim());
}

function at(values: string[], index: number) {
  return values[index]?.trim() || null;
}

function customType(type: string | null, custom: string | null) {
  return type === "other" && custom ? custom : type || "other";
}

function nonPrimaryParticipantRole(role: string) {
  return role.trim().toLowerCase() === "primary" ? "participant" : role;
}

function joinedText(...parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(", ");
}

function calendarDescription(...parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join("\n");
}

function safeRevalidatePath(path: string) {
  try {
    revalidatePath(path);
  } catch (error) {
    if (error instanceof Error && error.message.includes("static generation store missing")) {
      return;
    }
    throw error;
  }
}

function projectStageValue(value: FormDataEntryValue | null) {
  const stage = String(value ?? "inquiry");
  if (!projectStages.includes(stage)) return "inquiry";
  return stage;
}

function cleanAgentText(value: string | null | undefined) {
  return value?.trim() || null;
}

function cleanAgentEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() || null;
}

function cleanInstagramHandle(value: string | null | undefined) {
  const cleaned = cleanAgentText(value);
  if (!cleaned) return null;
  return cleaned.startsWith("@") ? cleaned : `@${cleaned}`;
}

function hasOwn(input: object, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

async function assertAgentProjectSource(projectId: string, sourceType: string | null, sourceId: string | null, label = "Project event") {
  if (!sourceType && sourceId) {
    throw new Error(`${label} source links require sourceType when sourceId is set.`);
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

export async function listProjects() {
  const rows = await db
    .select({
      project: projects,
      client: clients,
      participant: projectParticipants,
    })
    .from(projects)
    .leftJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .orderBy(desc(projects.createdAt), desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt)) as unknown as Array<{
      project: typeof projects.$inferSelect;
      client: typeof clients.$inferSelect;
      participant: typeof projectParticipants.$inferSelect | null;
    }>;

  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.project.id)) return false;
    seen.add(row.project.id);
    return true;
  }).map(({ project, client }) => ({ project, client }));
}

function projectIndexSearchCondition(search: string) {
  const normalized = search.trim().toLowerCase();
  if (!normalized) return undefined;
  const pattern = `%${normalized}%`;
  return or(
    sql`lower(coalesce(${projects.name}, '')) like ${pattern}`,
    sql`lower(coalesce(${projects.stage}, '')) like ${pattern}`,
    sql`lower(coalesce(${projects.type}, '')) like ${pattern}`,
    sql`lower(coalesce(${projects.venueName}, '')) like ${pattern}`,
    sql`lower(coalesce(${projects.venueAddress}, '')) like ${pattern}`,
    sql`lower(coalesce(${projects.city}, '')) like ${pattern}`,
    sql`lower(coalesce(${projects.state}, '')) like ${pattern}`,
    sql`lower(coalesce(${clients.firstName}, '')) like ${pattern}`,
    sql`lower(coalesce(${clients.lastName}, '')) like ${pattern}`,
    sql`lower(coalesce(${clients.email}, '')) like ${pattern}`,
    sql`lower(coalesce(${clients.instagramHandle}, '')) like ${pattern}`,
    sql`lower(coalesce(${clients.referralSource}, '')) like ${pattern}`,
  );
}

function projectIndexWhere(input: { q?: string | null; stages?: string[] | null }) {
  const conditions = [eq(projects.status, "active")];
  const searchCondition = projectIndexSearchCondition(input.q ?? "");
  if (searchCondition) conditions.push(searchCondition);

  const stages = (input.stages ?? []).filter((stage) => projectStages.includes(stage));
  if (stages.length) conditions.push(inArray(projects.stage, stages));

  return and(...conditions);
}

function projectIndexOrderBy(sort: ProjectIndexSort) {
  if (sort === "name") return [asc(projects.name), asc(projects.eventDate), asc(projects.createdAt)];
  if (sort === "createdAt") return [desc(projects.createdAt), asc(projects.name)];
  return [asc(sql`coalesce(${projects.eventDate}, '9999-12-31')`), asc(projects.name), asc(projects.createdAt)];
}

export async function listProjectIndex(input: {
  q?: string | null;
  stages?: string[] | null;
  sort?: ProjectIndexSort | null;
  page?: number | null;
  pageSize?: number | null;
} = {}) {
  const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? 50), 1), 200);
  const requestedPage = Math.max(Math.trunc(input.page ?? 1), 1);
  const sort = input.sort === "createdAt" || input.sort === "name" ? input.sort : "eventDate";
  const where = projectIndexWhere(input);
  const primaryParticipantJoin = and(
    eq(projectParticipants.projectId, projects.id),
    eq(projectParticipants.isPrimaryContact, true),
  );

  const [totalRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(projects)
    .where(eq(projects.status, "active"));
  const totalCount = Number(totalRow?.count ?? 0);

  const filteredCountQuery = db
    .select({ count: sql<number>`count(distinct ${projects.id})` })
    .from(projects)
    .leftJoin(projectParticipants, primaryParticipantJoin)
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .$dynamic();
  const [filteredRow] = await (where ? filteredCountQuery.where(where) : filteredCountQuery);
  const filteredCount = Number(filteredRow?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(filteredCount / pageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const rowsQuery = db
    .select({
      project: projects,
      client: clients,
    })
    .from(projects)
    .leftJoin(projectParticipants, primaryParticipantJoin)
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .$dynamic();
  const filteredRowsQuery = where ? rowsQuery.where(where) : rowsQuery;
  const rows = await filteredRowsQuery
    .orderBy(...projectIndexOrderBy(sort))
    .limit(pageSize)
    .offset(offset) as Array<{
      project: typeof projects.$inferSelect;
      client: typeof clients.$inferSelect | null;
    }>;

  return {
    rows,
    totalCount,
    filteredCount,
    totalPages,
    currentPage,
    pageSize,
    rangeStart: filteredCount ? offset + 1 : 0,
    rangeEnd: offset + rows.length,
  };
}

export async function listClients() {
  const rows = await db
    .select({
      client: clients,
      project: projects,
    })
    .from(clients)
    .leftJoin(projectParticipants, eq(projectParticipants.clientId, clients.id))
    .leftJoin(projects, eq(projectParticipants.projectId, projects.id))
    .orderBy(desc(clients.createdAt));

  const clientMap = new Map<string, { client: typeof clients.$inferSelect; projectCount: number; latestProjectDate: string | null }>();

  for (const row of rows) {
    const existing = clientMap.get(row.client.id) ?? {
      client: row.client,
      projectCount: 0,
      latestProjectDate: null,
    };

    if (row.project) {
      existing.projectCount += 1;
      const projectDate = row.project.eventDate ?? row.project.createdAt;
      if (!existing.latestProjectDate || String(projectDate).localeCompare(existing.latestProjectDate) > 0) {
        existing.latestProjectDate = projectDate;
      }
    }

    clientMap.set(row.client.id, existing);
  }

  return Array.from(clientMap.values());
}

export async function listClientMergeCandidates(clientId: string) {
  const id = cleanAgentText(clientId);
  if (!id) return [];

  return db.query.clients.findMany({
    where: sql`${clients.id} <> ${id}`,
    orderBy: asc(clients.lastName),
  });
}

export async function listRecentActivity(limit = 6) {
  return db.query.activityLogs.findMany({
    orderBy: desc(activityLogs.createdAt),
    limit,
  });
}

export async function getProject(projectId: string) {
  const rows = await db
    .select({
      project: projects,
      client: clients,
      participant: projectParticipants,
    })
    .from(projectParticipants)
    .innerJoin(projects, eq(projectParticipants.projectId, projects.id))
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(projects.id, projectId))
    .orderBy(desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt));

  const project = rows[0]?.project;
  if (!project) return null;

  const [tokens, activity, events, locations, timelineItems, sources, communications, projectProposals, projectInvoices] = await Promise.all([
    db.query.portalAccessTokens.findMany({
      where: eq(portalAccessTokens.projectId, projectId),
      orderBy: desc(portalAccessTokens.createdAt),
    }),
    db.query.activityLogs.findMany({
      where: eq(activityLogs.projectId, projectId),
      orderBy: desc(activityLogs.createdAt),
      limit: 12,
    }),
    db.query.projectEvents.findMany({
      where: eq(projectEvents.projectId, projectId),
      orderBy: desc(projectEvents.eventDate),
    }),
    db.query.projectLocations.findMany({
      where: eq(projectLocations.projectId, projectId),
      orderBy: desc(projectLocations.createdAt),
    }),
    db.query.projectTimelineItems.findMany({
      where: eq(projectTimelineItems.projectId, projectId),
      orderBy: asc(projectTimelineItems.sortOrder),
    }),
    db.query.projectSources.findMany({
      where: eq(projectSources.projectId, projectId),
      orderBy: desc(projectSources.createdAt),
    }),
    db.query.projectCommunications.findMany({
      where: eq(projectCommunications.projectId, projectId),
      orderBy: desc(projectCommunications.createdAt),
    }),
    db.query.proposals.findMany({
      where: eq(proposals.projectId, projectId),
      orderBy: desc(proposals.createdAt),
    }),
    db.query.invoices.findMany({
      where: eq(invoices.projectId, projectId),
      orderBy: desc(invoices.createdAt),
    }),
  ]);
  const projectInvoiceIds = projectInvoices.map((invoice) => invoice.id);
  const projectInvoicePayments = projectInvoiceIds.length
    ? await db.query.invoicePayments.findMany({
        where: (payment, { inArray }) => inArray(payment.invoiceId, projectInvoiceIds),
      })
    : [];
  const paymentsByInvoice = new Map<string, Array<typeof invoicePayments.$inferSelect>>();
  for (const payment of projectInvoicePayments) {
    paymentsByInvoice.set(payment.invoiceId, [...(paymentsByInvoice.get(payment.invoiceId) ?? []), payment]);
  }

  // Phase 7a: defense-in-depth try/catch here too (this record also feeds the
  // always-on `studio_get_project_context` agent reader via
  // `projectContextResult(await getProject(projectId))`) — a missing
  // project_galleries table degrades to `[]` instead of breaking the project
  // detail page or the agent tool.
  let galleries: Array<typeof projectGalleries.$inferSelect> = [];
  try {
    galleries = await db.query.projectGalleries.findMany({
      where: eq(projectGalleries.projectId, projectId),
      orderBy: [desc(projectGalleries.deliveredAt), desc(projectGalleries.createdAt)],
    });
  } catch (error) {
    console.error("project_galleries read failed; returning []", error);
    galleries = [];
  }

  return {
    project,
    clients: rows.map((row) => row.client),
    participants: rows.map((row) => ({
      client: row.client,
      role: row.participant.role,
      isPrimaryContact: row.participant.isPrimaryContact,
    })),
    events,
    locations,
    timelineItems,
    sources,
    communications,
    proposals: projectProposals,
    invoices: projectInvoices.map((invoice) => ({
      ...invoice,
      clientPayableBalanceCents: invoiceClientPayableBalanceCents(invoice, paymentsByInvoice.get(invoice.id) ?? []),
    })),
    galleries,
    tokens,
    activity,
  };
}

export async function getClientWithProjects(clientId: string) {
  const client = await db.query.clients.findFirst({
    where: eq(clients.id, clientId),
  });
  if (!client) return null;

  const linkedProjects = await db
    .select({
      project: projects,
      participant: projectParticipants,
    })
    .from(projectParticipants)
    .innerJoin(projects, eq(projectParticipants.projectId, projects.id))
    .where(eq(projectParticipants.clientId, clientId))
    .orderBy(desc(projects.createdAt)) as unknown as Array<{
      project: typeof projects.$inferSelect;
      participant: typeof projectParticipants.$inferSelect;
    }>;
  const linkedProjectIds = linkedProjects.map(({ project }) => project.id);

  const [bookings, clientProposals, clientInvoices, paymentRows, clientQuestionnaireResponses, clientActivity] = await Promise.all([
    db
      .select({
        id: schedulerBookings.id,
        startAt: schedulerBookings.startAt,
        endAt: schedulerBookings.endAt,
        status: schedulerBookings.status,
        cancelledAt: schedulerBookings.cancelledAt,
        attendeeName: schedulerBookings.attendeeName,
        attendeeEmail: schedulerBookings.attendeeEmail,
        paymentStatus: schedulerBookings.paymentStatus,
        calendarSyncStatus: schedulerBookings.calendarSyncStatus,
        meetingName: schedulerMeetingTypes.name,
        projectId: projects.id,
        projectName: projects.name,
      })
      .from(schedulerBookings)
      .innerJoin(schedulerMeetingTypes, eq(schedulerBookings.meetingTypeId, schedulerMeetingTypes.id))
      .leftJoin(projects, eq(schedulerBookings.projectId, projects.id))
      .where(eq(schedulerBookings.clientId, clientId))
      .orderBy(desc(schedulerBookings.startAt)),
    linkedProjectIds.length
      ? db
        .select({
          id: proposals.id,
          projectId: proposals.projectId,
          projectName: projects.name,
          title: proposals.title,
          status: proposals.status,
          totalCents: proposals.totalCents,
          sentAt: proposals.sentAt,
          acceptedAt: proposals.acceptedAt,
          signedAt: proposals.signedAt,
          invoiceStatus: proposals.invoiceStatus,
          createdAt: proposals.createdAt,
        })
        .from(proposals)
        .innerJoin(projects, eq(proposals.projectId, projects.id))
        .where(inArray(proposals.projectId, linkedProjectIds))
        .orderBy(desc(proposals.createdAt))
      : Promise.resolve([]),
    linkedProjectIds.length
      ? db
        .select({
          id: invoices.id,
          projectId: invoices.projectId,
          projectName: projects.name,
          proposalId: invoices.proposalId,
          invoiceNumber: invoices.invoiceNumber,
          status: invoices.status,
          totalCents: invoices.totalCents,
          amountPaidCents: invoices.amountPaidCents,
          dueDate: invoices.dueDate,
          cardFeePolicy: invoices.cardFeePolicy,
          cardFeeAmountCents: invoices.cardFeeAmountCents,
          createdAt: invoices.createdAt,
        })
        .from(invoices)
        .innerJoin(projects, eq(invoices.projectId, projects.id))
        .where(inArray(invoices.projectId, linkedProjectIds))
        .orderBy(desc(invoices.createdAt))
      : Promise.resolve([]),
    linkedProjectIds.length
      ? db
        .select({
          invoiceId: invoicePayments.invoiceId,
          dueDate: invoicePayments.dueDate,
          status: invoicePayments.status,
          amountCents: invoicePayments.amountCents,
          paidAmountCents: invoicePayments.paidAmountCents,
          grossCollectedCents: invoicePayments.grossCollectedCents,
        })
        .from(invoicePayments)
        .innerJoin(invoices, eq(invoicePayments.invoiceId, invoices.id))
        .where(inArray(invoices.projectId, linkedProjectIds))
        .orderBy(asc(invoicePayments.dueDate))
      : Promise.resolve([]),
    db
      .select({
        id: questionnaireResponses.id,
        questionnaireId: questionnaireResponses.questionnaireId,
        questionnaireTitle: questionnaires.title,
        projectId: projects.id,
        projectName: projects.name,
        submittedAt: questionnaireResponses.submittedAt,
        updatedAt: questionnaireResponses.updatedAt,
        createdAt: questionnaireResponses.createdAt,
      })
      .from(questionnaireResponses)
      .innerJoin(questionnaires, eq(questionnaireResponses.questionnaireId, questionnaires.id))
      .leftJoin(projects, eq(questionnaireResponses.projectId, projects.id))
      .where(eq(questionnaireResponses.clientId, clientId))
      .orderBy(desc(questionnaireResponses.updatedAt)),
    db.query.activityLogs.findMany({
      where: linkedProjectIds.length
        ? or(eq(activityLogs.clientId, clientId), inArray(activityLogs.projectId, linkedProjectIds))
        : eq(activityLogs.clientId, clientId),
      orderBy: desc(activityLogs.createdAt),
      limit: 12,
    }),
  ]);

  const nextPaymentByInvoice = new Map<string, string | null>();
  const paymentsByInvoice = new Map<string, typeof paymentRows>();
  for (const row of paymentRows) {
    paymentsByInvoice.set(row.invoiceId, [...(paymentsByInvoice.get(row.invoiceId) ?? []), row]);
    if (row.status === "paid" || row.status === "waived") continue;
    if (nextPaymentByInvoice.has(row.invoiceId)) continue;
    nextPaymentByInvoice.set(row.invoiceId, row.dueDate);
  }

  return {
    client,
    projects: linkedProjects,
    bookings,
    proposals: clientProposals,
    invoices: clientInvoices.map((invoice) => ({
      ...invoice,
      openBalanceCents: invoiceClientPayableBalanceCents(invoice, paymentsByInvoice.get(invoice.id) ?? []),
      nextPaymentDueDate: nextPaymentByInvoice.get(invoice.id) ?? null,
    })),
    questionnaireResponses: clientQuestionnaireResponses.map((response) => ({
      ...response,
      status: response.submittedAt ? "submitted" : "draft",
    })),
    activity: clientActivity,
  };
}

export async function listProjectsForClientLink(clientId: string) {
  const linkedRows = await db.query.projectParticipants.findMany({
    where: eq(projectParticipants.clientId, clientId),
  });
  if (linkedRows.length === 0) {
    return db.query.projects.findMany({
      orderBy: desc(projects.createdAt),
    });
  }

  return db.query.projects.findMany({
    where: notInArray(projects.id, linkedRows.map((row) => row.projectId)),
    orderBy: desc(projects.createdAt),
  });
}

export async function listProjectIdsForClient(clientId: string) {
  const linkedRows = await db.query.projectParticipants.findMany({
    where: eq(projectParticipants.clientId, clientId),
    orderBy: asc(projectParticipants.createdAt),
  });
  return linkedRows.map((row) => row.projectId);
}

function uniqueValues(values: string[]) {
  return [...new Set(values)];
}

function revalidateClientProjectSurfaces(projectIds: string[]) {
  safeRevalidatePath("/projects");
  for (const projectId of projectIds) {
    safeRevalidatePath(`/projects/${projectId}`);
  }
}

function clientDisplayName(client: typeof clients.$inferSelect) {
  return [client.firstName, client.lastName].filter(Boolean).join(" ") || client.preferredName || client.email;
}

function mergedClientNotes(survivor: typeof clients.$inferSelect, duplicate: typeof clients.$inferSelect) {
  const survivorNotes = survivor.notes?.trim() || null;
  const duplicateNotes = duplicate.notes?.trim() || null;
  if (!duplicateNotes) return survivor.notes;

  const duplicateLabel = `${clientDisplayName(duplicate)} <${duplicate.email}>`;
  const mergedNote = `Merged from ${duplicateLabel}:\n${duplicateNotes}`;
  return survivorNotes ? `${survivorNotes}\n\n${mergedNote}` : mergedNote;
}

export async function mergeClients({
  survivorClientId,
  duplicateClientId,
  actorType = "admin",
  actorName = "The Reeses Studio",
}: {
  survivorClientId: string;
  duplicateClientId: string;
  actorType?: "admin" | "agent" | "client" | "system";
  actorName?: string | null;
}) {
  const survivorId = cleanAgentText(survivorClientId);
  const duplicateId = cleanAgentText(duplicateClientId);
  if (!survivorId || !duplicateId) {
    throw new Error("Both survivor and duplicate client ids are required.");
  }
  if (survivorId === duplicateId) {
    throw new Error("A client cannot be merged into itself.");
  }

  const [survivor, duplicate] = await Promise.all([
    db.query.clients.findFirst({ where: eq(clients.id, survivorId) }),
    db.query.clients.findFirst({ where: eq(clients.id, duplicateId) }),
  ]);
  if (!survivor) throw new Error("Surviving client not found.");
  if (!duplicate) throw new Error("Duplicate client not found.");

  const [survivorParticipants, duplicateParticipants] = await Promise.all([
    db.query.projectParticipants.findMany({ where: eq(projectParticipants.clientId, survivorId) }),
    db.query.projectParticipants.findMany({ where: eq(projectParticipants.clientId, duplicateId) }),
  ]);
  const survivorByProject = new Map(survivorParticipants.map((participant) => [participant.projectId, participant]));
  const linkedProjectIds = uniqueValues([
    ...survivorParticipants.map((participant) => participant.projectId),
    ...duplicateParticipants.map((participant) => participant.projectId),
  ]);
  const now = new Date().toISOString();

  for (const duplicateParticipant of duplicateParticipants) {
    const survivorParticipant = survivorByProject.get(duplicateParticipant.projectId);
    if (survivorParticipant) {
      await db.delete(projectParticipants).where(eq(projectParticipants.id, duplicateParticipant.id));
      if (duplicateParticipant.isPrimaryContact && !survivorParticipant.isPrimaryContact) {
        await db.update(projectParticipants)
          .set({ isPrimaryContact: true })
          .where(eq(projectParticipants.id, survivorParticipant.id));
      }
      continue;
    }

    await db.update(projectParticipants)
      .set({ clientId: survivorId })
      .where(eq(projectParticipants.id, duplicateParticipant.id));
  }

  await db.update(schedulerBookings).set({ clientId: survivorId, updatedAt: now }).where(eq(schedulerBookings.clientId, duplicateId));
  await db.update(questionnaireResponses).set({ clientId: survivorId, updatedAt: now }).where(eq(questionnaireResponses.clientId, duplicateId));
  await db.update(projectCommunications).set({ clientId: survivorId, updatedAt: now }).where(eq(projectCommunications.clientId, duplicateId));
  await db.update(proposalAccessTokens).set({ clientId: survivorId }).where(eq(proposalAccessTokens.clientId, duplicateId));
  await db.update(portalAccessTokens).set({ clientId: survivorId }).where(eq(portalAccessTokens.clientId, duplicateId));
  await db.update(activityLogs).set({ clientId: survivorId }).where(eq(activityLogs.clientId, duplicateId));

  const updates = {
    lastName: survivor.lastName || duplicate.lastName,
    preferredName: survivor.preferredName || duplicate.preferredName,
    phone: survivor.phone || duplicate.phone,
    instagramHandle: survivor.instagramHandle || duplicate.instagramHandle,
    communicationPreference: survivor.communicationPreference || duplicate.communicationPreference,
    referralSource: survivor.referralSource || duplicate.referralSource,
    notes: mergedClientNotes(survivor, duplicate),
    updatedAt: now,
  };

  await db.update(clients)
    .set(updates)
    .where(eq(clients.id, survivorId));
  await db.delete(clients).where(eq(clients.id, duplicateId));

  await logActivity({
    action: "client.merged",
    clientId: survivorId,
    actorType,
    actorName: actorName?.trim() || "The Reeses Studio",
    metadata: {
      duplicateClientId: duplicateId,
      duplicateEmail: duplicate.email,
      survivorEmail: survivor.email,
      movedProjectIds: linkedProjectIds,
    },
  });

  safeRevalidatePath("/clients");
  safeRevalidatePath(`/clients/${survivorId}`);
  safeRevalidatePath(`/clients/${duplicateId}`);
  revalidateClientProjectSurfaces(linkedProjectIds);

  return {
    survivorClientId: survivorId,
    duplicateClientId: duplicateId,
    linkedProjectIds,
  };
}

export async function ensureEngagementPlaceholder(projectId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) {
    throw new Error("Project not found.");
  }

  const existing = await db.query.projectEvents.findFirst({
    where: and(
      eq(projectEvents.projectId, projectId),
      eq(projectEvents.type, "engagement"),
    ),
    orderBy: asc(projectEvents.createdAt),
  });
  if (existing) return existing.id;

  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();
  await db.insert(projectEvents).values({
    id: eventId,
    projectId,
    type: "engagement",
    title: "Engagement session",
    eventDate: null,
    venueName: null,
    venueAddress: null,
    city: null,
    state: null,
    googleCalendarEventId: null,
    calendarSyncStatus: "not_connected",
    notes: null,
    createdAt: now,
    updatedAt: now,
  });

  return eventId;
}

export async function removeEngagementPlaceholderIfUnscheduled(projectId: string) {
  await db.delete(projectEvents).where(and(
    eq(projectEvents.projectId, projectId),
    eq(projectEvents.type, "engagement"),
    isNull(projectEvents.eventDate),
  ));
}

async function reconcileEngagementSessionIncluded(projectId: string, included: boolean) {
  if (included) {
    await ensureEngagementPlaceholder(projectId);
    return;
  }

  await removeEngagementPlaceholderIfUnscheduled(projectId);
}

async function findOrCreateClient({
  firstName,
  lastName,
  preferredName,
  email,
  phone,
  instagramHandle,
  communicationPreference,
  referralSource,
  now,
}: {
  firstName: string;
  lastName: string | null;
  preferredName: string | null;
  email: string;
  phone: string | null;
  instagramHandle: string | null;
  communicationPreference: string | null;
  referralSource: string | null;
  now: string;
}) {
  const existing = await findClientByNormalizedEmail(email);
  if (existing) {
    const updates = {
      lastName: existing.lastName || lastName,
      preferredName: existing.preferredName || preferredName,
      email,
      phone: existing.phone || phone,
      instagramHandle: existing.instagramHandle || instagramHandle,
      communicationPreference: existing.communicationPreference || communicationPreference,
      referralSource: existing.referralSource || referralSource,
    };
    if (
      updates.lastName !== existing.lastName
      || updates.preferredName !== existing.preferredName
      || updates.email !== existing.email
      || updates.phone !== existing.phone
      || updates.instagramHandle !== existing.instagramHandle
      || updates.communicationPreference !== existing.communicationPreference
      || updates.referralSource !== existing.referralSource
    ) {
      await db.update(clients).set({
        ...updates,
        updatedAt: now,
      }).where(eq(clients.id, existing.id));
    }
    return existing.id;
  }

  const clientId = crypto.randomUUID();
  await db.insert(clients).values({
    id: clientId,
    firstName,
    lastName,
    email,
    phone,
    preferredName: preferredName || firstName,
    instagramHandle,
    communicationPreference,
    referralSource,
    notes: null,
    createdAt: now,
    updatedAt: now,
  });
  return clientId;
}

async function findClientByNormalizedEmail(email: string) {
  return db.query.clients.findFirst({
    where: sql`lower(trim(${clients.email})) = ${email}`,
  });
}

export async function createProjectFromForm(formData: FormData) {
  const now = new Date().toISOString();
  const projectId = crypto.randomUUID();

  const firstName = String(formData.get("firstName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const projectName = String(formData.get("projectName") ?? "").trim();

  if (!firstName || !email || !projectName) {
    throw new Error("Client first name, email, and project name are required.");
  }

  const primaryClientId = await findOrCreateClient({
    firstName,
    lastName: nullableTextValue(formData, "lastName"),
    preferredName: nullableTextValue(formData, "preferredName"),
    email,
    phone: nullableTextValue(formData, "phone"),
    instagramHandle: cleanInstagramHandle(String(formData.get("instagramHandle") ?? "")),
    communicationPreference: nullableTextValue(formData, "communicationPreference"),
    referralSource: nullableTextValue(formData, "referralSource"),
    now,
  });

  const eventDate = nullableTextValue(formData, "eventDate");
  const venueName = nullableTextValue(formData, "venueName");
  const venueAddress = nullableTextValue(formData, "venueAddress");
  const city = nullableTextValue(formData, "city");
  const state = nullableTextValue(formData, "state");
  const calendarSyncStatus = eventDate ? "needs_google_connection" : "not_connected";
  const engagementSessionIncluded = checkedValue(formData, "engagementSessionIncluded");

  await db.insert(projects).values({
    id: projectId,
    name: projectName,
    type: String(formData.get("type") ?? "wedding"),
    stage: projectStageValue(formData.get("stage")),
    status: "active",
    eventDate,
    venueName,
    venueAddress,
    city,
    state,
    budgetCents: toCents(formData.get("budget")),
    calendarSyncStatus,
    notes: String(formData.get("notes") ?? "").trim() || null,
    createdAt: now,
    updatedAt: now,
  });

  if (eventDate || venueName || venueAddress) {
    await db.insert(projectEvents).values({
      id: crypto.randomUUID(),
      projectId,
      type: "wedding",
      title: "Wedding day",
      eventDate,
      venueName,
      venueAddress,
      city,
      state,
      calendarSyncStatus,
      createdAt: now,
      updatedAt: now,
    });
  }

  const eventTitles = formValues(formData, "projectEventTitle");
  const eventDates = formValues(formData, "projectEventDate");
  const eventTypes = formValues(formData, "projectEventType");
  const eventCustomTypes = formValues(formData, "projectEventCustomType");
  const eventVenues = formValues(formData, "projectEventVenueName");
  const eventAddresses = formValues(formData, "projectEventVenueAddress");
  const eventCities = formValues(formData, "projectEventCity");
  const eventStates = formValues(formData, "projectEventState");

  for (let index = 0; index < eventTitles.length; index += 1) {
    const title = at(eventTitles, index);
    const date = at(eventDates, index);
    const eventVenue = at(eventVenues, index);
    const eventAddress = at(eventAddresses, index);
    if (!title && !date && !eventVenue && !eventAddress) continue;

    await db.insert(projectEvents).values({
      id: crypto.randomUUID(),
      projectId,
      type: customType(at(eventTypes, index), at(eventCustomTypes, index)),
      title: title || "Additional project event",
      eventDate: date,
      venueName: eventVenue,
      venueAddress: eventAddress,
      city: at(eventCities, index),
      state: at(eventStates, index),
      calendarSyncStatus: date ? "needs_google_connection" : "not_connected",
      createdAt: now,
      updatedAt: now,
    });
  }

  const locationNames = formValues(formData, "projectLocationName");
  const locationAddresses = formValues(formData, "projectLocationAddress");
  const locationTypes = formValues(formData, "projectLocationType");
  const locationCustomTypes = formValues(formData, "projectLocationCustomType");
  const locationCities = formValues(formData, "projectLocationCity");
  const locationStates = formValues(formData, "projectLocationState");
  const locationNotes = formValues(formData, "projectLocationNotes");

  for (let index = 0; index < locationNames.length; index += 1) {
    const name = at(locationNames, index);
    const address = at(locationAddresses, index);
    if (!name && !address) continue;

    await db.insert(projectLocations).values({
      id: crypto.randomUUID(),
      projectId,
      type: customType(at(locationTypes, index), at(locationCustomTypes, index)),
      name: name || "Project location",
      address,
      city: at(locationCities, index),
      state: at(locationStates, index),
      notes: at(locationNotes, index),
      createdAt: now,
      updatedAt: now,
    });
  }

  await db.insert(projectParticipants).values({
    id: crypto.randomUUID(),
    projectId,
    clientId: primaryClientId,
    role: textValue(formData, "primaryClientRole") || "primary",
    isPrimaryContact: true,
    createdAt: now,
  });
  const projectClientIds = new Set([primaryClientId]);

  if (engagementSessionIncluded) {
    await ensureEngagementPlaceholder(projectId);
  }

  const additionalFirstNames = formValues(formData, "additionalClientFirstName");
  const additionalLastNames = formValues(formData, "additionalClientLastName");
  const additionalPreferredNames = formValues(formData, "additionalClientPreferredName");
  const additionalEmails = formValues(formData, "additionalClientEmail");
  const additionalPhones = formValues(formData, "additionalClientPhone");
  const additionalInstagramHandles = formValues(formData, "additionalClientInstagramHandle");
  const additionalCommunicationPreferences = formValues(formData, "additionalClientCommunicationPreference");
  const additionalReferralSources = formValues(formData, "additionalClientReferralSource");
  const additionalRoles = formValues(formData, "additionalClientRole");
  const additionalCustomRoles = formValues(formData, "additionalClientCustomRole");

  for (let index = 0; index < additionalFirstNames.length; index += 1) {
    const extraFirstName = at(additionalFirstNames, index);
    const extraEmail = at(additionalEmails, index)?.toLowerCase() ?? null;
    if (!extraFirstName || !extraEmail) continue;

    const extraClientId = await findOrCreateClient({
      firstName: extraFirstName,
      lastName: at(additionalLastNames, index),
      preferredName: at(additionalPreferredNames, index),
      email: extraEmail,
      phone: at(additionalPhones, index),
      instagramHandle: cleanInstagramHandle(at(additionalInstagramHandles, index)),
      communicationPreference: at(additionalCommunicationPreferences, index),
      referralSource: at(additionalReferralSources, index),
      now,
    });
    if (projectClientIds.has(extraClientId)) continue;
    projectClientIds.add(extraClientId);

    await db.insert(projectParticipants).values({
      id: crypto.randomUUID(),
      projectId,
      clientId: extraClientId,
      role: nonPrimaryParticipantRole(customType(at(additionalRoles, index), at(additionalCustomRoles, index))),
      isPrimaryContact: false,
      createdAt: now,
    });
  }

  await logActivity({
    projectId,
    clientId: primaryClientId,
    action: "project.created",
    metadata: { projectName, clientEmail: email },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/projects");
  return projectId;
}

export async function createProjectForExistingClientAction(formData: FormData) {
  "use server";

  const { clientId } = await createProjectForExistingClientFromForm(formData);
  redirect(`/clients/${clientId}`);
}

export async function createProjectForExistingClientFromForm(formData: FormData) {
  const now = new Date().toISOString();
  const clientId = textValue(formData, "clientId");
  const projectName = textValue(formData, "projectName");

  if (!clientId || !projectName) {
    throw new Error("Client and project name are required.");
  }

  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) throw new Error("Client not found.");

  const projectId = crypto.randomUUID();
  const type = textValue(formData, "type") || "wedding";
  const eventDate = nullableTextValue(formData, "eventDate");
  const venueName = nullableTextValue(formData, "venueName");
  const venueAddress = nullableTextValue(formData, "venueAddress");
  const city = nullableTextValue(formData, "city");
  const state = nullableTextValue(formData, "state");

  const project = {
    id: projectId,
    name: projectName,
    type,
    stage: projectStageValue(formData.get("stage")),
    status: "active",
    eventDate,
    venueName,
    venueAddress,
    city,
    state,
    budgetCents: toCents(formData.get("budget")),
    googleCalendarEventId: null,
    calendarSyncStatus: eventDate ? "needs_google_connection" : "not_connected",
    notes: nullableTextValue(formData, "notes"),
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(projects).values(project);
  await db.insert(projectParticipants).values({
    id: crypto.randomUUID(),
    projectId,
    clientId,
    role: textValue(formData, "primaryClientRole") || "primary",
    isPrimaryContact: true,
    createdAt: now,
  });

  if (eventDate || venueName || venueAddress) {
    await syncCanonicalProjectEvent({
      projectId,
      type,
      eventDate,
      venueName,
      venueAddress,
      city,
      state,
      now,
    });
  }

  await logActivity({
    projectId,
    clientId,
    action: "project.created_from_existing_client",
    metadata: { projectName, clientEmail: client.email },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  safeRevalidatePath("/clients");
  safeRevalidatePath(`/clients/${clientId}`);
  safeRevalidatePath("/data-health");

  return { clientId, project };
}

export async function createProjectFromAgent(input: AgentProjectCreateInput) {
  const now = new Date().toISOString();
  const name = cleanAgentText(input.name);
  const primaryClientInput = input.primaryClient ?? null;
  const existingClientId = cleanAgentText(primaryClientInput?.clientId);
  const firstName = cleanAgentText(primaryClientInput?.firstName);
  const email = cleanAgentEmail(primaryClientInput?.email);

  if (!name) {
    throw new Error("Project name is required.");
  }

  if (!existingClientId && (!firstName || !email)) {
    throw new Error("Primary client id or primary client first name and email are required.");
  }

  const primaryClientId = existingClientId ?? await findOrCreateClient({
      firstName: firstName ?? "",
      lastName: cleanAgentText(primaryClientInput?.lastName),
      preferredName: cleanAgentText(primaryClientInput?.preferredName),
      email: email ?? "",
      phone: cleanAgentText(primaryClientInput?.phone),
      instagramHandle: cleanInstagramHandle(primaryClientInput?.instagramHandle),
      communicationPreference: cleanAgentText(primaryClientInput?.communicationPreference),
      referralSource: cleanAgentText(primaryClientInput?.referralSource),
      now,
    });
  const primaryClient = await db.query.clients.findFirst({ where: eq(clients.id, primaryClientId) });
  if (!primaryClient) throw new Error(existingClientId ? "Primary client not found." : "Primary client creation failed.");

  const projectId = crypto.randomUUID();
  const type = cleanAgentText(input.type) ?? "wedding";
  const eventDate = cleanAgentText(input.eventDate);
  const venueName = cleanAgentText(input.venueName);
  const venueAddress = cleanAgentText(input.venueAddress);
  const city = cleanAgentText(input.city);
  const state = cleanAgentText(input.state);
  const budgetCents = Number.isFinite(input.budgetCents) && Number(input.budgetCents) > 0
    ? Math.round(Number(input.budgetCents))
    : null;

  await db.insert(projects).values({
    id: projectId,
    name,
    type,
    stage: projectStageValue(input.stage ?? "inquiry"),
    status: cleanAgentText(input.status) ?? "active",
    eventDate,
    venueName,
    venueAddress,
    city,
    state,
    budgetCents,
    googleCalendarEventId: null,
    calendarSyncStatus: eventDate ? "needs_google_connection" : "not_connected",
    notes: cleanAgentText(input.notes),
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(projectParticipants).values({
    id: crypto.randomUUID(),
    projectId,
    clientId: primaryClientId,
    role: cleanAgentText(primaryClientInput?.role) ?? "primary",
    isPrimaryContact: true,
    createdAt: now,
  });

  await syncCanonicalProjectEvent({
    projectId,
    type,
    eventDate,
    venueName,
    venueAddress,
    city,
    state,
    now,
  });

  const intake = input.intakeSource;
  const intakeBody = cleanAgentText(intake?.body);
  const intakeSource = intakeBody
    ? {
        id: crypto.randomUUID(),
        projectId,
        kind: cleanAgentText(intake?.kind) ?? "inquiry",
        title: cleanAgentText(intake?.title) ?? "Agent intake source",
        body: intakeBody,
        summary: cleanAgentText(intake?.summary),
        occurredAt: cleanAgentText(intake?.occurredAt),
        externalUrl: cleanAgentText(intake?.externalUrl),
        capturedBy: cleanAgentText(intake?.capturedBy) ?? "The Reeses Studio Agent",
        sourceType: cleanAgentText(intake?.sourceType),
        sourceId: cleanAgentText(intake?.sourceId),
        metadataJson: intake?.metadata === undefined ? null : JSON.stringify(intake.metadata),
        createdAt: now,
        updatedAt: now,
      }
    : null;

  if (intakeSource) {
    await db.insert(projectSources).values(intakeSource);
  }

  await logActivity({
    projectId,
    clientId: primaryClientId,
    action: "project.created_by_agent",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
    metadata: {
      projectName: name,
      clientEmail: primaryClient.email,
      sourceType: intakeSource ? "project_source" : null,
      sourceId: intakeSource?.id ?? null,
    },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);

  return {
    id: projectId,
    name,
    type,
    stage: projectStageValue(input.stage ?? "inquiry"),
    status: cleanAgentText(input.status) ?? "active",
    eventDate,
    venueName,
    venueAddress,
    city,
    state,
    budgetCents,
    notes: cleanAgentText(input.notes),
    primaryClient: {
      id: primaryClient.id,
      firstName: primaryClient.firstName,
      lastName: primaryClient.lastName,
      preferredName: primaryClient.preferredName,
      email: primaryClient.email,
      phone: primaryClient.phone,
      instagramHandle: primaryClient.instagramHandle,
      communicationPreference: primaryClient.communicationPreference,
      referralSource: primaryClient.referralSource,
      role: cleanAgentText(primaryClientInput?.role) ?? "primary",
    },
    intakeSource: intakeSource
      ? {
          id: intakeSource.id,
          kind: intakeSource.kind,
          title: intakeSource.title,
          body: intakeSource.body,
          summary: intakeSource.summary,
          occurredAt: intakeSource.occurredAt,
          externalUrl: intakeSource.externalUrl,
          capturedBy: intakeSource.capturedBy,
          sourceType: intakeSource.sourceType,
          sourceId: intakeSource.sourceId,
        }
      : null,
    sourceType: intakeSource ? "project_source" : null,
    sourceId: intakeSource?.id ?? null,
  };
}

export async function createProjectAction(formData: FormData) {
  "use server";

  const projectId = await createProjectFromForm(formData);
  redirect(`/projects/${projectId}`);
}

export async function updateClientAction(formData: FormData) {
  "use server";

  const clientId = await updateClientFromForm(formData);
  redirect(`/clients/${clientId}`);
}

export async function updateClientFromForm(formData: FormData) {
  const clientId = textValue(formData, "clientId");
  const existingClient = await db.query.clients.findFirst({
    where: eq(clients.id, clientId),
  });
  if (!existingClient) {
    throw new Error("Client not found.");
  }

  const firstName = textValue(formData, "firstName");
  const email = textValue(formData, "email").toLowerCase();

  if (!clientId || !firstName || !email) {
    throw new Error("Client first name and email are required.");
  }
  if (email !== existingClient.email) {
    const existingEmailClient = await findClientByNormalizedEmail(email);
    if (existingEmailClient && existingEmailClient.id !== clientId) {
      throw new Error("Another client already uses this email.");
    }
  }

  const updates = {
    firstName,
    lastName: nullableTextValue(formData, "lastName"),
    preferredName: nullableTextValue(formData, "preferredName"),
    email,
    phone: nullableTextValue(formData, "phone"),
    instagramHandle: cleanInstagramHandle(String(formData.get("instagramHandle") ?? "")),
    communicationPreference: nullableTextValue(formData, "communicationPreference"),
    referralSource: nullableTextValue(formData, "referralSource"),
    notes: nullableTextValue(formData, "notes"),
    updatedAt: new Date().toISOString(),
  };

  await db
    .update(clients)
    .set(updates)
    .where(eq(clients.id, clientId));

  const changedFields = Object.entries(updates)
    .filter(([key, value]) => key !== "updatedAt" && existingClient[key as keyof typeof existingClient] !== value)
    .map(([key]) => key);

  const linkedProjectIds = await listProjectIdsForClient(clientId);

  await logActivity({
    clientId,
    action: "client.updated",
    metadata: { clientEmail: email, changedFields, linkedProjectIds },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/clients");
  safeRevalidatePath(`/clients/${clientId}`);
  safeRevalidatePath(`/clients/${clientId}/edit`);
  revalidateClientProjectSurfaces(linkedProjectIds);
  return clientId;
}

function clientPatchHas(input: AgentClientUpdateInput, key: keyof AgentClientUpdateInput) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export async function updateClientFromAgent(clientId: string, input: AgentClientUpdateInput) {
  const id = cleanAgentText(clientId);
  if (!id) throw new Error("Client id is required.");

  const existingClient = await db.query.clients.findFirst({
    where: eq(clients.id, id),
  });
  if (!existingClient) {
    throw new Error("Client not found.");
  }

  const nextFirstName = clientPatchHas(input, "firstName")
    ? cleanAgentText(input.firstName)
    : existingClient.firstName;
  const nextEmail = clientPatchHas(input, "email")
    ? cleanAgentEmail(input.email)
    : existingClient.email;

  if (!nextFirstName || !nextEmail) {
    throw new Error("Client first name and email are required.");
  }

  if (nextEmail !== existingClient.email) {
    const existingEmailClient = await findClientByNormalizedEmail(nextEmail);
    if (existingEmailClient && existingEmailClient.id !== id) {
      throw new Error("Another client already uses this email.");
    }
  }

  const updates = {
    firstName: nextFirstName,
    lastName: clientPatchHas(input, "lastName") ? cleanAgentText(input.lastName) : existingClient.lastName,
    preferredName: clientPatchHas(input, "preferredName") ? cleanAgentText(input.preferredName) : existingClient.preferredName,
    email: nextEmail,
    phone: clientPatchHas(input, "phone") ? cleanAgentText(input.phone) : existingClient.phone,
    instagramHandle: clientPatchHas(input, "instagramHandle") ? cleanInstagramHandle(input.instagramHandle) : existingClient.instagramHandle,
    communicationPreference: clientPatchHas(input, "communicationPreference") ? cleanAgentText(input.communicationPreference) : existingClient.communicationPreference,
    referralSource: clientPatchHas(input, "referralSource") ? cleanAgentText(input.referralSource) : existingClient.referralSource,
    notes: clientPatchHas(input, "notes") ? cleanAgentText(input.notes) : existingClient.notes,
    updatedAt: new Date().toISOString(),
  };

  await db
    .update(clients)
    .set(updates)
    .where(eq(clients.id, id));

  const changedFields = Object.entries(updates)
    .filter(([key, value]) => key !== "updatedAt" && existingClient[key as keyof typeof existingClient] !== value)
    .map(([key]) => key);

  const linkedProjectIds = await listProjectIdsForClient(id);

  await logActivity({
    clientId: id,
    action: "client.updated_by_agent",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
    metadata: { clientEmail: nextEmail, changedFields, linkedProjectIds },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/clients");
  safeRevalidatePath(`/clients/${id}`);
  safeRevalidatePath(`/clients/${id}/edit`);
  revalidateClientProjectSurfaces(linkedProjectIds);

  const updated = await db.query.clients.findFirst({
    where: eq(clients.id, id),
  });
  if (!updated) throw new Error("Client not found.");
  return { client: updated, linkedProjectIds };
}

export async function linkClientToProjectAction(formData: FormData) {
  "use server";

  const { clientId } = await linkClientToProjectFromForm(formData);
  redirect(`/clients/${clientId}`);
}

export async function linkClientToProject({
  clientId,
  projectId,
  role = "other",
  actorType = "admin",
  actorName = "The Reeses Studio",
}: {
  clientId: string;
  projectId: string;
  role?: string | null;
  actorType?: "admin" | "agent" | "client" | "system";
  actorName?: string | null;
}) {
  const cleanRole = nonPrimaryParticipantRole(cleanAgentText(role) ?? "other");
  if (!clientId || !projectId) {
    throw new Error("Client and project are required.");
  }

  const [client, project] = await Promise.all([
    db.query.clients.findFirst({ where: eq(clients.id, clientId) }),
    db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
  ]);
  if (!client) throw new Error("Client not found.");
  if (!project) throw new Error("Project not found.");

  const existingParticipant = await db.query.projectParticipants.findFirst({
    where: and(eq(projectParticipants.projectId, projectId), eq(projectParticipants.clientId, clientId)),
  });

  if (!existingParticipant) {
    await db.insert(projectParticipants).values({
      id: crypto.randomUUID(),
      projectId,
      clientId,
      role: cleanRole,
      isPrimaryContact: false,
      createdAt: new Date().toISOString(),
    });

    await logActivity({
      projectId,
      clientId,
      action: "client.linked_to_project",
      actorType,
      actorName,
      metadata: { role: cleanRole },
    });

    safeRevalidatePath("/clients");
    safeRevalidatePath(`/clients/${clientId}`);
    safeRevalidatePath(`/projects/${projectId}`);
    safeRevalidatePath("/projects");
    safeRevalidatePath("/data-health");
    return { clientId, projectId, linked: true, updated: false, role: cleanRole };
  }

  const roleChanged = existingParticipant.role !== cleanRole;
  if (roleChanged) {
    await db
      .update(projectParticipants)
      .set({ role: cleanRole })
      .where(eq(projectParticipants.id, existingParticipant.id));

    await logActivity({
      projectId,
      clientId,
      action: "client.project_role_updated",
      actorType,
      actorName,
      metadata: {
        previousRole: existingParticipant.role,
        nextRole: cleanRole,
      },
    });
  }

  safeRevalidatePath("/clients");
  safeRevalidatePath(`/clients/${clientId}`);
  safeRevalidatePath(`/projects/${projectId}`);
  safeRevalidatePath("/projects");
  safeRevalidatePath("/data-health");
  return { clientId, projectId, linked: false, updated: roleChanged, role: cleanRole };
}

export async function linkClientToProjectFromForm(formData: FormData) {
  return linkClientToProject({
    clientId: textValue(formData, "clientId"),
    projectId: textValue(formData, "projectId"),
    role: customType(textValue(formData, "role"), nullableTextValue(formData, "customRole")),
  });
}

export async function setProjectPrimaryClient({
  projectId,
  clientId,
  actorType = "admin",
  actorName = "The Reeses Studio",
}: {
  projectId: string;
  clientId: string;
  actorType?: "admin" | "agent" | "client" | "system";
  actorName?: string | null;
}) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new Error("Project not found.");

  const participantRows = await db.query.projectParticipants.findMany({
    where: eq(projectParticipants.projectId, projectId),
    orderBy: asc(projectParticipants.createdAt),
  });
  const target = participantRows.find((participant) => participant.clientId === clientId);
  if (!target) throw new Error("Client is not linked to this project.");

  const previousPrimaryClientId = participantRows.find((participant) => participant.isPrimaryContact)?.clientId ?? null;

  for (const participant of participantRows) {
    if (!participant.isPrimaryContact) continue;
    await db.update(projectParticipants)
      .set({
        isPrimaryContact: false,
        role: participant.role.trim().toLowerCase() === "primary" ? "participant" : participant.role,
      })
      .where(eq(projectParticipants.id, participant.id));
  }

  await db.update(projectParticipants)
    .set({ isPrimaryContact: true })
    .where(eq(projectParticipants.id, target.id));

  await logActivity({
    projectId,
    clientId,
    action: "project.primary_client_updated",
    actorType,
    actorName,
    metadata: {
      previousPrimaryClientId,
      nextPrimaryClientId: clientId,
    },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  safeRevalidatePath(`/clients/${clientId}`);
  if (previousPrimaryClientId) safeRevalidatePath(`/clients/${previousPrimaryClientId}`);
  safeRevalidatePath("/data-health");

  return { projectId, clientId, previousPrimaryClientId };
}

export async function setProjectPrimaryClientFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const clientId = textValue(formData, "clientId");
  if (!projectId || !clientId) throw new Error("Project and client are required.");
  return setProjectPrimaryClient({ projectId, clientId });
}

export async function updateProjectAction(formData: FormData) {
  "use server";

  const projectId = await updateProjectFromForm(formData);
  redirect(`/projects/${projectId}`);
}

async function syncCanonicalProjectEvent({
  projectId,
  type,
  eventDate,
  venueName,
  venueAddress,
  city,
  state,
  now,
}: {
  projectId: string;
  type: string;
  eventDate: string | null;
  venueName: string | null;
  venueAddress: string | null;
  city: string | null;
  state: string | null;
  now: string;
}) {
  const existingEvents = await db.query.projectEvents.findMany({
    where: eq(projectEvents.projectId, projectId),
    orderBy: asc(projectEvents.createdAt),
  });
  const canonicalEvent = existingEvents.find((event) => event.title.toLowerCase() === "wedding day")
    ?? existingEvents[0]
    ?? null;

  if (!canonicalEvent) {
    if (!eventDate && !venueName && !venueAddress && !city && !state) return;
    await db.insert(projectEvents).values({
      id: crypto.randomUUID(),
      projectId,
      type,
      title: type === "wedding" ? "Wedding day" : "Primary event",
      eventDate,
      venueName,
      venueAddress,
      city,
      state,
      calendarSyncStatus: eventDate ? "needs_google_connection" : "not_connected",
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  await db.update(projectEvents).set({
    type: canonicalEvent.type || type,
    eventDate,
    venueName,
    venueAddress,
    city,
    state,
    calendarSyncStatus: projectEventCalendarStatusAfterEdit({
      eventDate,
      googleCalendarEventId: canonicalEvent.googleCalendarEventId,
    }),
    updatedAt: now,
  }).where(eq(projectEvents.id, canonicalEvent.id));
}

export async function updateProjectFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const existingProject = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!existingProject) {
    throw new Error("Project not found.");
  }

  const name = textValue(formData, "name");
  if (!name) {
    throw new Error("Project name is required.");
  }
  const eventDate = nullableTextValue(formData, "eventDate");
  const venueName = nullableTextValue(formData, "venueName");
  const venueAddress = nullableTextValue(formData, "venueAddress");
  const city = nullableTextValue(formData, "city");
  const state = nullableTextValue(formData, "state");
  const now = new Date().toISOString();

  const updates = {
    name,
    type: textValue(formData, "type") || existingProject.type,
    stage: projectStageValue(formData.get("stage")),
    status: textValue(formData, "status") || "active",
    eventDate,
    venueName,
    venueAddress,
    city,
    state,
    budgetCents: toCents(formData.get("budgetCents")),
    calendarSyncStatus: eventDate ? "needs_google_connection" : "not_connected",
    notes: nullableTextValue(formData, "notes"),
    updatedAt: now,
  };

  await db.update(projects).set(updates).where(eq(projects.id, projectId));
  await syncCanonicalProjectEvent({
    projectId,
    type: updates.type,
    eventDate,
    venueName,
    venueAddress,
    city,
    state,
    now,
  });
  await reconcileEngagementSessionIncluded(projectId, checkedValue(formData, "engagementSessionIncluded"));

  const participant = await db.query.projectParticipants.findFirst({
    where: eq(projectParticipants.projectId, projectId),
  });

  const changedFields = Object.entries(updates)
    .filter(([key, value]) => key !== "updatedAt" && existingProject[key as keyof typeof existingProject] !== value)
    .map(([key]) => key);

  await logActivity({
    projectId,
    clientId: participant?.clientId ?? null,
    action: "project.updated",
    metadata: { changedFields },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  safeRevalidatePath(`/projects/${projectId}/edit`);
  return projectId;
}

export async function updateProjectDetailsFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  if (!projectId) {
    throw new Error("Project is required.");
  }

  const existingProject = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!existingProject) {
    throw new Error("Project not found.");
  }
  const eventDate = nullableTextValue(formData, "eventDate") ?? existingProject.eventDate;
  const venueName = nullableTextValue(formData, "venueName");
  const venueAddress = nullableTextValue(formData, "venueAddress");
  const city = nullableTextValue(formData, "city");
  const state = nullableTextValue(formData, "state");
  const now = new Date().toISOString();

  const updates = {
    type: textValue(formData, "type") || existingProject.type,
    eventDate,
    venueName,
    venueAddress,
    city,
    state,
    calendarSyncStatus: eventDate ? "needs_google_connection" : "not_connected",
    notes: nullableTextValue(formData, "notes"),
    updatedAt: now,
  };

  await db.update(projects).set(updates).where(eq(projects.id, projectId));
  await syncCanonicalProjectEvent({
    projectId,
    type: updates.type,
    eventDate,
    venueName,
    venueAddress,
    city,
    state,
    now,
  });
  await reconcileEngagementSessionIncluded(projectId, checkedValue(formData, "engagementSessionIncluded"));

  const participant = await db.query.projectParticipants.findFirst({
    where: eq(projectParticipants.projectId, projectId),
  });

  const changedFields = Object.entries(updates)
    .filter(([key, value]) => key !== "updatedAt" && existingProject[key as keyof typeof existingProject] !== value)
    .map(([key]) => key);

  await logActivity({
    projectId,
    clientId: participant?.clientId ?? null,
    action: "project.details_updated",
    metadata: { changedFields },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  safeRevalidatePath(`/projects/${projectId}/edit`);
  return projectId;
}

export async function updateProjectFromAgent(projectId: string, input: AgentProjectUpdateInput) {
  const existingProject = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!existingProject) {
    throw new Error("Project not found.");
  }

  const sourceType = cleanAgentText(input.sourceType);
  const sourceId = cleanAgentText(input.sourceId);
  await assertAgentProjectSource(projectId, sourceType, sourceId);

  if (hasOwn(input, "eventDate") && cleanAgentText(input.eventDate) !== existingProject.eventDate) {
    throw new Error("Only Tyler can change the wedding date. Agents may suggest a date change by creating a task or source note for approval.");
  }

  const now = new Date().toISOString();
  const updates = {
    name: hasOwn(input, "name") ? cleanAgentText(input.name) ?? existingProject.name : existingProject.name,
    type: hasOwn(input, "type") ? cleanAgentText(input.type) ?? existingProject.type : existingProject.type,
    stage: hasOwn(input, "stage") ? projectStageValue(input.stage ?? existingProject.stage) : existingProject.stage,
    status: hasOwn(input, "status") ? cleanAgentText(input.status) ?? existingProject.status : existingProject.status,
    eventDate: hasOwn(input, "eventDate") ? cleanAgentText(input.eventDate) : existingProject.eventDate,
    venueName: hasOwn(input, "venueName") ? cleanAgentText(input.venueName) : existingProject.venueName,
    venueAddress: hasOwn(input, "venueAddress") ? cleanAgentText(input.venueAddress) : existingProject.venueAddress,
    city: hasOwn(input, "city") ? cleanAgentText(input.city) : existingProject.city,
    state: hasOwn(input, "state") ? cleanAgentText(input.state) : existingProject.state,
    budgetCents: hasOwn(input, "budgetCents")
      ? (Number.isFinite(input.budgetCents) && Number(input.budgetCents) > 0 ? Math.round(Number(input.budgetCents)) : null)
      : existingProject.budgetCents,
    notes: hasOwn(input, "notes") ? cleanAgentText(input.notes) : existingProject.notes,
    calendarSyncStatus: hasOwn(input, "eventDate")
      ? (cleanAgentText(input.eventDate) ? "needs_google_connection" : "not_connected")
      : existingProject.calendarSyncStatus,
    updatedAt: now,
  };

  await db.update(projects).set(updates).where(eq(projects.id, projectId));
  await syncCanonicalProjectEvent({
    projectId,
    type: updates.type,
    eventDate: updates.eventDate,
    venueName: updates.venueName,
    venueAddress: updates.venueAddress,
    city: updates.city,
    state: updates.state,
    now,
  });

  const primaryClientId = cleanAgentText(input.primaryClientId);
  let primaryClientChange: Awaited<ReturnType<typeof setProjectPrimaryClient>> | null = null;
  if (hasOwn(input, "primaryClientId") && primaryClientId) {
    primaryClientChange = await setProjectPrimaryClient({
      projectId,
      clientId: primaryClientId,
      actorType: "agent",
      actorName: "The Reeses Studio Agent",
    });
  }

  const participant = await db.query.projectParticipants.findFirst({
    where: eq(projectParticipants.projectId, projectId),
    orderBy: desc(projectParticipants.isPrimaryContact),
  });
  const changedFields = Object.entries(updates)
    .filter(([key, value]) => key !== "updatedAt" && existingProject[key as keyof typeof existingProject] !== value)
    .map(([key]) => key);
  if (primaryClientChange) changedFields.push("primaryClientId");

  await logActivity({
    projectId,
    clientId: participant?.clientId ?? null,
    action: "project.updated_by_agent",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
    metadata: {
      changedFields,
      sourceType,
      sourceId,
      primaryClientId: primaryClientChange?.clientId ?? null,
    },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  safeRevalidatePath(`/projects/${projectId}/edit`);

  return {
    id: projectId,
    ...updates,
    sourceType,
    sourceId,
    primaryClientId: primaryClientChange?.clientId ?? participant?.clientId ?? null,
  };
}

export async function updateProjectStageFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const nextStage = projectStageValue(formData.get("stage"));
  const existingProject = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!existingProject) {
    throw new Error("Project not found.");
  }

  if (existingProject.stage !== nextStage) {
    await db
      .update(projects)
      .set({
        stage: nextStage,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(projects.id, projectId));

    const participant = await db.query.projectParticipants.findFirst({
      where: eq(projectParticipants.projectId, projectId),
    });

    await logActivity({
      projectId,
      clientId: participant?.clientId ?? null,
      action: "project.stage_updated",
      metadata: { from: existingProject.stage, to: nextStage },
    });
  }

  safeRevalidatePath("/");
  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  return projectId;
}

export async function updateProjectStages(projectIds: string[], stage: string) {
  const uniqueProjectIds = Array.from(new Set(projectIds.map((id) => id.trim()).filter(Boolean)));
  const nextStage = projectStageValue(stage);

  if (!uniqueProjectIds.length) {
    throw new Error("At least one project is required.");
  }

  if (uniqueProjectIds.length > 200) {
    throw new Error("Bulk stage updates are limited to 200 projects at a time.");
  }

  const existingProjects = await db.query.projects.findMany({
    where: inArray(projects.id, uniqueProjectIds),
  });

  if (existingProjects.length !== uniqueProjectIds.length) {
    throw new Error("One or more selected projects could not be found.");
  }

  const changedProjects = existingProjects.filter((project) => project.stage !== nextStage);
  if (!changedProjects.length) {
    return { updatedCount: 0, requestedCount: uniqueProjectIds.length, stage: nextStage };
  }

  const changedProjectIds = changedProjects.map((project) => project.id);
  const updatedAt = new Date().toISOString();

  await db
    .update(projects)
    .set({
      stage: nextStage,
      updatedAt,
    })
    .where(inArray(projects.id, changedProjectIds));

  const participants = await db.query.projectParticipants.findMany({
    where: inArray(projectParticipants.projectId, changedProjectIds),
  });
  const primaryParticipantByProjectId = new Map<string, typeof participants[number]>();
  for (const participant of participants) {
    if (!primaryParticipantByProjectId.has(participant.projectId) || participant.isPrimaryContact) {
      primaryParticipantByProjectId.set(participant.projectId, participant);
    }
  }

  for (const project of changedProjects) {
    const participant = primaryParticipantByProjectId.get(project.id);
    await logActivity({
      projectId: project.id,
      clientId: participant?.clientId ?? null,
      action: "project.stage_updated",
      metadata: {
        from: project.stage,
        to: nextStage,
        bulk: true,
        selectedProjectCount: uniqueProjectIds.length,
      },
    });
  }

  safeRevalidatePath("/");
  safeRevalidatePath("/projects");
  for (const projectId of changedProjectIds) {
    safeRevalidatePath(`/projects/${projectId}`);
  }

  return { updatedCount: changedProjects.length, requestedCount: uniqueProjectIds.length, stage: nextStage };
}

export async function archiveProjects(projectIds: string[]) {
  const uniqueProjectIds = Array.from(new Set(projectIds.map((id) => id.trim()).filter(Boolean)));

  if (!uniqueProjectIds.length) {
    throw new Error("At least one project is required.");
  }

  if (uniqueProjectIds.length > 200) {
    throw new Error("Bulk archive is limited to 200 projects at a time.");
  }

  const existingProjects = await db.query.projects.findMany({
    where: inArray(projects.id, uniqueProjectIds),
  });

  if (existingProjects.length !== uniqueProjectIds.length) {
    throw new Error("One or more selected projects could not be found.");
  }

  const changedProjects = existingProjects.filter((project) => project.status !== "archived");
  if (!changedProjects.length) {
    return { archivedCount: 0, requestedCount: uniqueProjectIds.length, status: "archived" };
  }

  const changedProjectIds = changedProjects.map((project) => project.id);
  const updatedAt = new Date().toISOString();

  await db
    .update(projects)
    .set({
      status: "archived",
      updatedAt,
    })
    .where(inArray(projects.id, changedProjectIds));

  const participants = await db.query.projectParticipants.findMany({
    where: inArray(projectParticipants.projectId, changedProjectIds),
  });
  const primaryParticipantByProjectId = new Map<string, typeof participants[number]>();
  for (const participant of participants) {
    if (!primaryParticipantByProjectId.has(participant.projectId) || participant.isPrimaryContact) {
      primaryParticipantByProjectId.set(participant.projectId, participant);
    }
  }

  for (const project of changedProjects) {
    const participant = primaryParticipantByProjectId.get(project.id);
    await logActivity({
      projectId: project.id,
      clientId: participant?.clientId ?? null,
      action: "project.archived",
      metadata: {
        from: project.status,
        to: "archived",
        bulk: true,
        selectedProjectCount: uniqueProjectIds.length,
      },
    });
  }

  safeRevalidatePath("/");
  safeRevalidatePath("/projects");
  safeRevalidatePath("/data-health");
  for (const projectId of changedProjectIds) {
    safeRevalidatePath(`/projects/${projectId}`);
    safeRevalidatePath(`/projects/${projectId}/edit`);
  }

  return { archivedCount: changedProjects.length, requestedCount: uniqueProjectIds.length, status: "archived" };
}

export async function updateProjectStageAction(formData: FormData) {
  "use server";

  const projectId = await updateProjectStageFromForm(formData);
  redirect(`/projects/${projectId}`);
}

export async function addProjectEventFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const title = textValue(formData, "title");
  const eventDate = nullableTextValue(formData, "eventDate");

  if (!projectId || !title) {
    throw new Error("Project and event title are required.");
  }

  const [project, participant] = await Promise.all([
    db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
    db.query.projectParticipants.findFirst({ where: eq(projectParticipants.projectId, projectId) }),
  ]);
  if (!project) {
    throw new Error("Project not found.");
  }
  const now = new Date().toISOString();
  const type = customType(textValue(formData, "type"), nullableTextValue(formData, "customType"));
  const venueName = nullableTextValue(formData, "venueName");
  const venueAddress = nullableTextValue(formData, "venueAddress");
  const city = nullableTextValue(formData, "city");
  const state = nullableTextValue(formData, "state");
  const calendarSyncStatus = eventDate ? "needs_google_connection" : "not_connected";

  await db.insert(projectEvents).values({
    id: crypto.randomUUID(),
    projectId,
    type,
    title,
    eventDate,
    venueName,
    venueAddress,
    city,
    state,
    calendarSyncStatus,
    notes: nullableTextValue(formData, "notes"),
    createdAt: now,
    updatedAt: now,
  });

  if (title.toLowerCase() === "wedding day") {
    await db.update(projects).set({
      type,
      eventDate,
      venueName,
      venueAddress,
      city,
      state,
      calendarSyncStatus,
      updatedAt: now,
    }).where(eq(projects.id, projectId));
  }

  await logActivity({
    projectId,
    clientId: participant?.clientId ?? null,
    action: "project.event_created",
    metadata: { title, eventDate },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  return projectId;
}

function eventResult(event: typeof projectEvents.$inferSelect) {
  return {
    id: event.id,
    projectId: event.projectId,
    type: event.type,
    title: event.title,
    eventDate: event.eventDate,
    venueName: event.venueName,
    venueAddress: event.venueAddress,
    city: event.city,
    state: event.state,
    googleCalendarEventId: event.googleCalendarEventId,
    calendarSyncStatus: event.calendarSyncStatus,
    notes: event.notes,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    sourceType: event.sourceType,
    sourceId: event.sourceId,
  };
}

export async function createProjectEventFromAgent(projectId: string, input: AgentProjectEventInput) {
  const id = cleanAgentText(projectId);
  if (!id) throw new Error("Project is required.");

  const title = cleanAgentText(input.title);
  if (!title) throw new Error("Project event title is required.");

  const [project, participant] = await Promise.all([
    db.query.projects.findFirst({ where: eq(projects.id, id) }),
    db.query.projectParticipants.findFirst({ where: eq(projectParticipants.projectId, id) }),
  ]);
  if (!project) throw new Error("Project not found.");

  const sourceType = cleanAgentText(input.sourceType);
  const sourceId = cleanAgentText(input.sourceId);
  await assertAgentProjectSource(id, sourceType, sourceId);

  const now = new Date().toISOString();
  const eventDate = cleanAgentText(input.eventDate);
  const isWeddingEvent = title.toLowerCase() === "wedding day" || cleanAgentText(input.type) === "wedding";
  if (isWeddingEvent && eventDate && eventDate !== project.eventDate) {
    throw new Error("Only Tyler can change the wedding date. Agents may suggest a date change by creating a task or source note for approval.");
  }

  const eventId = crypto.randomUUID();
  await db.insert(projectEvents).values({
    id: eventId,
    projectId: id,
    type: cleanAgentText(input.type) ?? "other",
    title,
    eventDate,
    venueName: cleanAgentText(input.venueName),
    venueAddress: cleanAgentText(input.venueAddress),
    city: cleanAgentText(input.city),
    state: cleanAgentText(input.state),
    googleCalendarEventId: null,
    calendarSyncStatus: eventDate ? "needs_google_connection" : "not_connected",
    notes: cleanAgentText(input.notes),
    sourceType,
    sourceId,
    createdAt: now,
    updatedAt: now,
  });

  const event = await db.query.projectEvents.findFirst({ where: eq(projectEvents.id, eventId) });
  if (!event) throw new Error("Project event not found.");

  if (event.title.toLowerCase() === "wedding day" || event.type === "wedding") {
    await db.update(projects).set({
      type: event.type,
      eventDate: project.eventDate,
      venueName: event.venueName,
      venueAddress: event.venueAddress,
      city: event.city,
      state: event.state,
      calendarSyncStatus: project.calendarSyncStatus,
      updatedAt: now,
    }).where(eq(projects.id, id));
  }

  await logActivity({
    projectId: id,
    clientId: participant?.clientId ?? null,
    action: "project.event_created_by_agent",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
    metadata: { eventId, title, eventDate, sourceType, sourceId },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/agenda");
  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${id}`);

  return eventResult(event);
}

export async function addProjectEventAction(formData: FormData) {
  "use server";

  const projectId = await addProjectEventFromForm(formData);
  redirect(`/projects/${projectId}`);
}

export async function updateProjectEventFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const eventId = textValue(formData, "eventId");
  const title = textValue(formData, "title");
  const eventDate = nullableTextValue(formData, "eventDate");

  if (!projectId || !eventId || !title) {
    throw new Error("Project, event, and title are required.");
  }

  const [project, event, participant] = await Promise.all([
    db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
    db.query.projectEvents.findFirst({ where: eq(projectEvents.id, eventId) }),
    db.query.projectParticipants.findFirst({ where: eq(projectParticipants.projectId, projectId) }),
  ]);

  if (!project || !event || event.projectId !== projectId) {
    throw new Error("Project event not found.");
  }

  const settings = await getSchedulerSettings();
  const calendarId = settings?.googleCreateCalendarId || "hello@bythereeses.com";
  const type = customType(textValue(formData, "type"), nullableTextValue(formData, "customType"));
  const venueName = nullableTextValue(formData, "venueName");
  const venueAddress = nullableTextValue(formData, "venueAddress");
  const city = nullableTextValue(formData, "city");
  const state = nullableTextValue(formData, "state");
  const notes = nullableTextValue(formData, "notes");
  const now = new Date().toISOString();
  let googleCalendarEventId = event.googleCalendarEventId;
  let calendarSyncStatus = projectEventCalendarStatusAfterEdit({
    eventDate,
    googleCalendarEventId,
  });

  if (event.googleCalendarEventId && eventDate) {
    const updatedGoogleEventId = await updateGoogleCalendarAllDayEvent({
      eventId: event.googleCalendarEventId,
      summary: `${project.name}: ${title}`,
      date: eventDate,
      calendarId,
      location: joinedText(venueName, venueAddress, city, state),
      description: calendarDescription(
        project.name,
        type ? `Type: ${type.replaceAll("_", " ")}` : null,
        notes,
      ),
    });
    googleCalendarEventId = updatedGoogleEventId ?? event.googleCalendarEventId;
    calendarSyncStatus = updatedGoogleEventId ? "synced" : "sync_failed";
  }

  if (event.googleCalendarEventId && !eventDate) {
    const deleted = await deleteGoogleCalendarEvent({
      calendarId,
      eventId: event.googleCalendarEventId,
    });
    googleCalendarEventId = deleted ? null : event.googleCalendarEventId;
    calendarSyncStatus = deleted ? "not_connected" : "sync_failed";
  }

  await db
    .update(projectEvents)
    .set({
      type,
      title,
      eventDate,
      venueName,
      venueAddress,
      city,
      state,
      googleCalendarEventId,
      calendarSyncStatus,
      notes,
      updatedAt: now,
    })
    .where(eq(projectEvents.id, event.id));

  const projectEventsForCanonicalCheck = await db.query.projectEvents.findMany({
    where: eq(projectEvents.projectId, projectId),
    orderBy: asc(projectEvents.createdAt),
  });
  const canonicalEvent = projectEventsForCanonicalCheck.find((projectEvent) => projectEvent.title.toLowerCase() === "wedding day")
    ?? projectEventsForCanonicalCheck[0]
    ?? null;

  if (canonicalEvent?.id === event.id) {
    await db.update(projects).set({
      type,
      eventDate,
      venueName,
      venueAddress,
      city,
      state,
      calendarSyncStatus,
      updatedAt: now,
    }).where(eq(projects.id, projectId));
  }

  await logActivity({
    projectId,
    clientId: participant?.clientId ?? null,
    action: "project.event_updated",
    metadata: { eventId, title, eventDate, calendarSyncStatus },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  return projectId;
}

export async function updateProjectEventFromAgent(projectId: string, eventId: string, input: AgentProjectEventInput) {
  const id = cleanAgentText(projectId);
  const cleanEventId = cleanAgentText(eventId);
  if (!id || !cleanEventId) throw new Error("Project and event are required.");

  const [project, event, participant] = await Promise.all([
    db.query.projects.findFirst({ where: eq(projects.id, id) }),
    db.query.projectEvents.findFirst({ where: eq(projectEvents.id, cleanEventId) }),
    db.query.projectParticipants.findFirst({ where: eq(projectParticipants.projectId, id) }),
  ]);
  if (!project || !event || event.projectId !== id) {
    throw new Error("Project event not found.");
  }

  const sourceType = hasOwn(input, "sourceType") ? cleanAgentText(input.sourceType) : event.sourceType;
  const sourceId = hasOwn(input, "sourceId") ? cleanAgentText(input.sourceId) : event.sourceId;
  await assertAgentProjectSource(id, sourceType, sourceId);

  const eventDate = hasOwn(input, "eventDate") ? cleanAgentText(input.eventDate) : event.eventDate;
  const nextTitle = hasOwn(input, "title") ? cleanAgentText(input.title) ?? event.title : event.title;
  const nextType = hasOwn(input, "type") ? cleanAgentText(input.type) ?? event.type : event.type;
  const isWeddingEvent = nextTitle.toLowerCase() === "wedding day" || nextType === "wedding" || event.title.toLowerCase() === "wedding day" || event.type === "wedding";
  if (isWeddingEvent && hasOwn(input, "eventDate") && eventDate !== event.eventDate) {
    throw new Error("Only Tyler can change the wedding date. Agents may suggest a date change by creating a task or source note for approval.");
  }

  const updates = {
    type: nextType,
    title: nextTitle,
    eventDate,
    venueName: hasOwn(input, "venueName") ? cleanAgentText(input.venueName) : event.venueName,
    venueAddress: hasOwn(input, "venueAddress") ? cleanAgentText(input.venueAddress) : event.venueAddress,
    city: hasOwn(input, "city") ? cleanAgentText(input.city) : event.city,
    state: hasOwn(input, "state") ? cleanAgentText(input.state) : event.state,
    calendarSyncStatus: projectEventCalendarStatusAfterEdit({
      eventDate,
      googleCalendarEventId: event.googleCalendarEventId,
    }),
    notes: hasOwn(input, "notes") ? cleanAgentText(input.notes) : event.notes,
    sourceType,
    sourceId,
    updatedAt: new Date().toISOString(),
  };

  await db.update(projectEvents).set(updates).where(eq(projectEvents.id, event.id));
  const updated = await db.query.projectEvents.findFirst({ where: eq(projectEvents.id, event.id) });
  if (!updated) throw new Error("Project event not found.");

  if (updated.title.toLowerCase() === "wedding day" || updated.type === "wedding") {
    await db.update(projects).set({
      type: updated.type,
      eventDate: updated.eventDate,
      venueName: updated.venueName,
      venueAddress: updated.venueAddress,
      city: updated.city,
      state: updated.state,
      calendarSyncStatus: updated.calendarSyncStatus,
      updatedAt: updates.updatedAt,
    }).where(eq(projects.id, id));
  }

  await logActivity({
    projectId: id,
    clientId: participant?.clientId ?? null,
    action: "project.event_updated_by_agent",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
    metadata: {
      eventId: event.id,
      title: updated.title,
      eventDate: updated.eventDate,
      calendarSyncStatus: updated.calendarSyncStatus,
      sourceType,
      sourceId,
    },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/agenda");
  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${id}`);

  return eventResult(updated);
}

export async function updateProjectEventAction(formData: FormData) {
  "use server";

  const projectId = await updateProjectEventFromForm(formData);
  redirect(`/projects/${projectId}?saved=event`);
}

export async function addProjectLocationFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const name = textValue(formData, "name");

  if (!projectId || !name) {
    throw new Error("Project and location name are required.");
  }

  const [project, participant] = await Promise.all([
    db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
    db.query.projectParticipants.findFirst({ where: eq(projectParticipants.projectId, projectId) }),
  ]);
  if (!project) throw new Error("Project not found.");

  const now = new Date().toISOString();
  const locationId = crypto.randomUUID();
  const type = customType(textValue(formData, "type"), nullableTextValue(formData, "customType"));

  await db.insert(projectLocations).values({
    id: locationId,
    projectId,
    type,
    name,
    address: nullableTextValue(formData, "address"),
    city: nullableTextValue(formData, "city"),
    state: nullableTextValue(formData, "state"),
    notes: nullableTextValue(formData, "notes"),
    createdAt: now,
    updatedAt: now,
  });

  await logActivity({
    projectId,
    clientId: participant?.clientId ?? null,
    action: "project.location_created",
    metadata: { locationId, type, name },
  });

  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  return { projectId, locationId };
}

export async function updateProjectLocationFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const locationId = textValue(formData, "locationId");
  const name = textValue(formData, "name");

  if (!projectId || !locationId || !name) {
    throw new Error("Project, location, and name are required.");
  }

  const [project, location, participant] = await Promise.all([
    db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
    db.query.projectLocations.findFirst({ where: eq(projectLocations.id, locationId) }),
    db.query.projectParticipants.findFirst({ where: eq(projectParticipants.projectId, projectId) }),
  ]);
  if (!project || !location || location.projectId !== projectId) {
    throw new Error("Project location not found.");
  }

  const type = customType(textValue(formData, "type"), nullableTextValue(formData, "customType"));
  const updates = {
    type,
    name,
    address: nullableTextValue(formData, "address"),
    city: nullableTextValue(formData, "city"),
    state: nullableTextValue(formData, "state"),
    notes: nullableTextValue(formData, "notes"),
    updatedAt: new Date().toISOString(),
  };

  await db.update(projectLocations).set(updates).where(eq(projectLocations.id, locationId));

  const changedFields = Object.entries(updates)
    .filter(([key, value]) => key !== "updatedAt" && location[key as keyof typeof location] !== value)
    .map(([key]) => key);

  await logActivity({
    projectId,
    clientId: participant?.clientId ?? null,
    action: "project.location_updated",
    metadata: { locationId, changedFields },
  });

  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  return { projectId, locationId };
}

function locationResult(location: typeof projectLocations.$inferSelect) {
  return {
    id: location.id,
    projectId: location.projectId,
    type: location.type,
    name: location.name,
    address: location.address,
    city: location.city,
    state: location.state,
    notes: location.notes,
    sourceType: location.sourceType,
    sourceId: location.sourceId,
    createdAt: location.createdAt,
    updatedAt: location.updatedAt,
  };
}

export async function createProjectLocationFromAgent(projectId: string, input: AgentProjectLocationInput) {
  const id = cleanAgentText(projectId);
  if (!id) throw new Error("Project is required.");

  const name = cleanAgentText(input.name);
  if (!name) throw new Error("Project location name is required.");

  const [project, participant] = await Promise.all([
    db.query.projects.findFirst({ where: eq(projects.id, id) }),
    db.query.projectParticipants.findFirst({ where: eq(projectParticipants.projectId, id) }),
  ]);
  if (!project) throw new Error("Project not found.");

  const sourceType = cleanAgentText(input.sourceType);
  const sourceId = cleanAgentText(input.sourceId);
  await assertAgentProjectSource(id, sourceType, sourceId, "Project location");

  const now = new Date().toISOString();
  const locationId = crypto.randomUUID();
  await db.insert(projectLocations).values({
    id: locationId,
    projectId: id,
    type: cleanAgentText(input.type) ?? "other",
    name,
    address: cleanAgentText(input.address),
    city: cleanAgentText(input.city),
    state: cleanAgentText(input.state),
    notes: cleanAgentText(input.notes),
    sourceType,
    sourceId,
    createdAt: now,
    updatedAt: now,
  });

  const location = await db.query.projectLocations.findFirst({ where: eq(projectLocations.id, locationId) });
  if (!location) throw new Error("Project location not found.");

  await logActivity({
    projectId: id,
    clientId: participant?.clientId ?? null,
    action: "project.location_created_by_agent",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
    metadata: { locationId, type: location.type, name: location.name, sourceType, sourceId },
  });

  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${id}`);

  return locationResult(location);
}

export async function updateProjectLocationFromAgent(projectId: string, locationId: string, input: AgentProjectLocationInput) {
  const id = cleanAgentText(projectId);
  const cleanLocationId = cleanAgentText(locationId);
  if (!id || !cleanLocationId) throw new Error("Project and location are required.");

  const [project, location, participant] = await Promise.all([
    db.query.projects.findFirst({ where: eq(projects.id, id) }),
    db.query.projectLocations.findFirst({ where: eq(projectLocations.id, cleanLocationId) }),
    db.query.projectParticipants.findFirst({ where: eq(projectParticipants.projectId, id) }),
  ]);
  if (!project || !location || location.projectId !== id) {
    throw new Error("Project location not found.");
  }

  const sourceType = hasOwn(input, "sourceType") ? cleanAgentText(input.sourceType) : location.sourceType;
  const sourceId = hasOwn(input, "sourceId") ? cleanAgentText(input.sourceId) : location.sourceId;
  await assertAgentProjectSource(id, sourceType, sourceId, "Project location");

  const updates = {
    type: hasOwn(input, "type") ? cleanAgentText(input.type) ?? location.type : location.type,
    name: hasOwn(input, "name") ? cleanAgentText(input.name) ?? location.name : location.name,
    address: hasOwn(input, "address") ? cleanAgentText(input.address) : location.address,
    city: hasOwn(input, "city") ? cleanAgentText(input.city) : location.city,
    state: hasOwn(input, "state") ? cleanAgentText(input.state) : location.state,
    notes: hasOwn(input, "notes") ? cleanAgentText(input.notes) : location.notes,
    sourceType,
    sourceId,
    updatedAt: new Date().toISOString(),
  };

  await db.update(projectLocations).set(updates).where(eq(projectLocations.id, location.id));
  const updated = await db.query.projectLocations.findFirst({ where: eq(projectLocations.id, location.id) });
  if (!updated) throw new Error("Project location not found.");

  await logActivity({
    projectId: id,
    clientId: participant?.clientId ?? null,
    action: "project.location_updated_by_agent",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
    metadata: { locationId: location.id, name: updated.name, sourceType, sourceId },
  });

  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${id}`);

  return locationResult(updated);
}

export async function syncProjectCalendarFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const eventId = nullableTextValue(formData, "eventId");

  if (!projectId) {
    throw new Error("Project is required.");
  }

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!project) {
    throw new Error("Project not found.");
  }

  const participant = await db.query.projectParticipants.findFirst({
    where: eq(projectParticipants.projectId, projectId),
  });
  const settings = await getSchedulerSettings();
  const calendarId = settings?.googleCreateCalendarId || "hello@bythereeses.com";
  const now = new Date().toISOString();

  if (eventId) {
    const event = await db.query.projectEvents.findFirst({
      where: eq(projectEvents.id, eventId),
    });

    if (!event || event.projectId !== projectId) {
      throw new Error("Project event not found.");
    }

    if (!event.eventDate) {
      return { ok: false, kind: "calendar-event" as const, reason: "missing_date" as const };
    }

    if (event.googleCalendarEventId && event.calendarSyncStatus === "synced") {
      return { ok: true, kind: "calendar-event" as const, alreadySynced: true };
    }

    const googleEventId = await createGoogleCalendarAllDayEvent({
      summary: `${project.name}: ${event.title}`,
      date: event.eventDate,
      calendarId,
      location: joinedText(event.venueName, event.venueAddress, event.city, event.state),
      description: calendarDescription(
        project.name,
        event.type ? `Type: ${event.type.replaceAll("_", " ")}` : null,
        event.notes,
      ),
    });

    await db
      .update(projectEvents)
      .set({
        googleCalendarEventId: googleEventId,
        calendarSyncStatus: googleEventId ? "synced" : "sync_failed",
        updatedAt: now,
      })
      .where(eq(projectEvents.id, event.id));

    await logActivity({
      projectId,
      clientId: participant?.clientId ?? null,
      action: googleEventId ? "project_event.calendar_synced" : "project_event.calendar_sync_failed",
      metadata: { eventId: event.id, googleEventId, calendarId },
    });

    safeRevalidatePath("/");
    safeRevalidatePath("/projects");
    safeRevalidatePath(`/projects/${projectId}`);
    return { ok: Boolean(googleEventId), kind: "calendar-event" as const };
  }

  if (!project.eventDate) {
    return { ok: false, kind: "calendar" as const, reason: "missing_date" as const };
  }

  if (project.googleCalendarEventId && project.calendarSyncStatus === "synced") {
    return { ok: true, kind: "calendar" as const, alreadySynced: true };
  }

  const googleEventId = await createGoogleCalendarAllDayEvent({
    summary: project.name,
    date: project.eventDate,
    calendarId,
    location: joinedText(project.venueName, project.venueAddress, project.city, project.state),
    description: calendarDescription(
      project.type ? `Type: ${project.type.replaceAll("_", " ")}` : null,
      project.notes,
    ),
  });

  await db
    .update(projects)
    .set({
      googleCalendarEventId: googleEventId,
      calendarSyncStatus: googleEventId ? "synced" : "sync_failed",
      updatedAt: now,
    })
    .where(eq(projects.id, project.id));

  await logActivity({
    projectId,
    clientId: participant?.clientId ?? null,
    action: googleEventId ? "project.calendar_synced" : "project.calendar_sync_failed",
    metadata: { googleEventId, calendarId },
  });

  safeRevalidatePath("/");
  safeRevalidatePath("/projects");
  safeRevalidatePath(`/projects/${projectId}`);
  return { ok: Boolean(googleEventId), kind: "calendar" as const };
}

export async function createPortalLinkFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  if (!projectId) {
    throw new Error("Project is required.");
  }

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) {
    throw new Error("Project not found.");
  }

  const clientId = textValue(formData, "clientId") || null;
  if (clientId) {
    const participant = await db.query.projectParticipants.findFirst({
      where: and(eq(projectParticipants.projectId, projectId), eq(projectParticipants.clientId, clientId)),
    });
    if (!participant) {
      throw new Error("Portal client is not linked to this project.");
    }
  }

  const url = await generatePortalLink(projectId, clientId);
  return { projectId, url };
}

export async function generatePortalLinkAction(formData: FormData) {
  "use server";

  const { projectId, url } = await createPortalLinkFromForm(formData);
  redirect(`/projects/${projectId}?portalLink=${encodeURIComponent(url)}`);
}

export async function revokePortalTokenFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const tokenId = textValue(formData, "tokenId");
  if (!projectId || !tokenId) {
    throw new Error("Project and token are required.");
  }

  const token = await db.query.portalAccessTokens.findFirst({
    where: and(eq(portalAccessTokens.id, tokenId), eq(portalAccessTokens.projectId, projectId)),
  });
  if (!token) {
    throw new Error("Portal token was not found for this project.");
  }

  await revokePortalToken(tokenId);
  safeRevalidatePath(`/projects/${projectId}`);
  return projectId;
}

export async function revokePortalTokenAction(formData: FormData) {
  "use server";

  const projectId = await revokePortalTokenFromForm(formData);
  redirect(`/projects/${projectId}`);
}
