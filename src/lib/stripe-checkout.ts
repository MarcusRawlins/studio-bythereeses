import { db } from "@/db/client";
import { clients, invoicePayments, invoices, projectParticipants, projects } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { invoicePaymentClientPayableOpenCents, invoicePaymentOpenCents } from "@/lib/invoice-balances";
import { autoAdvanceProjectStageForRetainerPayment, reconciledInvoicePaymentStatus } from "@/lib/sales";
import { dispatchStripeRefundOrDisputeEvent } from "@/lib/stripe-refunds";
import { and, asc, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { createHmac, timingSafeEqual } from "node:crypto";

const STRIPE_API_VERSION = "2026-02-25.clover";

function appBaseUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SCHEDULE_URL || "http://localhost:3000").replace(/\/$/, "");
}

function stripeSecretKey() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("Stripe is not configured. Add STRIPE_SECRET_KEY before creating checkout links.");
  return key;
}

function stripeWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("Stripe webhook is not configured. Add STRIPE_WEBHOOK_SECRET before accepting webhook events.");
  return secret;
}

function stripeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stripeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stripeSessionResponseBody(body: unknown) {
  if (!body || typeof body !== "object") return {};
  return body as Record<string, unknown>;
}

function stripeErrorMessage(body: Record<string, unknown>) {
  const error = body.error;
  if (!error || typeof error !== "object") return null;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function safeRevalidatePath(path: string) {
  try {
    revalidatePath(path);
  } catch {
    // Unit tests call mutation helpers outside a Next request store.
  }
}

async function createStripeCheckoutSession(params: URLSearchParams) {
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${stripeSecretKey()}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": STRIPE_API_VERSION,
    },
    body: params,
  });

  const body = stripeSessionResponseBody(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new Error(stripeErrorMessage(body) ?? "Stripe checkout session creation failed.");
  }

  const id = stripeString(body.id);
  const url = stripeString(body.url);
  if (!id || !url) {
    throw new Error("Stripe did not return a checkout URL.");
  }

  return { id, url };
}

function parseStripeSignatureHeader(header: string | null) {
  const parts = new Map<string, string[]>();
  for (const item of (header ?? "").split(",")) {
    const [key, value] = item.split("=", 2);
    if (!key || !value) continue;
    parts.set(key, [...(parts.get(key) ?? []), value]);
  }

  const timestamp = Number(parts.get("t")?.[0] ?? "");
  const signatures = parts.get("v1") ?? [];
  if (!Number.isFinite(timestamp) || !signatures.length) {
    throw new Error("Invalid Stripe signature header.");
  }

  return { timestamp, signatures };
}

function secureCompareHex(actualHex: string, expectedHex: string) {
  const actual = Buffer.from(actualHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyStripeWebhookPayload({
  rawBody,
  signatureHeader,
  secret = stripeWebhookSecret(),
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  rawBody: string;
  signatureHeader: string | null;
  secret?: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}) {
  const { timestamp, signatures } = parseStripeSignatureHeader(signatureHeader);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new Error("Stripe webhook signature timestamp is outside the tolerance window.");
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  if (!signatures.some((signature) => secureCompareHex(signature, expectedSignature))) {
    throw new Error("Stripe webhook signature verification failed.");
  }

  return JSON.parse(rawBody) as Record<string, unknown>;
}

function checkoutSessionObject(event: Record<string, unknown>) {
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const object = (data as Record<string, unknown>).object;
  return object && typeof object === "object" ? object as Record<string, unknown> : null;
}

function checkoutSessionMetadata(session: Record<string, unknown>) {
  const metadata = session.metadata;
  return metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
}

function checkoutSessionPaymentIntentId(session: Record<string, unknown>) {
  const paymentIntent = session.payment_intent;
  if (typeof paymentIntent === "string") return paymentIntent;
  if (paymentIntent && typeof paymentIntent === "object") return stripeString((paymentIntent as Record<string, unknown>).id) || null;
  return null;
}

function calculatedCardFeeAmountCents(subtotalCents: number, percentBps: number | null, fixedCents: number | null) {
  const percent = percentBps ?? 290;
  const fixed = fixedCents ?? 30;
  if (subtotalCents <= 0 || percent <= 0) return 0;
  return Math.round(subtotalCents * (percent / 10000)) + Math.max(fixed, 0);
}

export async function createInvoicePaymentCheckoutSession(
  invoiceId: string,
  paymentId: string,
  activityOptions: {
    actorType?: "admin" | "client" | "system" | "agent";
    actorName?: string | null;
  } = {},
) {
  const rows = await db
    .select({
      invoice: invoices,
      payment: invoicePayments,
      project: projects,
      client: clients,
      participant: projectParticipants,
    })
    .from(invoicePayments)
    .innerJoin(invoices, eq(invoicePayments.invoiceId, invoices.id))
    .innerJoin(projects, eq(invoices.projectId, projects.id))
    .leftJoin(projectParticipants, and(
      eq(projectParticipants.projectId, projects.id),
      eq(projectParticipants.isPrimaryContact, true),
    ))
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(invoicePayments.id, paymentId))
    .limit(1);

  const row = rows[0];
  if (!row || row.invoice.id !== invoiceId || row.payment.invoiceId !== invoiceId) {
    throw new Error("Invoice payment not found.");
  }

  if (!row.client?.email) {
    throw new Error("Add a primary client with an email address before creating a checkout link for this invoice payment.");
  }

  if (row.payment.status === "paid" || row.payment.status === "waived" || row.payment.status === "refunded") {
    // Phase 9a: a refunded payment is settled/terminal — do NOT mint a fresh Stripe
    // checkout link for it.
    throw new Error("Checkout can only be created for an open invoice payment.");
  }

  if (row.payment.stripeCheckoutUrl && row.payment.stripeCheckoutStatus === "link_ready") {
    return {
      invoiceId,
      projectId: row.project.id,
      paymentId: row.payment.id,
      checkoutUrl: row.payment.stripeCheckoutUrl,
      checkoutSessionId: row.payment.stripeCheckoutSessionId,
      checkoutStatus: row.payment.stripeCheckoutStatus,
      clientPayableOpenCents: 0,
      reused: true,
    };
  }

  const allPayments = await db.query.invoicePayments.findMany({
    where: eq(invoicePayments.invoiceId, invoiceId),
  });
  const paidClientFeeCents = allPayments.reduce((sum, payment) => (
    payment.status === "paid" ? sum + payment.clientFeeCents : sum
  ), 0);
  const remainingClientFeeCents = Math.max(row.invoice.cardFeeAmountCents - paidClientFeeCents, 0);
  const openServiceTotalCents = allPayments.reduce((sum, payment) => sum + invoicePaymentOpenCents(payment), 0);
  const clientPayableOpenCents = invoicePaymentClientPayableOpenCents({
    payment: row.payment,
    openServiceTotalCents,
    remainingClientFeeCents,
  });
  if (clientPayableOpenCents <= 0) {
    throw new Error("Checkout can only be created for an open invoice payment balance.");
  }

  const baseUrl = appBaseUrl();
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", `${baseUrl}/portal?checkout=success&invoiceId=${encodeURIComponent(invoiceId)}&paymentId=${encodeURIComponent(paymentId)}`);
  params.set("cancel_url", `${baseUrl}/portal?checkout=cancelled&invoiceId=${encodeURIComponent(invoiceId)}&paymentId=${encodeURIComponent(paymentId)}`);
  params.set("customer_email", row.client.email);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][unit_amount]", String(clientPayableOpenCents));
  params.set("line_items[0][price_data][product_data][name]", `${row.invoice.invoiceNumber} - ${row.payment.label}`);
  params.set("line_items[0][price_data][product_data][description]", row.project.name);
  params.set("metadata[invoice_id]", invoiceId);
  params.set("metadata[payment_id]", paymentId);
  params.set("metadata[project_id]", row.project.id);
  params.set("metadata[service_open_cents]", String(invoicePaymentOpenCents(row.payment)));
  params.set("metadata[client_payable_open_cents]", String(clientPayableOpenCents));

  const session = await createStripeCheckoutSession(params);
  const now = new Date().toISOString();
  await db.update(invoicePayments).set({
    stripeCheckoutUrl: session.url,
    stripeCheckoutSessionId: session.id,
    stripeCheckoutStatus: "link_ready",
    updatedAt: now,
  }).where(eq(invoicePayments.id, paymentId));

  await logActivity({
    projectId: row.project.id,
    clientId: row.client.id,
    action: "invoice.checkout_session_created",
    actorType: activityOptions.actorType ?? "admin",
    actorName: activityOptions.actorName ?? "Tyler Reese",
    metadata: {
      invoiceId,
      paymentId,
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
      clientPayableOpenCents,
      serviceOpenCents: invoicePaymentOpenCents(row.payment),
      remainingClientFeeCents,
    },
  });

  safeRevalidatePath("/invoices");
  safeRevalidatePath(`/invoices/${invoiceId}`);
  safeRevalidatePath("/portal");

  return {
    invoiceId,
    projectId: row.project.id,
    paymentId: row.payment.id,
    checkoutUrl: session.url,
    checkoutSessionId: session.id,
    checkoutStatus: "link_ready",
    clientPayableOpenCents,
    reused: false,
  };
}

export async function settleInvoicePaymentCheckoutSession(session: Record<string, unknown>, eventCreatedSeconds?: number | null) {
  const sessionId = stripeString(session.id);
  if (!sessionId) throw new Error("Stripe checkout session id is required.");

  const paymentStatus = stripeString(session.payment_status);
  const sessionStatus = stripeString(session.status);
  if (paymentStatus && paymentStatus !== "paid") {
    return { ignored: true, reason: "checkout_session_not_paid", checkoutSessionId: sessionId };
  }
  if (sessionStatus && sessionStatus !== "complete") {
    return { ignored: true, reason: "checkout_session_not_complete", checkoutSessionId: sessionId };
  }

  const metadata = checkoutSessionMetadata(session);
  const metadataInvoiceId = stripeString(metadata.invoice_id);
  const metadataPaymentId = stripeString(metadata.payment_id);
  const payment = await db.query.invoicePayments.findFirst({
    where: metadataPaymentId ? eq(invoicePayments.id, metadataPaymentId) : eq(invoicePayments.stripeCheckoutSessionId, sessionId),
  });
  if (!payment || (metadataPaymentId && payment.id !== metadataPaymentId)) {
    throw new Error("Invoice payment not found for Stripe checkout session.");
  }
  if (payment.stripeCheckoutSessionId && payment.stripeCheckoutSessionId !== sessionId) {
    throw new Error("Stripe checkout session does not match the canonical invoice payment.");
  }

  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, payment.invoiceId) });
  if (!invoice) throw new Error("Invoice not found for Stripe checkout session.");
  if (metadataInvoiceId && invoice.id !== metadataInvoiceId) {
    throw new Error("Stripe checkout session invoice metadata does not match the payment row.");
  }

  const project = await db.query.projects.findFirst({ where: eq(projects.id, invoice.projectId) });
  if (!project) throw new Error("Project not found for Stripe checkout session.");

  const clientRow = await db
    .select({ client: clients })
    .from(projectParticipants)
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(projectParticipants.projectId, project.id))
    .orderBy(desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt))
    .limit(1);
  const client = clientRow[0]?.client ?? null;

  const paymentIntentId = checkoutSessionPaymentIntentId(session);
  if (paymentIntentId) {
    const existingExternalPayment = await db.query.invoicePayments.findFirst({
      where: eq(invoicePayments.externalPaymentId, paymentIntentId),
    });
    if (existingExternalPayment && existingExternalPayment.id !== payment.id) {
      throw new Error("Stripe payment intent is already linked to another invoice payment.");
    }
  }

  if (payment.status === "paid" || payment.status === "refunded") {
    // Both are settled: a replayed checkout.session.completed on an already-settled payment
    // is an idempotent no-op. Without the "refunded" case the settle path proceeds and throws
    // "no longer has an open balance" -> 400 -> Stripe retries to exhaustion (Fable rev-3 #2).
    return {
      ignored: true,
      reason: "invoice_payment_already_paid",
      invoiceId: invoice.id,
      projectId: project.id,
      paymentId: payment.id,
      checkoutSessionId: sessionId,
    };
  }

  const amountTotalCents = stripeNumber(session.amount_total);
  if (!amountTotalCents || amountTotalCents <= 0) {
    throw new Error("Stripe checkout session amount_total is required.");
  }

  const metadataServiceOpenCents = stripeNumber(Number(metadata.service_open_cents));
  const serviceOpenCents = metadataServiceOpenCents && metadataServiceOpenCents > 0
    ? Math.min(metadataServiceOpenCents, invoicePaymentOpenCents(payment))
    : invoicePaymentOpenCents(payment);
  if (serviceOpenCents <= 0) {
    throw new Error("Invoice payment no longer has an open balance.");
  }
  if (amountTotalCents < serviceOpenCents) {
    throw new Error("Stripe checkout session total is lower than the open service payment amount.");
  }

  const clientFeeCents = Math.max(amountTotalCents - serviceOpenCents, 0);
  const estimatedProcessingFeeCents = clientFeeCents > 0
    ? clientFeeCents
    : calculatedCardFeeAmountCents(serviceOpenCents, invoice.cardFeePercentBps, invoice.cardFeeFixedCents);
  const paidAt = eventCreatedSeconds
    ? new Date(eventCreatedSeconds * 1000).toISOString()
    : new Date().toISOString();
  const now = new Date().toISOString();

  await db.update(invoicePayments).set({
    status: "paid",
    paidAt,
    paymentMethod: "stripe",
    paidAmountCents: serviceOpenCents,
    clientFeeCents,
    processingFeeCents: estimatedProcessingFeeCents,
    grossCollectedCents: amountTotalCents,
    netDepositCents: Math.max(amountTotalCents - estimatedProcessingFeeCents, 0),
    externalPaymentId: paymentIntentId,
    stripeCheckoutUrl: stripeString(session.url) || payment.stripeCheckoutUrl,
    stripeCheckoutSessionId: sessionId,
    stripeCheckoutStatus: "paid",
    notes: payment.notes ?? "Recorded automatically from Stripe Checkout.",
    updatedAt: now,
  }).where(eq(invoicePayments.id, payment.id));

  const payments = await db.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, invoice.id) });
  const paidTotal = payments.reduce((sum, row) => {
    if (row.id === payment.id) return sum + serviceOpenCents;
    return row.status === "paid" ? sum + row.paidAmountCents : sum;
  }, 0);
  const nextStatus = reconciledInvoicePaymentStatus(invoice, paidTotal);
  await db.update(invoices).set({
    amountPaidCents: paidTotal,
    status: nextStatus,
    paidAt: nextStatus === "paid" ? paidAt : null,
    updatedAt: now,
  }).where(eq(invoices.id, invoice.id));

  await logActivity({
    projectId: project.id,
    clientId: client?.id,
    action: "invoice.payment_recorded_from_stripe_checkout",
    actorType: "system",
    actorName: "Stripe Checkout",
    metadata: {
      invoiceId: invoice.id,
      paymentId: payment.id,
      checkoutSessionId: sessionId,
      paymentIntentId,
      paidAt,
      paidAmountCents: serviceOpenCents,
      clientFeeCents,
      processingFeeCents: estimatedProcessingFeeCents,
      grossCollectedCents: amountTotalCents,
      netDepositCents: Math.max(amountTotalCents - estimatedProcessingFeeCents, 0),
    },
  });
  await autoAdvanceProjectStageForRetainerPayment({
    projectId: project.id,
    invoiceId: invoice.id,
    paymentId: payment.id,
    paymentLabel: payment.label,
    status: "paid",
    paidAmountCents: serviceOpenCents,
    actorType: "system",
    actorName: "Stripe Checkout",
    metadata: { checkoutSessionId: sessionId, paymentIntentId },
  });

  safeRevalidatePath("/invoices");
  safeRevalidatePath(`/invoices/${invoice.id}`);
  safeRevalidatePath(`/projects/${project.id}`);
  safeRevalidatePath("/portal");

  return {
    ignored: false,
    invoiceId: invoice.id,
    projectId: project.id,
    paymentId: payment.id,
    checkoutSessionId: sessionId,
    paymentIntentId,
    paidAmountCents: serviceOpenCents,
    clientFeeCents,
    processingFeeCents: estimatedProcessingFeeCents,
    grossCollectedCents: amountTotalCents,
  };
}

export async function expireInvoicePaymentCheckoutSession(session: Record<string, unknown>, eventCreatedSeconds?: number | null) {
  const sessionId = stripeString(session.id);
  if (!sessionId) throw new Error("Stripe checkout session id is required.");

  const metadata = checkoutSessionMetadata(session);
  const metadataInvoiceId = stripeString(metadata.invoice_id);
  const metadataPaymentId = stripeString(metadata.payment_id);
  const payment = await db.query.invoicePayments.findFirst({
    where: metadataPaymentId ? eq(invoicePayments.id, metadataPaymentId) : eq(invoicePayments.stripeCheckoutSessionId, sessionId),
  });

  if (!payment) {
    return { ignored: true, reason: "invoice_payment_not_found", checkoutSessionId: sessionId };
  }
  if (payment.stripeCheckoutSessionId && payment.stripeCheckoutSessionId !== sessionId) {
    throw new Error("Stripe checkout session does not match the canonical invoice payment.");
  }
  if (payment.status === "paid" || payment.status === "waived") {
    return {
      ignored: true,
      reason: "invoice_payment_already_closed",
      paymentId: payment.id,
      checkoutSessionId: sessionId,
    };
  }
  if (payment.stripeCheckoutStatus === "expired") {
    return {
      ignored: true,
      reason: "checkout_session_already_expired",
      paymentId: payment.id,
      checkoutSessionId: sessionId,
    };
  }

  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, payment.invoiceId) });
  if (!invoice) throw new Error("Invoice not found for Stripe checkout session.");
  if (metadataInvoiceId && invoice.id !== metadataInvoiceId) {
    throw new Error("Stripe checkout session invoice metadata does not match the payment row.");
  }

  const project = await db.query.projects.findFirst({ where: eq(projects.id, invoice.projectId) });
  if (!project) throw new Error("Project not found for Stripe checkout session.");

  const clientRow = await db
    .select({ client: clients })
    .from(projectParticipants)
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(projectParticipants.projectId, project.id))
    .orderBy(desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt))
    .limit(1);
  const client = clientRow[0]?.client ?? null;
  const expiredAt = eventCreatedSeconds
    ? new Date(eventCreatedSeconds * 1000).toISOString()
    : new Date().toISOString();

  await db.update(invoicePayments).set({
    stripeCheckoutUrl: stripeString(session.url) || payment.stripeCheckoutUrl,
    stripeCheckoutSessionId: sessionId,
    stripeCheckoutStatus: "expired",
    updatedAt: new Date().toISOString(),
  }).where(eq(invoicePayments.id, payment.id));

  await logActivity({
    projectId: project.id,
    clientId: client?.id,
    action: "invoice.checkout_session_expired",
    actorType: "system",
    actorName: "Stripe Checkout",
    metadata: {
      invoiceId: invoice.id,
      paymentId: payment.id,
      checkoutSessionId: sessionId,
      expiredAt,
    },
  });

  safeRevalidatePath("/invoices");
  safeRevalidatePath(`/invoices/${invoice.id}`);
  safeRevalidatePath(`/projects/${project.id}`);
  safeRevalidatePath("/portal");

  return {
    ignored: false,
    invoiceId: invoice.id,
    projectId: project.id,
    paymentId: payment.id,
    checkoutSessionId: sessionId,
    checkoutStatus: "expired",
  };
}

export async function handleStripeCheckoutWebhook(rawBody: string, signatureHeader: string | null) {
  const event = verifyStripeWebhookPayload({ rawBody, signatureHeader });
  const eventType = stripeString(event.type);
  if (
    eventType !== "checkout.session.completed"
    && eventType !== "checkout.session.async_payment_succeeded"
    && eventType !== "checkout.session.expired"
  ) {
    // Phase 9a: reuse the already-verified webhook path. After the existing checkout
    // branch, delegate refund/dispute/chargeback events to the sibling recording module
    // (which handles event-id dedupe + convergent per-object writes). The checkout
    // short-circuit above is UNTOUCHED and is NOT gated behind the new dedupe.
    return dispatchStripeRefundOrDisputeEvent(event, eventType);
  }

  const session = checkoutSessionObject(event);
  if (!session) throw new Error("Stripe checkout session payload is missing.");
  const created = stripeNumber(event.created);
  if (eventType === "checkout.session.expired") {
    return expireInvoicePaymentCheckoutSession(session, created);
  }

  return settleInvoicePaymentCheckoutSession(session, created);
}
