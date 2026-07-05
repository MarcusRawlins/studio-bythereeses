import { db } from "@/db/client";
import { clients, invoicePayments, invoices, portalAccessTokens, projectEvents, projectGalleries, projectLocations, projectParticipants, projectTimelineItems, projects, proposals, questionnaireResponses, questionnaires, schedulerBookings, schedulerMeetingTypes } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { isGalleryUrlSafe } from "@/lib/gallery";
import { invoiceClientPayableBalanceCents, invoiceClientPayableCents, invoicePaymentClientPayableOpenCents, invoicePaymentOpenCents } from "@/lib/invoice-balances";
import { createQuestionnaireContext, getQuestionnairePublicUrl } from "@/lib/questionnaire-links";
import { createProposalLinkFromForm } from "@/lib/sales";
import { sendPortalMagicLinkEmail } from "@/lib/email";
import { getBookingManageUrls } from "@/lib/scheduler";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { createHash, randomBytes } from "node:crypto";

const PORTAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

// Phase 6.5 magic-link tunables (all have safe defaults; the feature is gated
// OFF by default behind PORTAL_MAGIC_LINK_ENABLED).
const PORTAL_MAGIC_LINK_PER_EMAIL_WINDOW_MINUTES = 15;

function magicLinkEnabled() {
  return process.env.PORTAL_MAGIC_LINK_ENABLED === "1";
}

// Phase 7a: client-facing "Your Gallery" section. OFF by default so the
// feature ships dark — Tyler can populate galleries via admin (always on)
// and verify via agent context before flipping this on. Read in the function
// body (not a destructured default param) to avoid the TS2559 weak-type
// pitfall from `env: {...} = process.env`.
function galleryPortalEnabled() {
  return process.env.PORTAL_GALLERY_ENABLED === "1";
}

function magicLinkTtlMinutes() {
  const value = Number(process.env.PORTAL_MAGIC_LINK_TTL_MINUTES);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 20;
}

function magicLinkPerEmailMax() {
  const value = Number(process.env.PORTAL_MAGIC_LINK_PER_EMAIL_MAX);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 3;
}

function magicLinkMaxProjects() {
  const value = Number(process.env.PORTAL_MAGIC_LINK_MAX_PROJECTS);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 5;
}

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

// Best-effort request IP. Wrapped so a missing request scope (e.g. tests, or a
// deferred task) can never fail a login — the value is only used for audit.
async function requestIp(): Promise<string> {
  try {
    return (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  } catch {
    return "local";
  }
}

// Shared 30-day httpOnly portal session cookie setter — the single source of
// truth for cookie options. Used by both `authenticatePortalToken` (direct /p/
// link redemption) and `consumePortalMagicLink` (magic-link redemption). Do NOT
// duplicate the cookie options anywhere else.
async function establishPortalSessionCookies(tokenId: string, projectId: string) {
  const cookieStore = await cookies();
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: PORTAL_COOKIE_MAX_AGE,
    path: "/",
  };
  cookieStore.set("portal_project_id", projectId, cookieOptions);
  cookieStore.set("portal_token_id", tokenId, cookieOptions);
}

export async function authenticatePortalToken(token: string) {
  const hashed = hashToken(token);
  const tokenRecord = await db.query.portalAccessTokens.findFirst({
    // [N4] Defense-in-depth: a leaked magic-request token must never be
    // redeemable as a direct portal link — only kind:"session" rows resolve
    // here. Magic-request redemption goes exclusively through
    // `consumePortalMagicLink`.
    where: and(eq(portalAccessTokens.tokenHash, hashed), eq(portalAccessTokens.kind, "session")),
  });

  if (!tokenRecord || tokenRecord.revokedAt || new Date(tokenRecord.expiresAt) < new Date()) {
    return { ok: false as const, reason: "invalid" };
  }

  const ip = await requestIp();

  await db
    .update(portalAccessTokens)
    .set({ lastUsedAt: new Date().toISOString(), lastUsedIp: ip })
    .where(eq(portalAccessTokens.id, tokenRecord.id));

  await establishPortalSessionCookies(tokenRecord.id, tokenRecord.projectId);

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
      // [N4] Even a mis-set cookie pointing at a magic_request row must not
      // resolve a session. The session cookie only ever holds a kind:"session"
      // tokenId; pinning it here is defense-in-depth.
      eq(portalAccessTokens.kind, "session"),
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

  const [eventRows, locationRows, timelineItems, projectProposals, projectInvoices, bookingRows, responseRows, galleryRows] = await Promise.all([
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
    // Phase 7a: flag-gated so the client-facing portal surface does zero work
    // (and no query) when PORTAL_GALLERY_ENABLED is unset — dark by default.
    // Delivered-only for clients; draft/archived galleries are never returned
    // here (they remain visible to admin + the always-on agent reader).
    galleryPortalEnabled()
      ? db.query.projectGalleries.findMany({
          where: and(eq(projectGalleries.projectId, projectId), eq(projectGalleries.status, "delivered")),
          orderBy: [desc(projectGalleries.deliveredAt), desc(projectGalleries.createdAt)],
        })
      : Promise.resolve([] as Array<typeof projectGalleries.$inferSelect>),
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
    // Phase 7a: "Your Gallery" — delivered-only (enforced by the query above),
    // scoped to this `projectId` (never client-supplied — resolved from the
    // session cookie/token by requirePortalProject). Belt-and-suspenders
    // https re-check per §4.3: even a hand-edited D1 row cannot surface a
    // non-https URL to the client-facing portal.
    galleries: galleryRows
      .filter((gallery) => isGalleryUrlSafe(gallery.url))
      .map((gallery) => ({
        id: gallery.id,
        title: gallery.title,
        provider: gallery.provider,
        url: gallery.url,
        passcode: gallery.passcode,
        deliveredAt: gallery.deliveredAt,
        expiresAt: gallery.expiresAt,
      })),
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

function magicLinkVerifyUrl(token: string) {
  return `${portalBaseUrl().replace(/\/$/, "")}/portal/login/verify/${token}`;
}

/**
 * Resolve the active projects a self-service email address can reach. Email is
 * stored canonical (lower/trim, migrations 0033/0052), so the lookup normalizes
 * the input the same way. Only `projects.status = "active"` projects are
 * returned — archived/cancelled projects never mint a fresh session.
 */
export async function resolveActiveProjectsForEmail(email: string): Promise<Array<{
  clientId: string;
  clientFirstName: string | null;
  projectId: string;
  projectName: string;
  projectCreatedAt: string;
}>> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return [];
  return db
    .select({
      clientId: clients.id,
      clientFirstName: clients.firstName,
      projectId: projects.id,
      projectName: projects.name,
      projectCreatedAt: projects.createdAt,
    })
    .from(clients)
    .innerJoin(projectParticipants, eq(projectParticipants.clientId, clients.id))
    .innerJoin(projects, eq(projects.id, projectParticipants.projectId))
    .where(and(eq(clients.email, normalized), eq(projects.status, "active")));
}

/**
 * Deferred self-service magic-link task. [B3/N1] This runs entirely AFTER the
 * HTTP response has been committed (registered via `ctx.waitUntil` on Workers /
 * `queueMicrotask` locally). All email-correlated work — resolution, per-email
 * cap, throwaway hash, mint, send — lives here so a matching and a non-matching
 * email produce byte-identical, same-time responses on the request's critical
 * path. It MUST never throw: a rejected `waitUntil` task is invisible to the
 * client and any failure must not surface.
 */
export async function requestPortalMagicLink({ email }: { email: string }): Promise<void> {
  try {
    // Flag off → identical no-op (the endpoint already returns the uniform
    // response; this simply schedules nothing observable).
    if (!magicLinkEnabled()) return;

    const rows = await resolveActiveProjectsForEmail(email);

    if (!rows.length) {
      // [3.1 step 3] Equalize the crypto path on no-match so the deferred task's
      // own duration does not become a (log-only) oracle. Never persisted.
      hashToken(randomBytes(32).toString("base64url"));
      return;
    }

    const clientId = rows[0].clientId;
    const clientFirstName = rows[0].clientFirstName ?? null;

    // [B3/N3] Per-email cap on request-batches (not raw tokens), enforced from
    // D1 on the deferred path. A single request for a K-project client mints K
    // tokens sharing one requestBatchId, so counting distinct batches means
    // "N emails per client per window" regardless of project count.
    const windowStart = new Date(Date.now() - PORTAL_MAGIC_LINK_PER_EMAIL_WINDOW_MINUTES * 60_000).toISOString();
    const recent = await db
      .select({ requestBatchId: portalAccessTokens.requestBatchId })
      .from(portalAccessTokens)
      .where(and(
        eq(portalAccessTokens.clientId, clientId),
        eq(portalAccessTokens.kind, "magic_request"),
        gt(portalAccessTokens.createdAt, windowStart),
      ));
    const distinctBatches = new Set(recent.map((row) => row.requestBatchId).filter(Boolean));
    if (distinctBatches.size >= magicLinkPerEmailMax()) return;

    // Dedupe projects (one participant row per project by unique index, but be
    // defensive) and cap to the N most recently created active projects.
    const byProject = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      if (!byProject.has(row.projectId)) byProject.set(row.projectId, row);
    }
    const uniqueProjects = [...byProject.values()].sort((a, b) =>
      (b.projectCreatedAt ?? "").localeCompare(a.projectCreatedAt ?? ""),
    );
    const maxProjects = magicLinkMaxProjects();
    if (uniqueProjects.length > maxProjects) {
      console.warn(
        `portal magic link: client ${clientId} has ${uniqueProjects.length} active projects; capping to ${maxProjects}`,
      );
    }
    const projectsToLink = uniqueProjects.slice(0, maxProjects);

    const ttlMinutes = magicLinkTtlMinutes();
    const batchId = crypto.randomUUID();
    const links: Array<{ projectName: string; url: string }> = [];

    for (const project of projectsToLink) {
      const token = randomBytes(32).toString("base64url");
      const tokenRecordId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
      await db.insert(portalAccessTokens).values({
        id: tokenRecordId,
        projectId: project.projectId,
        clientId,
        tokenHash: hashToken(token),
        kind: "magic_request",
        label: "Self-service magic link",
        requestBatchId: batchId,
        expiresAt,
        createdAt: new Date().toISOString(),
      });
      links.push({ projectName: project.projectName, url: magicLinkVerifyUrl(token) });
      await logActivity({
        projectId: project.projectId,
        clientId,
        action: "portal.magic_link.requested",
        actorType: "client",
        actorName: "Client",
        metadata: { tokenId: tokenRecordId, expiresAt, batchId },
      });
    }

    if (!links.length) return;

    await sendPortalMagicLinkEmail({
      to: email.trim().toLowerCase(),
      clientFirstName,
      links,
      ttlMinutes,
    });
  } catch (error) {
    // Swallow + log: a deferred task must never surface a rejection.
    console.error("requestPortalMagicLink failed", error);
  }
}

/**
 * [N2] Read-only liveness peek for the verify GET interstitial. Does NOT consume
 * the token — mail-scanner prefetch of the GET must be harmless. Consumption is
 * exclusively the atomic claim in `consumePortalMagicLink` (POST).
 */
export async function peekPortalMagicLink(token: string): Promise<{ ok: boolean }> {
  const hashed = hashToken(token);
  const row = await db.query.portalAccessTokens.findFirst({
    where: and(eq(portalAccessTokens.tokenHash, hashed), eq(portalAccessTokens.kind, "magic_request")),
  });
  if (!row || row.revokedAt || row.consumedAt || new Date(row.expiresAt) < new Date()) {
    return { ok: false };
  }
  return { ok: true };
}

/**
 * Atomic single-use redemption of a magic-request token. On success it mints the
 * existing 30-day kind:"session" token and sets the standard portal session
 * cookies, exactly as `authenticatePortalToken` does (shared cookie helper).
 * Reuse / expiry / double-click all resolve to `{ ok: false }` with no
 * differentiation between expired, consumed, or unknown.
 */
export async function consumePortalMagicLink(token: string): Promise<
  { ok: true; projectId: string } | { ok: false; reason: "invalid" }
> {
  const hashed = hashToken(token);
  const row = await db.query.portalAccessTokens.findFirst({
    where: and(eq(portalAccessTokens.tokenHash, hashed), eq(portalAccessTokens.kind, "magic_request")),
  });

  if (!row) {
    // Unknown token — do NOT write an activity row. This POST is unauthenticated
    // and only tokenAccess-rate-limited, so logging here would let an attacker
    // spam D1 writes with random tokens. There is nothing to attribute anyway
    // (no project/client). Real-but-invalid tokens below are still logged.
    return { ok: false as const, reason: "invalid" };
  }

  if (row.revokedAt || row.consumedAt || new Date(row.expiresAt) < new Date()) {
    await logActivity({
      projectId: row.projectId,
      clientId: row.clientId,
      action: "portal.magic_link.rejected",
      actorType: "system",
      metadata: { reason: row.consumedAt ? "consumed" : row.revokedAt ? "revoked" : "expired" },
    });
    return { ok: false as const, reason: "invalid" };
  }

  const ip = await requestIp();

  // Atomic single-use: only the first UPDATE that flips consumed_at (while it is
  // still NULL) returns a row. Concurrent double-clicks / prefetch races can
  // never both win.
  const claimed = await db
    .update(portalAccessTokens)
    .set({ consumedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), lastUsedIp: ip })
    .where(and(eq(portalAccessTokens.id, row.id), isNull(portalAccessTokens.consumedAt)))
    .returning({ id: portalAccessTokens.id });

  if (!claimed.length) {
    await logActivity({
      projectId: row.projectId,
      clientId: row.clientId,
      action: "portal.magic_link.rejected",
      actorType: "system",
      metadata: { reason: "consumed" },
    });
    return { ok: false as const, reason: "invalid" };
  }

  // Establish the existing 30-day session: mint a fresh kind:"session" token and
  // set cookies exactly as authenticatePortalToken does.
  const session = await createPortalLink({
    projectId: row.projectId,
    clientId: row.clientId,
    label: "Client portal session (magic link)",
    actorType: "client",
    actorName: "Client",
  });
  await establishPortalSessionCookies(session.tokenId, row.projectId);

  await logActivity({
    projectId: row.projectId,
    clientId: row.clientId,
    action: "portal.magic_link.consumed",
    actorType: "client",
    actorName: "Client",
    metadata: { requestTokenId: row.id, sessionTokenId: session.tokenId },
  });

  return { ok: true as const, projectId: row.projectId };
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
