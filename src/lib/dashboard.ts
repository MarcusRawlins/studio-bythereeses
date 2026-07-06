import { db } from "@/db/client";
import { clients, invoicePayments, invoices, projectEvents, projectParticipants, projects, proposals, questionnaireResponses, questionnaires, schedulerBookings } from "@/db/schema";
import { invoiceClientPayableBalanceCents } from "@/lib/invoice-balances";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";

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
  // Phase 9a: a "refunded" payment is settled — never chase it (the exact "follow up
  // on money that was refunded" failure). Exclude it from unpaid rows, metrics, and
  // the next-payment-due / overdue action items.
  const unpaidRows = rows.filter((row) => row.status !== "paid" && row.status !== "waived" && row.status !== "refunded");
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

export type PendingEngagementSession = {
  eventId: string;
  projectId: string;
  projectName: string;
  weddingDate: string | null;
  clientName: string | null;
};

export async function listPendingEngagementSessions() {
  const rows = await db
    .select({
      eventId: projectEvents.id,
      projectId: projects.id,
      projectName: projects.name,
      weddingDate: projects.eventDate,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      participantCreatedAt: projectParticipants.createdAt,
    })
    .from(projectEvents)
    .innerJoin(projects, eq(projectEvents.projectId, projects.id))
    .leftJoin(projectParticipants, and(
      eq(projectParticipants.projectId, projects.id),
      eq(projectParticipants.isPrimaryContact, true),
    ))
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(and(
      eq(projectEvents.type, "engagement"),
      isNull(projectEvents.eventDate),
      eq(projects.status, "active"),
    ));

  const seen = new Set<string>();
  return rows
    .toSorted((a, b) => (
      String(a.weddingDate ?? "9999-12-31").localeCompare(String(b.weddingDate ?? "9999-12-31"))
      || String(a.participantCreatedAt ?? "").localeCompare(String(b.participantCreatedAt ?? ""))
    ))
    .filter((row) => {
      if (seen.has(row.eventId)) return false;
      seen.add(row.eventId);
      return true;
    })
    .map((row): PendingEngagementSession => ({
      eventId: row.eventId,
      projectId: row.projectId,
      projectName: row.projectName,
      weddingDate: row.weddingDate,
      clientName: [row.clientFirstName, row.clientLastName].filter(Boolean).join(" ") || null,
    }));
}

export type DashboardActionKind =
  | "engagement_session"
  | "invoice_payment"
  | "proposal_waiting"
  | "questionnaire_draft"
  | "inquiry_followup";

export type DashboardActionItem = {
  id: string;
  kind: DashboardActionKind;
  href: string;
  label: string;
  detail: string;
  projectId: string | null;
  projectName: string | null;
  clientName: string | null;
  dueDate: string | null;
};

function clientName(firstName?: string | null, lastName?: string | null) {
  return [firstName, lastName].filter(Boolean).join(" ") || null;
}

function compactDetail(...parts: Array<string | number | null | undefined>) {
  return parts.filter((part) => part !== null && part !== undefined && String(part).trim() !== "").join(" · ");
}

export async function listDashboardActionItems(now = new Date(), limit = 8): Promise<DashboardActionItem[]> {
  const today = dateKey(now);
  const [pendingEngagements, invoicePaymentRows, proposalRows, questionnaireRows, inquiryRows] = await Promise.all([
    listPendingEngagementSessions(),
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
        projectId: projects.id,
        projectName: projects.name,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
      })
      .from(invoicePayments)
      .innerJoin(invoices, eq(invoicePayments.invoiceId, invoices.id))
      .innerJoin(projects, eq(invoices.projectId, projects.id))
      .leftJoin(projectParticipants, and(
        eq(projectParticipants.projectId, projects.id),
        eq(projectParticipants.isPrimaryContact, true),
      ))
      .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
      .where(and(
        eq(projects.status, "active"),
        ne(invoicePayments.status, "paid"),
        ne(invoicePayments.status, "waived"),
        ne(invoices.status, "paid"),
        ne(invoices.status, "void"),
      ))
      .orderBy(asc(invoicePayments.dueDate), asc(invoicePayments.createdAt)),
    db
      .select({
        proposalId: proposals.id,
        proposalTitle: proposals.title,
        status: proposals.status,
        sentAt: proposals.sentAt,
        projectId: projects.id,
        projectName: projects.name,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
      })
      .from(proposals)
      .innerJoin(projects, eq(proposals.projectId, projects.id))
      .leftJoin(projectParticipants, and(
        eq(projectParticipants.projectId, projects.id),
        eq(projectParticipants.isPrimaryContact, true),
      ))
      .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
      .where(and(
        eq(projects.status, "active"),
        inArray(proposals.status, ["sent", "viewed"]),
        isNull(proposals.signedAt),
      ))
      .orderBy(asc(proposals.sentAt), asc(proposals.createdAt)),
    db
      .select({
        responseId: questionnaireResponses.id,
        questionnaireId: questionnaires.id,
        questionnaireTitle: questionnaires.title,
        updatedAt: questionnaireResponses.updatedAt,
        projectId: projects.id,
        projectName: projects.name,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
      })
      .from(questionnaireResponses)
      .innerJoin(questionnaires, eq(questionnaireResponses.questionnaireId, questionnaires.id))
      .leftJoin(projects, eq(questionnaireResponses.projectId, projects.id))
      .leftJoin(clients, eq(questionnaireResponses.clientId, clients.id))
      .where(and(
        isNull(questionnaireResponses.submittedAt),
        isNotNull(questionnaireResponses.clientId),
        or(isNull(questionnaireResponses.projectId), eq(projects.status, "active")),
      ))
      .orderBy(asc(questionnaireResponses.updatedAt)),
    db
      .select({
        projectId: projects.id,
        projectName: projects.name,
        stage: projects.stage,
        createdAt: projects.createdAt,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
      })
      .from(projects)
      .leftJoin(projectParticipants, and(
        eq(projectParticipants.projectId, projects.id),
        eq(projectParticipants.isPrimaryContact, true),
      ))
      .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
      .where(and(
        eq(projects.status, "active"),
        eq(projects.stage, "inquiry"),
      ))
      .orderBy(asc(projects.createdAt)),
  ]);

  const actions: DashboardActionItem[] = [
    ...pendingEngagements.map((session) => ({
      id: session.eventId,
      kind: "engagement_session" as const,
      href: `/projects/${session.projectId}#events`,
      label: "Schedule engagement session",
      detail: compactDetail(session.projectName, session.weddingDate ? `Wedding ${session.weddingDate}` : null, session.clientName),
      projectId: session.projectId,
      projectName: session.projectName,
      clientName: session.clientName,
      dueDate: session.weddingDate,
    })),
    ...invoicePaymentRows
      .filter((row) => row.status !== "paid" && row.status !== "waived" && row.status !== "refunded")
      .map((row) => ({
        id: row.paymentId,
        kind: "invoice_payment" as const,
        href: `/invoices/${row.invoiceId}`,
        label: row.dueDate && row.dueDate < today ? "Follow up on overdue payment" : "Upcoming payment due",
        detail: compactDetail(row.invoiceNumber, row.label, row.dueDate ? `Due ${row.dueDate}` : null),
        projectId: row.projectId,
        projectName: row.projectName,
        clientName: clientName(row.clientFirstName, row.clientLastName),
        dueDate: row.dueDate,
      })),
    ...proposalRows.map((row) => ({
      id: row.proposalId,
      kind: "proposal_waiting" as const,
      href: `/proposals/${row.proposalId}`,
      label: "Proposal waiting on client",
      detail: compactDetail(row.proposalTitle, row.sentAt ? `Sent ${row.sentAt.slice(0, 10)}` : row.status),
      projectId: row.projectId,
      projectName: row.projectName,
      clientName: clientName(row.clientFirstName, row.clientLastName),
      dueDate: row.sentAt?.slice(0, 10) ?? null,
    })),
    ...questionnaireRows.map((row) => ({
      id: row.responseId,
      kind: "questionnaire_draft" as const,
      href: `/questionnaires/${row.questionnaireId}/responses/${row.responseId}`,
      label: "Questionnaire draft in progress",
      detail: compactDetail(row.questionnaireTitle, row.updatedAt ? `Updated ${row.updatedAt.slice(0, 10)}` : null),
      projectId: row.projectId,
      projectName: row.projectName,
      clientName: clientName(row.clientFirstName, row.clientLastName),
      dueDate: row.updatedAt?.slice(0, 10) ?? null,
    })),
    ...inquiryRows.map((row) => ({
      id: row.projectId,
      kind: "inquiry_followup" as const,
      href: `/projects/${row.projectId}`,
      label: "Follow up on inquiry",
      detail: compactDetail(row.projectName, clientName(row.clientFirstName, row.clientLastName)),
      projectId: row.projectId,
      projectName: row.projectName,
      clientName: clientName(row.clientFirstName, row.clientLastName),
      dueDate: row.createdAt?.slice(0, 10) ?? null,
    })),
  ];

  return actions.slice(0, Math.max(0, limit));
}

export async function getDashboardMetrics(now = new Date()) {
  const { startIso, endIso } = monthBounds(now);

  const [acceptedProposals, inquiryProjects, bookingInquiries, invoicePaymentRows, openInvoices] = await Promise.all([
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
        eq(projects.status, "active"),
        inArray(projects.stage, ["inquiry", "proposal_sent"]),
        gte(projects.createdAt, startIso),
        lt(projects.createdAt, endIso),
      )),
    db
      .select({
        id: schedulerBookings.id,
        projectId: schedulerBookings.projectId,
        clientId: schedulerBookings.clientId,
        attendeeEmail: schedulerBookings.attendeeEmail,
      })
      .from(schedulerBookings)
      .leftJoin(projects, eq(schedulerBookings.projectId, projects.id))
      .where(and(
        gte(schedulerBookings.createdAt, startIso),
        lt(schedulerBookings.createdAt, endIso),
        or(isNull(schedulerBookings.projectId), eq(projects.status, "active")),
      )),
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
    db.query.invoices.findMany({
      where: and(
        ne(invoices.status, "paid"),
        ne(invoices.status, "void"),
      ),
    }),
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
  const openInvoiceIds = openInvoices.map((invoice) => invoice.id);
  const openInvoiceLedgerRows = openInvoiceIds.length
    ? await db.query.invoicePayments.findMany({
        where: (payment, { inArray }) => inArray(payment.invoiceId, openInvoiceIds),
      })
    : [];
  const paymentsByInvoice = new Map<string, Array<typeof invoicePayments.$inferSelect>>();
  for (const payment of openInvoiceLedgerRows) {
    paymentsByInvoice.set(payment.invoiceId, [...(paymentsByInvoice.get(payment.invoiceId) ?? []), payment]);
  }

  return {
    acceptedBookedValueCents: acceptedProposals.reduce((sum, proposal) => sum + (proposal.totalCents ?? 0), 0),
    inquiriesThisMonth: inquiryKeys.size,
    clientPayableOutstandingPaymentCents: openInvoices.reduce(
      (sum, invoice) => sum + invoiceClientPayableBalanceCents(invoice, paymentsByInvoice.get(invoice.id) ?? []),
      0,
    ),
    ...summarizeInvoicePaymentMetrics(openInvoicePayments, now),
  };
}
