import { db } from "@/db/client";
import { clients, invoicePayments, invoices, projectParticipants, projects, proposals, schedulerBookings } from "@/db/schema";
import { and, eq, gte, inArray, lt, ne } from "drizzle-orm";

function monthBounds(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function inquiryIdentity({
  projectId,
  clientId,
  email,
}: {
  projectId?: string | null;
  clientId?: string | null;
  email?: string | null;
}) {
  if (projectId) return `project:${projectId}`;
  if (clientId) return `client:${clientId}`;
  if (email) return `email:${email.trim().toLowerCase()}`;
  return null;
}

type InvoicePaymentMetricRow = {
  invoiceId: string;
  invoiceNumber: string;
  paymentId: string;
  label: string;
  amountCents: number;
  dueDate: string | null;
  status: string;
};

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDaysKey(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return dateKey(next);
}

export function summarizeInvoicePaymentMetrics(rows: InvoicePaymentMetricRow[], now = new Date()) {
  const today = dateKey(now);
  const dueSoonEnd = addDaysKey(now, 14);
  const unpaidRows = rows.filter((row) => row.status !== "paid" && row.status !== "waived");
  const datedRows = unpaidRows
    .filter((row): row is InvoicePaymentMetricRow & { dueDate: string } => Boolean(row.dueDate))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const nextPayment = datedRows[0] ?? null;

  return {
    outstandingPaymentCents: unpaidRows.reduce((sum, row) => sum + row.amountCents, 0),
    overduePaymentCount: datedRows.filter((row) => row.dueDate < today).length,
    dueSoonPaymentCount: datedRows.filter((row) => row.dueDate >= today && row.dueDate <= dueSoonEnd).length,
    nextPaymentDue: nextPayment ? {
      invoiceId: nextPayment.invoiceId,
      invoiceNumber: nextPayment.invoiceNumber,
      paymentId: nextPayment.paymentId,
      label: nextPayment.label,
      amountCents: nextPayment.amountCents,
      dueDate: nextPayment.dueDate,
    } : null,
  };
}

export async function getDashboardMetrics(now = new Date()) {
  const { startIso, endIso } = monthBounds(now);

  const [acceptedProposals, inquiryProjects, bookingInquiries, invoicePaymentRows] = await Promise.all([
    db.query.proposals.findMany({
      where: eq(proposals.status, "accepted"),
      columns: {
        id: true,
        totalCents: true,
      },
    }),
    db
      .select({
        projectId: projects.id,
        clientId: clients.id,
        email: clients.email,
      })
      .from(projects)
      .leftJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
      .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
      .where(and(
        inArray(projects.stage, ["inquiry", "proposal_sent"]),
        gte(projects.createdAt, startIso),
        lt(projects.createdAt, endIso),
      )),
    db.query.schedulerBookings.findMany({
      where: and(
        gte(schedulerBookings.createdAt, startIso),
        lt(schedulerBookings.createdAt, endIso),
      ),
      columns: {
        id: true,
        projectId: true,
        clientId: true,
        attendeeEmail: true,
      },
    }),
    db
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        invoiceStatus: invoices.status,
        paymentId: invoicePayments.id,
        label: invoicePayments.label,
        amountCents: invoicePayments.amountCents,
        dueDate: invoicePayments.dueDate,
        status: invoicePayments.status,
      })
      .from(invoicePayments)
      .innerJoin(invoices, eq(invoicePayments.invoiceId, invoices.id))
      .where(ne(invoicePayments.status, "paid")),
  ]);

  const inquiryKeys = new Set<string>();

  for (const row of inquiryProjects) {
    const key = inquiryIdentity(row);
    if (key) inquiryKeys.add(key);
  }

  for (const booking of bookingInquiries) {
    const key = inquiryIdentity({
      projectId: booking.projectId,
      clientId: booking.clientId,
      email: booking.attendeeEmail,
    }) ?? `booking:${booking.id}`;
    inquiryKeys.add(key);
  }

  const openInvoicePayments = invoicePaymentRows.filter((row) => row.invoiceStatus !== "paid" && row.invoiceStatus !== "void");

  return {
    acceptedBookedValueCents: acceptedProposals.reduce((sum, proposal) => sum + (proposal.totalCents ?? 0), 0),
    inquiriesThisMonth: inquiryKeys.size,
    ...summarizeInvoicePaymentMetrics(openInvoicePayments, now),
  };
}
