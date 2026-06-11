import { db } from "@/db/client";
import { clients, projectEvents, projectParticipants, projects, schedulerBookings, schedulerMeetingTypes } from "@/db/schema";
import { dateKeyInTimeZone, formatTimeInTimeZone } from "@/lib/timezone";
import { and, asc, eq, gte, isNotNull, isNull, lte, type SQL } from "drizzle-orm";

export type AgendaCategory = "wedding" | "engagement" | "other" | "call";

export type AgendaItem = {
  id: string;
  kind: "session" | "call";
  category: AgendaCategory;
  date: string;
  time: string | null;
  title: string;
  projectId: string | null;
  projectName: string | null;
  clientName: string | null;
  venueLabel: string | null;
  calendarSyncStatus: string | null;
  href: string;
};

export type AgendaQuery = {
  fromDate: string;
  toDate?: string | null;
  types?: AgendaCategory[];
  limit?: number;
  timeZone?: string;
};

function fullName(firstName?: string | null, lastName?: string | null) {
  return [firstName, lastName].filter(Boolean).join(" ") || null;
}

function venueLabel({
  venueName,
  city,
  state,
}: {
  venueName?: string | null;
  city?: string | null;
  state?: string | null;
}) {
  return [venueName, city, state].filter(Boolean).join(", ") || null;
}

function categoryForEventType(type: string): AgendaCategory {
  if (type === "wedding") return "wedding";
  if (type === "engagement") return "engagement";
  return "other";
}

function isoFloorForDate(date: string) {
  return `${date}T00:00:00.000Z`;
}

function isoCeilingForDate(date: string) {
  return `${date}T23:59:59.999Z`;
}

function itemMatchesTypes(item: AgendaItem, types?: AgendaCategory[]) {
  return !types?.length || types.includes(item.category);
}

export async function getAgenda({
  fromDate,
  toDate,
  types,
  limit,
  timeZone = "America/New_York",
}: AgendaQuery) {
  const eventConditions: SQL[] = [
    isNotNull(projectEvents.eventDate),
    gte(projectEvents.eventDate, fromDate),
    eq(projects.status, "active"),
  ];
  const fallbackConditions: SQL[] = [
    isNotNull(projects.eventDate),
    gte(projects.eventDate, fromDate),
    eq(projects.status, "active"),
  ];
  const bookingConditions: SQL[] = [
    gte(schedulerBookings.startAt, isoFloorForDate(fromDate)),
    isNull(schedulerBookings.cancelledAt),
  ];

  if (toDate) {
    eventConditions.push(lte(projectEvents.eventDate, toDate));
    fallbackConditions.push(lte(projects.eventDate, toDate));
    bookingConditions.push(lte(schedulerBookings.startAt, isoCeilingForDate(toDate)));
  }

  const [eventRows, bookingRows, fallbackRows] = await Promise.all([
    db
      .select({
        eventId: projectEvents.id,
        eventType: projectEvents.type,
        title: projectEvents.title,
        eventDate: projectEvents.eventDate,
        eventVenueName: projectEvents.venueName,
        eventCity: projectEvents.city,
        eventState: projectEvents.state,
        calendarSyncStatus: projectEvents.calendarSyncStatus,
        projectId: projects.id,
        projectName: projects.name,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
      })
      .from(projectEvents)
      .innerJoin(projects, eq(projectEvents.projectId, projects.id))
      .leftJoin(projectParticipants, and(
        eq(projectParticipants.projectId, projects.id),
        eq(projectParticipants.isPrimaryContact, true),
      ))
      .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
      .where(and(...eventConditions))
      .orderBy(asc(projectEvents.eventDate)),
    db
      .select({
        bookingId: schedulerBookings.id,
        startAt: schedulerBookings.startAt,
        calendarSyncStatus: schedulerBookings.calendarSyncStatus,
        meetingName: schedulerMeetingTypes.name,
        attendeeName: schedulerBookings.attendeeName,
        projectId: projects.id,
        projectName: projects.name,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
      })
      .from(schedulerBookings)
      .innerJoin(schedulerMeetingTypes, eq(schedulerBookings.meetingTypeId, schedulerMeetingTypes.id))
      .leftJoin(projects, eq(schedulerBookings.projectId, projects.id))
      .leftJoin(clients, eq(schedulerBookings.clientId, clients.id))
      .where(and(...bookingConditions))
      .orderBy(asc(schedulerBookings.startAt)),
    db
      .select({
        projectId: projects.id,
        projectName: projects.name,
        eventDate: projects.eventDate,
        venueName: projects.venueName,
        city: projects.city,
        state: projects.state,
        calendarSyncStatus: projects.calendarSyncStatus,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
      })
      .from(projects)
      .leftJoin(projectParticipants, and(
        eq(projectParticipants.projectId, projects.id),
        eq(projectParticipants.isPrimaryContact, true),
      ))
      .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
      .where(and(...fallbackConditions))
      .orderBy(asc(projects.eventDate)),
  ]);

  const weddingEventKeys = new Set(
    eventRows
      .filter((row) => row.eventType === "wedding" && row.eventDate)
      .map((row) => `${row.projectId}:${row.eventDate}`),
  );

  const items: AgendaItem[] = [
    ...eventRows.map((row) => ({
      id: row.eventId,
      kind: "session" as const,
      category: categoryForEventType(row.eventType),
      date: row.eventDate ?? "",
      time: null,
      title: row.title,
      projectId: row.projectId,
      projectName: row.projectName,
      clientName: fullName(row.clientFirstName, row.clientLastName),
      venueLabel: venueLabel({
        venueName: row.eventVenueName,
        city: row.eventCity,
        state: row.eventState,
      }),
      calendarSyncStatus: row.calendarSyncStatus,
      href: `/projects/${row.projectId}#events`,
    })),
    ...bookingRows.map((row) => {
      const start = new Date(row.startAt);
      return {
        id: row.bookingId,
        kind: "call" as const,
        category: "call" as const,
        date: dateKeyInTimeZone(start, timeZone),
        time: formatTimeInTimeZone(start, timeZone),
        title: row.meetingName,
        projectId: row.projectId,
        projectName: row.projectName,
        clientName: fullName(row.clientFirstName, row.clientLastName) ?? row.attendeeName,
        venueLabel: null,
        calendarSyncStatus: row.calendarSyncStatus,
        href: `/scheduler/bookings/${row.bookingId}`,
      };
    }),
    ...fallbackRows
      .filter((row) => row.eventDate && !weddingEventKeys.has(`${row.projectId}:${row.eventDate}`))
      .map((row) => ({
        id: `${row.projectId}:wedding`,
        kind: "session" as const,
        category: "wedding" as const,
        date: row.eventDate ?? "",
        time: null,
        title: "Wedding Day",
        projectId: row.projectId,
        projectName: row.projectName,
        clientName: fullName(row.clientFirstName, row.clientLastName),
        venueLabel: venueLabel(row),
        calendarSyncStatus: row.calendarSyncStatus,
        href: `/projects/${row.projectId}`,
      })),
  ]
    .filter((item) => item.date >= fromDate)
    .filter((item) => !toDate || item.date <= toDate)
    .filter((item) => itemMatchesTypes(item, types))
    .sort((a, b) => (
      a.date.localeCompare(b.date)
      || (a.time ? "1" : "0").localeCompare(b.time ? "1" : "0")
      || a.title.localeCompare(b.title)
    ));

  return {
    items: typeof limit === "number" ? items.slice(0, Math.max(0, limit)) : items,
  };
}
