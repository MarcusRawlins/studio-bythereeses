import { db } from "@/db/client";
import { clients, invoicePayments, invoices, portalAccessTokens, projectEvents, projectLocations, projectParticipants, projectTimelineItems, projects, proposals, questionnaireResponses, questionnaires, schedulerBookings, schedulerMeetingTypes } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { invoiceClientPayableBalanceCents, invoiceClientPayableCents, invoicePaymentClientPayableOpenCents, invoicePaymentOpenCents } from "@/lib/invoice-balances";
import { createQuestionnaireContext, getQuestionnairePublicUrl } from "@/lib/questionnaire-links";
import { createProposalLinkFromForm } from "@/lib/sales";
import { getBookingManageUrls } from "@/lib/scheduler";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { createHash, randomBytes } from "node:crypto";

const PORTAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export type PortalLinkInput = {
  projectId: string;
  clientId?: string | null;
  label?: string | null;
  actorType?: "admin" | "agent" | "client" | "system";
  actorName?: string | null;
};

export type PortalLink = {
  projectId: string;
  clientId: string | null;
  label: string;
  tokenId: string;
  expiresAt: string;
  url: string;
};

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function portalBaseUrl() {
  return process.env.PORTAL_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

function portalProposalUrl(proposalId: string) {
  return `${portalBaseUrl().replace(/\/$/, "")}/portal/proposals/${proposalId}`;
}

export async function generatePortalLink(projectId: string, clientId?: string | null) {
  const link = await createPortalLink({ projectId, clientId });
  return link.url;
}

export async function createPortalLink({
  projectId,
  clientId = null,
  label,
  actorType,
  actorName,
}: PortalLinkInput): Promise<PortalLink> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) {
    throw new Error("Project not found.");
  }

  const normalizedClientId = clientId?.trim() || null;
  if (normalizedClientId) {
    const participant = await db.query.projectParticipants.findFirst({
      where: and(eq(projectParticipants.projectId, projectId), eq(projectParticipants.clientId, normalizedClientId)),
    });
    if (!participant) {
      throw new Error("Portal client is not linked to this project.");
    }
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const normalizedLabel = label?.trim() || "Client portal link";
  const tokenRecordId = crypto.randomUUID();
  await db.insert(portalAccessTokens).values({
    id: tokenRecordId,
    projectId,
    clientId: normalizedClientId,
    tokenHash,
    label: normalizedLabel,
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString(),
  });

  await logActivity({
    projectId,
    clientId: normalizedClientId,
    action: "portal_token.generated",
    actorType,
    actorName,
    metadata: { tokenRecordId, expiresAt: expiresAt.toISOString() },
  });

  return {
    projectId,
    clientId: normalizedClientId,
    label: normalizedLabel,
    tokenId: tokenRecordId,
    expiresAt: expiresAt.toISOString(),
    url: `${portalBaseUrl()}/p/${token}`,
  };
}

export async function createPortalLinkFromAgent(projectId: string, input: Omit<PortalLinkInput, "projectId" | "actorType" | "actorName">) {
  return createPortalLink({
    projectId,
    clientId: input.clientId,
    label: input.label,
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
  });
}

export async function authenticatePortalToken(token: string) {
  const hashed = hashToken(token);
  const tokenRecord = await db.query.portalAccessTokens.findFirst({
    where: eq(portalAccessTokens.tokenHash, hashed),
  });

  if (!tokenRecord || tokenRecord.revokedAt || new Date(tokenRecord.expiresAt) < new Date()) {
    return { ok: false as const, reason: "invalid" };
  }

  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

  await db
    .update(portalAccessTokens)
    .set({ lastUsedAt: new Date().toISOString(), lastUsedIp: ip })
    .where(eq(portalAccessTokens.id, tokenRecord.id));

  const cookieStore = await cookies();
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: PORTAL_COOKIE_MAX_AGE,
    path: "/",
  };
  cookieStore.set("portal_project_id", tokenRecord.projectId, cookieOptions);
  cookieStore.set("portal_token_id", tokenRecord.id, cookieOptions);

  await logActivity({
    projectId: tokenRecord.projectId,
    clientId: tokenRecord.clientId,
    action: "portal.login",
    actorType: "client",
    actorName: "Client",
  });

  return { ok: true as const, projectId: tokenRecord.projectId };
}

export async function clearPortalSession() {
  const cookieStore = await cookies();
  cookieStore.delete("portal_project_id");
  cookieStore.delete("portal_token_id");
}

export async function revokePortalToken(tokenId: string) {
  const token = await db.query.portalAccessTokens.findFirst({
    where: eq(portalAccessTokens.id, tokenId),
  });
  if (!token) return;
  if (token.revokedAt) return;
  await db
    .update(portalAccessTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(portalAccessTokens.id, tokenId));
  await logActivity({
    projectId: token.projectId,
    clientId: token.clientId,
    action: "portal_token.revoked",
    metadata: { tokenId },
  });
}

export async function requirePortalProject() {
  const cookieStore = await cookies();
  const projectId = cookieStore.get("portal_project_id")?.value;
  const tokenId = cookieStore.get("portal_token_id")?.value;

  if (!projectId || !tokenId) return null;

  const token = await db.query.portalAccessTokens.findFirst({
    where: and(
      eq(portalAccessTokens.id, tokenId),
      eq(portalAccessTokens.projectId, projectId),
      isNull(portalAccessTokens.revokedAt),
    ),
  });

  if (!token || new Date(token.expiresAt) < new Date()) {
    return null;
  }

  const rows = await db
    .select({
      project: projects,
      client: clients,
    })
    .from(projectParticipants)
    .innerJoin(projects, eq(projectParticipants.projectId, projects.id))
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(projects.id, projectId));

  if (!rows.length) return null;

  await logActivity({
    projectId,
    clientId: token.clientId,
    action: "portal.project_viewed",
    actorType: "client",
    actorName: rows[0].client.preferredName ?? rows[0].client.firstName,
  });

  const context = await getPortalProjectContext(projectId, token.clientId);
  if (!context) return null;

  return {
    ...context,
    token,
  };
}

function joinedName(client: typeof clients.$inferSelect) {
  return [client.firstName, client.lastName].filter(Boolean).join(" ");
}

function portalInvoicePaymentOptions(invoice: typeof invoices.$inferSelect) {
  let parsedMethods: Array<{ key?: unknown; displayName?: unknown; instructions?: unknown; passFees?: unknown }> = [];
  if (invoice.acceptedPaymentMethodsJson) {
    try {
      const parsed = JSON.parse(invoice.acceptedPaymentMethodsJson);
      parsedMethods = Array.isArray(parsed) ? parsed : [];
    } catch {
      parsedMethods = [];
    }
  }

  const options = parsedMethods
    .map((method) => {
      const key = typeof method.key === "string" ? method.key : "";
      if (!key) return null;
      const displayName = typeof method.displayName === "string" && method.displayName.trim()
        ? method.displayName.trim()
        : key.replaceAll("_", " ");
      const storedInstructions = typeof method.instructions === "string" ? method.instructions.trim() : "";
      const instructions = key === "stripe"
        ? invoice.stripePaymentLink ?? storedInstructions
        : storedInstructions || (key === "zelle" ? invoice.zelleInfo ?? "" : key === "venmo" ? invoice.venmoInfo ?? "" : "");
      return {
        key,
        displayName,
        instructions,
        passFees: method.passFees === true,
      };
    })
    .filter((method): method is { key: string; displayName: string; instructions: string; passFees: boolean } => Boolean(method));

  if (options.length) return options;

  return [
    invoice.stripePaymentLink
      ? { key: "stripe", displayName: "Credit card", instructions: invoice.stripePaymentLink, passFees: invoice.cardFeePolicy === "client_pays" }
      : null,
    invoice.zelleInfo
      ? { key: "zelle", displayName: "Zelle", instructions: invoice.zelleInfo, passFees: false }
      : null,
    invoice.venmoInfo
      ? { key: "venmo", displayName: "Venmo", instructions: invoice.venmoInfo, passFees: false }
      : null,
  ].filter((method): method is { key: string; displayName: string; instructions: string; passFees: boolean } => Boolean(method));
}

export async function getPortalProjectContext(projectId: string, clientId?: string | null) {
  const participantRows = await db
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

  const project = participantRows[0]?.project;
  if (!project) return null;
  const clientRows = participantRows.map((row) => row.client);
  const primaryClient = clientId
    ? clientRows.find((client) => client.id === clientId) ?? clientRows[0] ?? null
    : clientRows[0] ?? null;

  const [eventRows, locationRows, timelineItems, projectProposals, projectInvoices, bookingRows, responseRows] = await Promise.all([
    db.query.projectEvents.findMany({
      where: eq(projectEvents.projectId, projectId),
      orderBy: asc(projectEvents.eventDate),
    }),
    db.query.projectLocations.findMany({
      where: eq(projectLocations.projectId, projectId),
      orderBy: asc(projectLocations.createdAt),
    }),
    db.query.projectTimelineItems.findMany({
      where: eq(projectTimelineItems.projectId, projectId),
      orderBy: asc(projectTimelineItems.sortOrder),
    }),
    db.query.proposals.findMany({
      where: eq(proposals.projectId, projectId),
      orderBy: desc(proposals.createdAt),
    }),
    db.query.invoices.findMany({
      where: eq(invoices.projectId, projectId),
      orderBy: desc(invoices.createdAt),
    }),
    db
      .select({
        booking: schedulerBookings,
        meetingType: schedulerMeetingTypes,
      })
      .from(schedulerBookings)
      .innerJoin(schedulerMeetingTypes, eq(schedulerBookings.meetingTypeId, schedulerMeetingTypes.id))
      .where(eq(schedulerBookings.projectId, projectId))
      .orderBy(asc(schedulerBookings.startAt)) as unknown as Promise<Array<{
        booking: typeof schedulerBookings.$inferSelect;
        meetingType: typeof schedulerMeetingTypes.$inferSelect;
      }>>,
    db
      .select({
        response: questionnaireResponses,
        questionnaire: questionnaires,
      })
      .from(questionnaireResponses)
      .innerJoin(questionnaires, eq(questionnaireResponses.questionnaireId, questionnaires.id))
      .where(eq(questionnaireResponses.projectId, projectId))
      .orderBy(desc(questionnaireResponses.updatedAt)) as unknown as Promise<Array<{
        response: typeof questionnaireResponses.$inferSelect;
        questionnaire: typeof questionnaires.$inferSelect;
      }>>,
  ]);

  const invoiceIds = projectInvoices.map((invoice) => invoice.id);
  const payments = invoiceIds.length
    ? await db.query.invoicePayments.findMany({
        where: (payment, { inArray }) => inArray(payment.invoiceId, invoiceIds),
        orderBy: asc(invoicePayments.dueDate),
      })
    : [];
  const paymentsByInvoiceId = new Map<string, Array<typeof invoicePayments.$inferSelect>>();
  for (const payment of payments) {
    paymentsByInvoiceId.set(payment.invoiceId, [...(paymentsByInvoiceId.get(payment.invoiceId) ?? []), payment]);
  }

  const portalInvoices = projectInvoices.map((invoice) => {
    const invoicePaymentsRows = paymentsByInvoiceId.get(invoice.id) ?? [];
    const clientPayableCents = invoiceClientPayableCents(invoice);
    const clientPayableBalanceCents = invoiceClientPayableBalanceCents(invoice, invoicePaymentsRows);
    const serviceBalanceCents = Math.max(invoice.totalCents - invoice.amountPaidCents, 0);
    const paidClientFeeCents = invoicePaymentsRows.reduce((sum, payment) => {
      if (payment.status !== "paid") return sum;
      return sum + payment.clientFeeCents;
    }, 0);
    const remainingClientFeeCents = Math.max(invoice.cardFeeAmountCents - paidClientFeeCents, 0);
    const openServiceTotalCents = invoicePaymentsRows.reduce((sum, payment) => sum + invoicePaymentOpenCents(payment), 0);
    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      proposalId: invoice.proposalId,
      status: invoice.status,
      totalCents: invoice.totalCents,
      amountPaidCents: invoice.amountPaidCents,
      balanceCents: clientPayableBalanceCents,
      cardFeeAmountCents: invoice.cardFeeAmountCents,
      clientPayableCents,
      clientPayableBalanceCents,
      serviceBalanceCents,
      remainingClientFeeCents,
      paymentNotes: invoice.paymentNotes,
      paymentOptions: portalInvoicePaymentOptions(invoice),
      dueDate: invoice.dueDate,
      stripePaymentLink: invoice.stripePaymentLink,
      paidAt: invoice.paidAt,
      payments: invoicePaymentsRows.map((payment) => ({
        id: payment.id,
        label: payment.label,
        amountCents: payment.amountCents,
        dueDate: payment.dueDate,
        status: payment.status,
        paidAt: payment.paidAt,
        paidAmountCents: payment.paidAmountCents,
        clientFeeCents: payment.clientFeeCents,
        grossCollectedCents: payment.grossCollectedCents,
        netDepositCents: payment.netDepositCents,
        openCents: invoicePaymentOpenCents(payment),
        clientPayableOpenCents: invoicePaymentClientPayableOpenCents({
          payment,
          openServiceTotalCents,
          remainingClientFeeCents,
        }),
        stripeCheckoutUrl: payment.stripeCheckoutUrl,
        stripeCheckoutStatus: payment.stripeCheckoutStatus,
      })),
    };
  });

  return {
    project,
    clients: clientRows,
    primaryClient,
    primaryClientName: primaryClient ? (primaryClient.preferredName ?? joinedName(primaryClient)) : null,
    events: eventRows.map((event) => ({
      id: event.id,
      type: event.type,
      title: event.title,
      eventDate: event.eventDate,
      venueName: event.venueName,
      venueAddress: event.venueAddress,
      city: event.city,
      state: event.state,
      notes: event.notes,
    })),
    locations: locationRows.map((location) => ({
      id: location.id,
      type: location.type,
      name: location.name,
      address: location.address,
      city: location.city,
      state: location.state,
      notes: location.notes,
    })),
    timelineItems: timelineItems.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      startAt: item.startAt,
      endAt: item.endAt,
      sortOrder: item.sortOrder,
    })),
    proposals: projectProposals.map((proposal) => ({
      id: proposal.id,
      title: proposal.title,
      status: proposal.status,
      packageName: proposal.packageName,
      totalCents: proposal.totalCents,
      scopeSummary: proposal.scopeSummary,
      contractStatus: proposal.contractStatus,
      invoiceStatus: proposal.invoiceStatus,
      sentAt: proposal.sentAt,
      acceptedAt: proposal.acceptedAt,
      signedAt: proposal.signedAt,
      proposalUrl: portalProposalUrl(proposal.id),
    })),
    invoices: portalInvoices,
    schedulerBookings: bookingRows.map((row) => {
      const urls = getBookingManageUrls(row.meetingType.slug, row.booking);
      return {
        id: row.booking.id,
        meetingTypeName: row.meetingType.name,
        startAt: row.booking.startAt,
        endAt: row.booking.endAt,
        status: row.booking.status,
        paymentStatus: row.booking.paymentStatus,
        paidAmountCents: row.booking.paidAmountCents,
        grossCollectedCents: row.booking.grossCollectedCents,
        netDepositCents: row.booking.netDepositCents,
        paymentMethod: row.booking.paymentMethod,
        paidAt: row.booking.paidAt,
        paymentLink: row.booking.paymentLink,
        manageUrl: urls.manageUrl,
        rescheduleUrl: urls.rescheduleUrl,
      };
    }),
    questionnaireResponses: responseRows.map((row) => ({
      id: row.response.id,
      questionnaireId: row.questionnaire.id,
      questionnaireTitle: row.questionnaire.title,
      status: row.response.submittedAt ? "submitted" as const : "draft" as const,
      respondentName: row.response.respondentName,
      respondentEmail: row.response.respondentEmail,
      submittedAt: row.response.submittedAt,
      updatedAt: row.response.updatedAt,
      questionnaireUrl: getQuestionnairePublicUrl(
        row.questionnaire.id,
        createQuestionnaireContext(row.questionnaire.id, row.response.projectId, row.response.clientId ?? primaryClient?.id),
      ),
    })),
    moneySummary: portalInvoices.reduce((sum, invoice) => ({
      invoiceTotalCents: sum.invoiceTotalCents + invoice.totalCents,
      invoicePaidCents: sum.invoicePaidCents + invoice.amountPaidCents,
      invoiceOpenCents: sum.invoiceOpenCents + invoice.clientPayableBalanceCents,
      schedulerPaidCents: sum.schedulerPaidCents,
    }), {
      invoiceTotalCents: 0,
      invoicePaidCents: 0,
      invoiceOpenCents: 0,
      schedulerPaidCents: bookingRows.reduce((sum, row) => sum + row.booking.paidAmountCents, 0),
    }),
  };
}

export async function createPortalProposalAccessLink(projectId: string, proposalId: string, clientId?: string | null) {
  const proposal = await db.query.proposals.findFirst({
    where: and(eq(proposals.id, proposalId), eq(proposals.projectId, projectId)),
  });
  if (!proposal) return null;

  const participant = clientId
    ? await db.query.projectParticipants.findFirst({
        where: and(eq(projectParticipants.projectId, projectId), eq(projectParticipants.clientId, clientId)),
      })
    : await db.query.projectParticipants.findFirst({
        where: eq(projectParticipants.projectId, projectId),
        orderBy: desc(projectParticipants.isPrimaryContact),
      });
  if (!participant) return null;

  const formData = new FormData();
  formData.set("proposalId", proposalId);
  formData.set("projectId", projectId);
  formData.set("clientId", participant.clientId);
  formData.set("label", "Client portal proposal package");

  return createProposalLinkFromForm(formData);
}
