import { db } from "@/db/client";
import { clients, invoicePayments, invoices, projectParticipants, projects } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { invoicePaymentClientPayableOpenCents, invoicePaymentOpenCents } from "@/lib/invoice-balances";
import { autoAdvanceProjectStageForRetainerPayment, reconciledInvoicePaymentStatus } from "@/lib/sales";
import { dispatchStripeRefundOrDisputeEvent } from "@/lib/stripe-refunds";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
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

// Phase 12 (§4.3c): read a stored Checkout Session's return URLs so we can detect whether a reused
// `link_ready` session (e.g. one an admin pre-minted with /portal return URLs) carries DIFFERENT
// return URLs than the requested client override. A read (no money). Returns null on any failure —
// callers treat "cannot confirm a match" conservatively (expire + re-mint) so the client is never
// dropped on the /portal lock wall.
async function fetchStripeCheckoutSessionReturnUrls(sessionId: string) {
  try {
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${stripeSecretKey()}`,
        "stripe-version": STRIPE_API_VERSION,
      },
    });
    if (!response.ok) return null;
    const body = stripeSessionResponseBody(await response.json().catch(() => ({})));
    return {
      successUrl: stripeString(body.success_url),
      cancelUrl: stripeString(body.cancel_url),
      status: stripeString(body.status), // "open" | "complete" | "expired"
    };
  } catch {
    return null;
  }
}

// Phase 12 (§4.3c): expire a stored session whose return URLs are WRONG for the client surface.
// Stripe sessions are immutable, so expiring is the only way to make the old one uncompletable —
// guaranteeing the subsequent re-mint cannot leave TWO payable sessions live. Expiring moves NO
// money (it renders a session uncompletable — the opposite of a charge).
async function expireStripeCheckoutSessionById(sessionId: string) {
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${stripeSecretKey()}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": STRIPE_API_VERSION,
    },
  });
  if (!response.ok) {
    const body = stripeSessionResponseBody(await response.json().catch(() => ({})));
    throw new Error(stripeErrorMessage(body) ?? "Stripe checkout session expire failed.");
  }
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
    // Phase 12 (§4.3a): ADDITIVE, optional. Defaults (below) are the exact current
    // /portal?checkout=success|cancelled… strings, so every existing caller is byte-identical.
    // When provided (the unified sign&pay accept route), these route the client back to the
    // token surface instead of the /portal lock wall.
    returnUrls?: { successUrl: string; cancelUrl: string };
  } = {},
) {
  const { returnUrls } = activityOptions;
  if (returnUrls) {
    // Open-redirect defense-in-depth: the caller server-constructs these from constants + the
    // already-public token, but assert same-origin anyway.
    // Match on `base + "/"` (or exact base) so `https://app.example.com.evil.com/...` cannot pass
    // a bare prefix check (defense-in-depth; URLs are server-constructed today).
    const base = appBaseUrl();
    const onOrigin = (url: string) => url === base || url.startsWith(`${base}/`);
    if (!onOrigin(returnUrls.successUrl) || !onOrigin(returnUrls.cancelUrl)) {
      throw new Error("Checkout return URLs must be on the application origin.");
    }
  }

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

  // Track the session id present at reuse-read time so the CAS write below can only win against
  // THIS observed value (or a null row) — a concurrent racer that already stored its own session
  // makes our CAS no-op (§4.3b).
  const priorCheckoutSessionId = row.payment.stripeCheckoutSessionId;

  if (row.payment.stripeCheckoutUrl && row.payment.stripeCheckoutStatus === "link_ready") {
    // No override (every existing installment caller) → reuse verbatim, byte-identical to today.
    if (!returnUrls) {
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

    // Override provided (§4.3c): reuse the stored session ONLY when its return URLs already match
    // the requested override (e.g. the resume-CTA re-POST). If they differ (e.g. an admin-pre-minted
    // /portal session at first client sign), the stored session is uncompletable-for-the-client:
    // EXPIRE it (immutable → cannot mutate its URLs) and fall through to a fresh mint with the client
    // return URLs. Because the old session is expired first, this can NOT create two payable sessions.
    const storedReturnUrls = row.payment.stripeCheckoutSessionId
      ? await fetchStripeCheckoutSessionReturnUrls(row.payment.stripeCheckoutSessionId)
      : null;
    // Reuse ONLY an "open" session whose return URLs already match. A Stripe-expired/complete
    // session (webhook lagged, so our row still reads link_ready) must NOT be reused — the client
    // would hit Stripe's "link expired" page — so treat non-open as a mismatch and mint fresh.
    const matches = storedReturnUrls
      && storedReturnUrls.status === "open"
      && storedReturnUrls.successUrl === returnUrls.successUrl
      && storedReturnUrls.cancelUrl === returnUrls.cancelUrl;
    if (matches) {
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
    // Expire the stale session only if it is still OPEN at Stripe (expiring an already
    // expired/complete session errors). A non-open session is already uncompletable, so we just
    // fall through to a fresh mint (the CAS still matches this row via priorCheckoutSessionId).
    if (row.payment.stripeCheckoutSessionId && storedReturnUrls?.status === "open") {
      await expireStripeCheckoutSessionById(row.payment.stripeCheckoutSessionId);
    }
    // Fall through to the fresh mint. priorCheckoutSessionId still holds the expired session's id
    // so the CAS matches this row (WHERE stripeCheckoutSessionId = priorCheckoutSessionId).
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
  params.set("success_url", returnUrls?.successUrl ?? `${baseUrl}/portal?checkout=success&invoiceId=${encodeURIComponent(invoiceId)}&paymentId=${encodeURIComponent(paymentId)}`);
  params.set("cancel_url", returnUrls?.cancelUrl ?? `${baseUrl}/portal?checkout=cancelled&invoiceId=${encodeURIComponent(invoiceId)}&paymentId=${encodeURIComponent(paymentId)}`);
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

  // Phase 12 (§4.3b — Finding 1 BLOCKER): conditional single-statement CAS. D1 has no
  // transactions, so between the reuse-read above and this write two concurrent accepts could both
  // mint. The WHERE clause stores ONLY the first racer's session (the row is still unclaimed —
  // stripeCheckoutSessionId IS NULL — or still holds the id we observed at reuse-read time, e.g.
  // an expired-and-reminted session); a losing racer's write matches 0 rows and no-ops. For a
  // single (non-concurrent) caller the WHERE is satisfied and this is byte-identical to today.
  await db.update(invoicePayments).set({
    stripeCheckoutUrl: session.url,
    stripeCheckoutSessionId: session.id,
    stripeCheckoutStatus: "link_ready",
    updatedAt: now,
  }).where(and(
    eq(invoicePayments.id, paymentId),
    priorCheckoutSessionId
      ? or(isNull(invoicePayments.stripeCheckoutSessionId), eq(invoicePayments.stripeCheckoutSessionId, priorCheckoutSessionId))
      : isNull(invoicePayments.stripeCheckoutSessionId),
  ));

  // RE-READ the row and treat the STORED session as canonical — never the local in-flight
  // session.url. Every racer therefore returns/redirects to the ONE canonical session; the loser's
  // freshly-minted Stripe session is never handed to a browser (it later checkout.session.expired's
  // via the no-op branch, since its id is not the stored/canonical one).
  const canonicalRow = await db.query.invoicePayments.findFirst({ where: eq(invoicePayments.id, paymentId) });
  const canonicalCheckoutUrl = canonicalRow?.stripeCheckoutUrl ?? session.url;
  const canonicalCheckoutSessionId = canonicalRow?.stripeCheckoutSessionId ?? session.id;

  await logActivity({
    projectId: row.project.id,
    clientId: row.client.id,
    action: "invoice.checkout_session_created",
    actorType: activityOptions.actorType ?? "admin",
    actorName: activityOptions.actorName ?? "Tyler Reese",
    metadata: {
      invoiceId,
      paymentId,
      // Log the CANONICAL session (re-read from the row), not this call's in-flight session — under
      // a concurrent race the loser's in-flight url/id is non-canonical and must never be copyable
      // out of the activity log.
      checkoutSessionId: canonicalCheckoutSessionId,
      checkoutUrl: canonicalCheckoutUrl,
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
    // Canonical (re-read) values — the stored session all racers converge on, not the in-flight one.
    checkoutUrl: canonicalCheckoutUrl,
    checkoutSessionId: canonicalCheckoutSessionId,
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
    // A SUPERSEDED session expiring is expected and harmless: the fused sign-pay flow (Phase 12)
    // proactively expires an admin-pre-minted session and re-mints a canonical one, and concurrent
    // accepts leave a losing session that Stripe later expires. That session is NOT the canonical
    // row, so treat its checkout.session.expired as an idempotent no-op — do NOT throw (a throw
    // 500s the webhook and Stripe retries to exhaustion, ~3d of alert noise). The SETTLE handler
    // keeps its mismatch throw — that one is the money guard (a non-canonical session must never
    // record a payment).
    return { ignored: true, reason: "non_canonical_session_expired", checkoutSessionId: sessionId };
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
