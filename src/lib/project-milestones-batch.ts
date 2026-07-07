// Phase 22 — projects LIST page compact milestone bar (dark behind PROJECT_PROGRESS_TIMELINE,
// part two of the same phase as the detail-page strip in project-milestones.ts).
//
// This file (unlike project-milestones.ts) DOES touch the database — it batches the five reads
// the spec calls for (events, invoices, payments-of-those-invoices, galleries, bookings) and folds
// each project's rows into `computeProjectMilestones` + `milestoneSummary`. Every batched
// `inArray` goes through `chunkedInArrayFetch` (rev 2, B2 — D1's 100-bound-param cap; the list
// page's default pageSize is 200, so an unchunked `inArray` would throw in production D1).
//
// Rev 2 note: `listProjectIndex` batches nothing today; this is new load and MUST stay behind the
// flag entirely (callers must not invoke this when the flag is off).

import { db } from "@/db/client";
import { projects, schedulerBookings, schedulerMeetingTypes } from "@/db/schema";
import { chunkedInArrayFetch } from "@/lib/db-batch";
import { computeProjectMilestones, milestoneSummary, type MilestoneInput, type MilestoneSummaryValue } from "@/lib/project-milestones";
import { eq, inArray } from "drizzle-orm";

export type ProjectMilestoneBatchRow = Pick<typeof projects.$inferSelect, "id" | "stage" | "type" | "createdAt" | "eventDate">;

function groupBy<TRow, TKey>(rows: TRow[], keyOf: (row: TRow) => TKey): Map<TKey, TRow[]> {
  const map = new Map<TKey, TRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return map;
}

export async function loadProjectMilestoneSummaries(
  projectRows: ProjectMilestoneBatchRow[],
  today: Date,
): Promise<Map<string, MilestoneSummaryValue>> {
  const projectIds = projectRows.map((row) => row.id);
  if (!projectIds.length) return new Map();

  const [events, invoiceRows, galleries, bookings] = await Promise.all([
    chunkedInArrayFetch(projectIds, (chunk) =>
      db.query.projectEvents.findMany({ where: (row, { inArray: inArrayOp }) => inArrayOp(row.projectId, chunk) })),
    chunkedInArrayFetch(projectIds, (chunk) =>
      db.query.invoices.findMany({ where: (row, { inArray: inArrayOp }) => inArrayOp(row.projectId, chunk) })),
    chunkedInArrayFetch(projectIds, (chunk) =>
      db.query.projectGalleries.findMany({ where: (row, { inArray: inArrayOp }) => inArrayOp(row.projectId, chunk) })),
    chunkedInArrayFetch(projectIds, (chunk) =>
      db
        .select({
          id: schedulerBookings.id,
          projectId: schedulerBookings.projectId,
          startAt: schedulerBookings.startAt,
          status: schedulerBookings.status,
          meetingName: schedulerMeetingTypes.name,
        })
        .from(schedulerBookings)
        .innerJoin(schedulerMeetingTypes, eq(schedulerBookings.meetingTypeId, schedulerMeetingTypes.id))
        .where(inArray(schedulerBookings.projectId, chunk))),
  ]);

  const invoiceIds = invoiceRows.map((invoice) => invoice.id);
  const payments = await chunkedInArrayFetch(invoiceIds, (chunk) =>
    db.query.invoicePayments.findMany({ where: (row, { inArray: inArrayOp }) => inArrayOp(row.invoiceId, chunk) }));

  const eventsByProject = groupBy(events, (event) => event.projectId);
  const invoicesByProject = groupBy(invoiceRows, (invoice) => invoice.projectId);
  const galleriesByProject = groupBy(galleries, (gallery) => gallery.projectId);
  const bookingsByProject = groupBy(bookings, (booking) => booking.projectId ?? "");
  const invoiceProjectById = new Map(invoiceRows.map((invoice) => [invoice.id, invoice.projectId]));
  const paymentsByProject = new Map<string, typeof payments>();
  for (const payment of payments) {
    const projectId = invoiceProjectById.get(payment.invoiceId);
    if (!projectId) continue;
    paymentsByProject.set(projectId, [...(paymentsByProject.get(projectId) ?? []), payment]);
  }

  const summaries = new Map<string, MilestoneSummaryValue>();
  for (const project of projectRows) {
    // Rev 2: proposals are intentionally NOT one of the five batched fetches for the list-page bar
    // (the `proposal` milestone falls back to the stage-rank arm only here — the detail page's
    // full getProject() result still carries the accepted/signed/sent proposal arm too).
    const input: MilestoneInput = {
      stage: project.stage,
      type: project.type,
      createdAt: project.createdAt,
      eventDate: project.eventDate,
      events: (eventsByProject.get(project.id) ?? []).map((event) => ({ type: event.type, title: event.title, eventDate: event.eventDate })),
      bookings: (bookingsByProject.get(project.id) ?? []).map((booking) => ({
        startAt: booking.startAt,
        status: booking.status,
        meetingName: booking.meetingName,
        title: null,
      })),
      proposals: [],
      invoices: (invoicesByProject.get(project.id) ?? []).map((invoice) => ({ status: invoice.status, dueDate: invoice.dueDate })),
      payments: (paymentsByProject.get(project.id) ?? []).map((payment) => ({
        invoiceId: payment.invoiceId,
        status: payment.status,
        dueDate: payment.dueDate,
        label: payment.label,
      })),
      galleries: (galleriesByProject.get(project.id) ?? []).map((gallery) => ({
        status: gallery.status,
        title: gallery.title,
        deliveredAt: gallery.deliveredAt,
        createdAt: gallery.createdAt,
      })),
    };

    const milestones = computeProjectMilestones(input, today);
    summaries.set(project.id, milestoneSummary(milestones));
  }

  return summaries;
}
