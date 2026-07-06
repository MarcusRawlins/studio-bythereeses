// Phase 9b — Refund INITIATION (the ONLY code in the app that calls a Stripe MUTATING
// endpoint, POST /v1/refunds — it CAUSES money to leave the bank account; there is no undo).
//
// SCOPE BOUNDARY: 9b initiates, 9a records. This module NEVER writes payment_refunds or
// invoice_payments.refunded_amount_cents — those are owned exclusively by the 9a inbound
// webhook (recordStripeChargeRefunded / recordStripeRefund). The only table 9b writes is
// refund_initiations (audit + idempotency; the row id doubles as the Stripe Idempotency-Key).
//
// SAFETY (all server-side, enforced HERE at the library boundary — not just the routes/UI):
//   - OFF-by-default flag (refundInitiationEnabled, strict === "1"): checked inside the helper.
//   - actorType !== "admin" throws (money movement is ABSENT from the agent surface; §5.3).
//   - SERVICE-portion ceiling (paidAmountCents, NOT gross) with the DEDUPE-UNION already-refunded
//     term (§3.1 / F1): max(webhook, Σlocal(submitting,succeeded) + Σexternal). NEVER plain max.
//   - Retainer HARD-BLOCK (§3.8, reuses the EXPORTED isRetainerPaymentLabel — no copied regex).
//   - "Service not rendered" affirmation + required reason (§3.9).
//   - Dispute block: open OR (lost && !fundsReinstated) (§3.4 / P5 / M5).
//   - In-flight guard: pending→submitting CAS (single UPDATE WHERE status='pending') pins the
//     amount BEFORE the network call; a submitting row is NEVER blind-retried (~24h key expiry, M1).
//   - Fail-closed secret (throws when STRIPE_SECRET_KEY unset); the key is never logged.
//   - No db.transaction / db.batch (D1 rejects them) — per-object convergent writes only.

import { db } from "@/db/client";
import { invoicePayments, invoices, paymentRefunds, refundInitiations } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { refundInitiationEnabled } from "@/lib/finance-flags";
import { isRetainerPaymentLabel } from "@/lib/sales";
import { and, eq, inArray } from "drizzle-orm";

const STRIPE_API_VERSION = "2026-02-25.clover"; // match stripe-checkout.ts
const MAX_REASON_LEN = 500;
const STRIPE_REFUND_REASONS = new Set(["requested_by_customer", "duplicate", "fraudulent"]);

type ActorType = "admin" | "client" | "system" | "agent";
type InvoicePaymentRow = typeof invoicePayments.$inferSelect;

// ---------------------------------------------------------------------------
// Secret handling — fail-closed, never logged (identical to stripe-checkout.ts:17).
// ---------------------------------------------------------------------------
function stripeSecretKey() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("Stripe is not configured. Add STRIPE_SECRET_KEY before issuing refunds.");
  return key;
}

function stripeErrorMessage(body: Record<string, unknown>) {
  const error = body.error;
  if (!error || typeof error !== "object") return null;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function capReason(value: string | null | undefined) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, MAX_REASON_LEN) : null;
}

function normalizedStripeReason(value: string | null | undefined) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text && STRIPE_REFUND_REASONS.has(text)) return text;
  // P2 default: internal reason is the audit trail; Stripe reason is optional metadata.
  return "requested_by_customer";
}

// ---------------------------------------------------------------------------
// The Stripe call (exact pattern — stripe-checkout.ts:57-79 + Idempotency-Key, §7).
// Sends the ROW's persisted amount_cents (pinned in the submitting UPDATE, M3), never a
// prepare-time prefill; metadata[initiation_id] is load-bearing for reconcile-against-Stripe.
// ---------------------------------------------------------------------------
async function createStripeRefund({
  paymentIntentId,
  amountCents,
  stripeReason,
  idempotencyKey,
  invoicePaymentId,
  initiationId,
}: {
  paymentIntentId: string;
  amountCents: number;
  stripeReason: string;
  idempotencyKey: string;
  invoicePaymentId: string;
  initiationId: string;
}) {
  const params = new URLSearchParams();
  params.set("payment_intent", paymentIntentId);
  params.set("amount", String(amountCents)); // service portion only (≤ gross = Stripe's ceiling)
  params.set("reason", stripeReason);
  params.set("metadata[invoice_payment_id]", invoicePaymentId);
  params.set("metadata[initiation_id]", initiationId);

  const response = await fetch("https://api.stripe.com/v1/refunds", {
    method: "POST",
    headers: {
      authorization: `Bearer ${stripeSecretKey()}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": STRIPE_API_VERSION,
      "idempotency-key": idempotencyKey, // at-most-once per initiating action (~24h window)
    },
    body: params,
  });

  const body = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(stripeErrorMessage(body) ?? "Stripe refund failed."); // cleaned message only
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) throw new Error("Stripe did not return a refund id.");
  return { id, status: typeof body.status === "string" ? body.status : null };
}

// ---------------------------------------------------------------------------
// Retainer identity (§3.8). Reuses the EXPORTED isRetainerPaymentLabel (F2) unioned with
// "earliest payment on the invoice" (min dueDate NULLS LAST, tie-break createdAt, tie-break id).
// ---------------------------------------------------------------------------
function earliestPaymentId(payments: InvoicePaymentRow[]): string | null {
  if (!payments.length) return null;
  const sorted = [...payments].sort((a, b) => {
    // dueDate NULLS LAST
    const ad = a.dueDate;
    const bd = b.dueDate;
    if (ad !== bd) {
      if (ad === null || ad === undefined) return 1;
      if (bd === null || bd === undefined) return -1;
      return ad < bd ? -1 : 1;
    }
    const ac = a.createdAt ?? "";
    const bc = b.createdAt ?? "";
    if (ac !== bc) return ac < bc ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0]?.id ?? null;
}

function isRetainerPayment(payment: InvoicePaymentRow, allPayments: InvoicePaymentRow[]) {
  return isRetainerPaymentLabel(payment.label) || payment.id === earliestPaymentId(allPayments);
}

// ---------------------------------------------------------------------------
// SERVICE-portion ceiling with the DEDUPE-UNION already-refunded term (§3.1 / F1).
//
//   serviceCollectedCents      = payment.paidAmountCents               (SERVICE, never gross)
//   webhookRefundedCents       = payment.refundedAmountCents           (9a set-to-authoritative)
//   localInFlightRefundedCents = Σ refund_initiations.amountCents WHERE status IN (submitting,succeeded)
//   externalRefundedCents      = Σ payment_refunds.amountCents whose stripe_refund_id is NOT one
//                                initiated by 9b (matched on refund_initiations.stripe_refund_id
//                                where that id IS NOT NULL — the NULL-footgun guard)
//   alreadyRefundedServiceCents = max( webhookRefundedCents, localInFlightRefundedCents + externalRefundedCents )
//   maxRefundableCents         = max(serviceCollectedCents - alreadyRefundedServiceCents, 0)
//
// NEVER plain max(webhook, Σlocal): a dashboard/external refund (counted by the webhook, no
// initiation row) and a fresh 9b refund (counted locally, webhook not landed) are DISJOINT;
// plain max drops the smaller and over-permits by up to clientFeeCents. See §9.22.
// ---------------------------------------------------------------------------
async function computeMaxRefundableCents(payment: InvoicePaymentRow) {
  const serviceCollectedCents = Math.max(payment.paidAmountCents, 0); // SERVICE the studio kept
  const webhookRefundedCents = Math.max(payment.refundedAmountCents, 0);

  const initiations = await db.query.refundInitiations.findMany({
    where: eq(refundInitiations.invoicePaymentId, payment.id),
  });
  const localInFlightRefundedCents = initiations.reduce(
    (sum, row) => (row.status === "submitting" || row.status === "succeeded" ? sum + Math.max(row.amountCents, 0) : sum),
    0,
  );
  // Only NON-NULL stripe_refund_ids join the exclusion set (NULL footgun: a NULL must never
  // silently swallow the whole NOT-IN like SQL's `NOT IN (…, NULL)` would).
  const initiatedRefundIds = new Set(
    initiations
      .map((row) => row.stripeRefundId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );

  const refundRows = await db.query.paymentRefunds.findMany({
    where: eq(paymentRefunds.invoicePaymentId, payment.id),
  });
  const externalRefundedCents = refundRows.reduce((sum, row) => {
    if (row.stripeRefundId && initiatedRefundIds.has(row.stripeRefundId)) return sum; // 9b-initiated: excluded (no double-count)
    return sum + Math.max(row.amountCents, 0);
  }, 0);

  const alreadyRefundedServiceCents = Math.max(
    webhookRefundedCents,
    localInFlightRefundedCents + externalRefundedCents,
  );
  return Math.max(serviceCollectedCents - alreadyRefundedServiceCents, 0);
}

// ---------------------------------------------------------------------------
// Ownership + eligibility (§3.4). Throws with a clean message on any failure. Also returns
// the project id (for audit logging) and all payments on the invoice (for the retainer arm).
// ---------------------------------------------------------------------------
async function resolveEligiblePayment(invoiceId: string, paymentId: string) {
  const payment = await db.query.invoicePayments.findFirst({ where: eq(invoicePayments.id, paymentId) });
  if (!payment || payment.invoiceId !== invoiceId) {
    throw new Error("Invoice payment not found.");
  }
  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, invoiceId) });
  if (!invoice || invoice.id !== payment.invoiceId) {
    throw new Error("Invoice not found for this payment.");
  }

  if (payment.status !== "paid") {
    throw new Error("Only a settled (paid) payment can be refunded.");
  }
  const paymentIntentId = payment.externalPaymentId?.trim() ?? "";
  if (!paymentIntentId) {
    throw new Error("This payment has no Stripe charge to refund.");
  }
  if (payment.disputeStatus === "open") {
    throw new Error("This payment has an open dispute and cannot be refunded. Disputes resolve through the dispute flow.");
  }
  // dispute_status === "lost" && funds NOT reinstated → the chargeback already pulled the funds
  // (the true double-loss geometry). Block locally rather than lean on Stripe (P5 note (b) / M5).
  // The 9a webhook demotes the summary to "reinstated" only when charge.dispute.funds_reinstated
  // arrives; a summary still reading "lost" therefore means funds were NOT reinstated. A "won" or
  // "reinstated" dispute leaves the funds with us and is refundable normally (subject to the cap).
  if (payment.disputeStatus === "lost") {
    throw new Error("Funds for this payment were already pulled by a lost chargeback; it cannot be refunded.");
  }

  const allPayments = await db.query.invoicePayments.findMany({
    where: eq(invoicePayments.invoiceId, invoiceId),
  });
  if (isRetainerPayment(payment, allPayments)) {
    throw new Error("The initial retainer is non-refundable and cannot be refunded.");
  }

  return { payment, invoice, allPayments, paymentIntentId, projectId: invoice.projectId };
}

async function logInitiationFailed(projectId: string | null, meta: {
  paymentId: string;
  amountCents: number;
  errorMessage: string;
  initiationId: string | null;
}) {
  try {
    await logActivity({
      projectId,
      action: "invoice.payment_refund_initiation_failed",
      actorType: "admin",
      actorName: "Tyler Reese",
      metadata: {
        paymentId: meta.paymentId,
        amountCents: meta.amountCents,
        errorMessage: capReason(meta.errorMessage),
        initiationId: meta.initiationId,
      },
    });
  } catch {
    // Never let an audit-log failure mask the real rejection.
  }
}

// ---------------------------------------------------------------------------
// PREPARE (admin opens refund dialog). Mints a `pending` refund_initiations row and returns
// the SERVICE-basis maxRefundable prefill. Re-runs the flag/admin/eligibility/retainer gates
// so the dialog never opens on a non-refundable payment (the hard block ALSO re-runs at execute).
// ---------------------------------------------------------------------------
export async function prepareInvoicePaymentRefund({
  invoiceId,
  paymentId,
  actorType,
  actorName,
}: {
  invoiceId: string;
  paymentId: string;
  actorType: ActorType;
  actorName?: string | null;
}) {
  if (!refundInitiationEnabled()) throw new Error("Refund initiation is disabled.");
  if (actorType !== "admin") {
    throw new Error("Refunds are admin-only and cannot be initiated by agents or system actors.");
  }

  const { payment, paymentIntentId } = await resolveEligiblePayment(invoiceId, paymentId);
  const maxRefundableCents = await computeMaxRefundableCents(payment);
  if (maxRefundableCents <= 0) {
    throw new Error("No refundable service balance remains on this payment.");
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(refundInitiations).values({
    id,
    invoicePaymentId: paymentId,
    stripePaymentIntentId: paymentIntentId,
    amountCents: maxRefundableCents, // SERVICE-basis PREFILL only (§3.1) — not the final amount
    currency: "usd",
    reason: null,
    serviceNotRenderedConfirmed: 0,
    stripeReason: null,
    status: "pending",
    stripeRefundId: null,
    errorMessage: null,
    initiatedBy: actorName ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return { initiationId: id, maxRefundableCents, currency: "usd" };
}

// ---------------------------------------------------------------------------
// EXECUTE (§4.1 lifecycle: pending → submitting [pin amount, ONE UPDATE, before network]
// → POST /v1/refunds → succeeded/failed). This is the ONLY function that moves money.
// ---------------------------------------------------------------------------
export async function initiateInvoicePaymentRefund({
  invoiceId,
  paymentId,
  initiationId,
  amountCents,
  confirmAmountCents,
  reason,
  serviceNotRenderedConfirmed,
  stripeReason,
  actorType,
  actorName,
}: {
  invoiceId: string;
  paymentId: string;
  initiationId: string;
  amountCents: number;
  confirmAmountCents: number;
  reason: string | null | undefined;
  serviceNotRenderedConfirmed: boolean;
  stripeReason?: string | null;
  actorType: ActorType;
  actorName?: string | null;
}) {
  // (1) Money gate FIRST — a future caller that bypassed the route flag gate still cannot move
  //     money while the flag is off (M4). Flag off ⇒ NO Stripe call is even reachable.
  if (!refundInitiationEnabled()) throw new Error("Refund initiation is disabled.");
  // (2) Admin-only, defense-in-depth. There is NO approval that unlocks this (§5.2/§5.3).
  if (actorType !== "admin") {
    throw new Error("Refunds are admin-only and cannot be initiated by agents or system actors.");
  }

  // (3) Load the initiation row — needed for the in-flight guard AND for audit context.
  const initiation = await db.query.refundInitiations.findFirst({
    where: eq(refundInitiations.id, initiationId),
  });
  if (!initiation) throw new Error("Refund initiation not found.");
  if (initiation.invoicePaymentId !== paymentId) {
    throw new Error("Refund initiation does not match this payment.");
  }

  // (4) In-flight guard (§3.3) — belt-and-suspenders to the Stripe idempotency key.
  if (initiation.status === "succeeded") {
    // Local guard against a double-click racing the network: return the existing result,
    // do NOT call Stripe again (idempotent response).
    return {
      status: "succeeded" as const,
      alreadyProcessed: true,
      initiationId,
      amountCents: initiation.amountCents,
      stripeRefundId: initiation.stripeRefundId,
    };
  }
  if (initiation.status === "submitting") {
    // Money may already have moved. NEVER blind-retry (the idempotency key expires ~24h, M1) —
    // recovery is reconcile-against-Stripe, surfaced by the ~1h tripwire (§4.4(2)).
    return {
      status: "submitting" as const,
      inProgress: true,
      needsReconciliation: true,
      initiationId,
      amountCents: initiation.amountCents,
    };
  }
  if (initiation.status === "failed") {
    throw new Error("This refund initiation already failed. Start a new refund to try again.");
  }
  // status is now 'pending'.

  // (5) Fresh eligibility (§3.4): ownership, paid, pi, dispute block, RETAINER hard-block (§3.8).
  let context;
  try {
    context = await resolveEligiblePayment(invoiceId, paymentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Refund is not eligible.";
    await logInitiationFailed(null, { paymentId, amountCents, errorMessage: message, initiationId });
    throw error;
  }
  const { payment, paymentIntentId, projectId } = context;

  // (6) "Service not rendered" affirmation + required reason (§3.9) — server-side, before any
  //     network call. A direct call without the affirmation throws here (not a UI-only gate).
  const cleanReason = capReason(reason);
  if (serviceNotRenderedConfirmed !== true) {
    const message = "Refunds require an explicit affirmation that service was not rendered.";
    await logInitiationFailed(projectId, { paymentId, amountCents, errorMessage: message, initiationId });
    throw new Error(message);
  }
  if (!cleanReason) {
    const message = "A refund reason is required.";
    await logInitiationFailed(projectId, { paymentId, amountCents, errorMessage: message, initiationId });
    throw new Error(message);
  }

  // (7) Amount validation against the FRESH SERVICE-basis ledger (§3.1) + typed-amount confirm (P3).
  const amount = Number.isFinite(amountCents) ? Math.trunc(amountCents) : NaN;
  const maxRefundableCents = await computeMaxRefundableCents(payment);
  if (!Number.isFinite(amount) || amount <= 0) {
    const message = "Refund amount must be greater than zero.";
    await logInitiationFailed(projectId, { paymentId, amountCents, errorMessage: message, initiationId });
    throw new Error(message);
  }
  if (amount > maxRefundableCents) {
    const message = "Refund amount exceeds the refundable service balance.";
    await logInitiationFailed(projectId, { paymentId, amountCents: amount, errorMessage: message, initiationId });
    throw new Error(message);
  }
  if (Math.trunc(confirmAmountCents) !== amount) {
    const message = "The typed confirmation amount does not match the refund amount.";
    await logInitiationFailed(projectId, { paymentId, amountCents: amount, errorMessage: message, initiationId });
    throw new Error(message);
  }

  const cleanStripeReason = normalizedStripeReason(stripeReason);
  const now = new Date().toISOString();

  // (8) CAS claim pending → submitting, PINNING the amount, in ONE UPDATE, BEFORE the network
  //     call (M3). The Stripe request then sends the ROW's persisted amount, so the row, the
  //     Σ-cap, and the Stripe request are byte-identical. No db.transaction (D1 rejects it).
  await db
    .update(refundInitiations)
    .set({
      status: "submitting",
      amountCents: amount,
      reason: cleanReason,
      serviceNotRenderedConfirmed: 1,
      stripeReason: cleanStripeReason,
      updatedAt: now,
    })
    .where(and(eq(refundInitiations.id, initiationId), eq(refundInitiations.status, "pending")));

  const claimed = await db.query.refundInitiations.findFirst({
    where: eq(refundInitiations.id, initiationId),
  });
  if (!claimed || claimed.status !== "submitting") {
    // Lost the pending→submitting race to a concurrent execute; do NOT call Stripe.
    return {
      status: "submitting" as const,
      inProgress: true,
      needsReconciliation: claimed?.status === "submitting",
      initiationId,
      amountCents: claimed?.amountCents ?? amount,
    };
  }

  // (9) The money-moving call. Sends claimed.amountCents (the ROW's persisted, pinned amount).
  try {
    const refund = await createStripeRefund({
      paymentIntentId,
      amountCents: claimed.amountCents,
      stripeReason: cleanStripeReason,
      idempotencyKey: initiationId, // = the row id
      invoicePaymentId: paymentId,
      initiationId,
    });
    await db
      .update(refundInitiations)
      .set({ status: "succeeded", stripeRefundId: refund.id, errorMessage: null, updatedAt: new Date().toISOString() })
      .where(eq(refundInitiations.id, initiationId));

    await logActivity({
      projectId,
      action: "invoice.payment_refund_initiated",
      actorType: "admin",
      actorName: actorName ?? initiation.initiatedBy ?? "Tyler Reese",
      metadata: {
        invoiceId,
        paymentId,
        amountCents: claimed.amountCents,
        reason: cleanReason,
        stripeReason: cleanStripeReason,
        stripeRefundId: refund.id,
        initiationId,
        serviceNotRenderedConfirmed: true,
      },
    });

    return {
      status: "succeeded" as const,
      initiationId,
      amountCents: claimed.amountCents,
      stripeRefundId: refund.id,
      stripeStatus: refund.status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe refund failed.";
    await db
      .update(refundInitiations)
      .set({ status: "failed", errorMessage: capReason(message), updatedAt: new Date().toISOString() })
      .where(eq(refundInitiations.id, initiationId));
    await logInitiationFailed(projectId, { paymentId, amountCents: claimed.amountCents, errorMessage: message, initiationId });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reconciliation tripwires (§4.4) — two money-critical failure modes:
//   (1) succeeded initiation OLDER than ~24h with NO matching payment_refunds row sharing its
//       stripe_refund_id  → "Initiated refund not yet recorded" (webhook never arrived, esp.
//       charge.refunded per M6).
//   (2) submitting initiation OLDER than ~1h → "Refund stuck in-flight — reconcile against
//       Stripe" (execute crashed between the claim and the terminal UPDATE; money may or may
//       not have moved, and the §3.1 Σ-cap pins that payment's maxRefundable at 0 until resolved).
// Resolution for (2) is human-in-the-loop reconcile-against-Stripe, NEVER a re-POST (M1).
// ---------------------------------------------------------------------------
export async function getRefundInitiationReconciliation(options?: {
  now?: Date;
  succeededThresholdMs?: number;
  submittingThresholdMs?: number;
}) {
  const now = options?.now ?? new Date();
  const succeededThresholdMs = options?.succeededThresholdMs ?? 24 * 60 * 60 * 1000;
  const submittingThresholdMs = options?.submittingThresholdMs ?? 60 * 60 * 1000;
  const nowMs = now.getTime();

  const succeeded = await db.query.refundInitiations.findMany({
    where: eq(refundInitiations.status, "succeeded"),
  });
  const submitting = await db.query.refundInitiations.findMany({
    where: eq(refundInitiations.status, "submitting"),
  });

  const succeededRefundIds = succeeded
    .map((row) => row.stripeRefundId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const recordedRows = succeededRefundIds.length
    ? await db.query.paymentRefunds.findMany({ where: inArray(paymentRefunds.stripeRefundId, succeededRefundIds) })
    : [];
  const recordedRefundIds = new Set(recordedRows.map((row) => row.stripeRefundId).filter(Boolean) as string[]);

  const ageMs = (iso: string | null) => (iso ? nowMs - new Date(iso).getTime() : Number.POSITIVE_INFINITY);

  const initiatedNotRecorded = succeeded.filter(
    (row) => ageMs(row.updatedAt) >= succeededThresholdMs && !(row.stripeRefundId && recordedRefundIds.has(row.stripeRefundId)),
  );
  const stuckSubmitting = submitting.filter((row) => ageMs(row.updatedAt) >= submittingThresholdMs);

  return {
    initiatedNotRecorded: initiatedNotRecorded.map((row) => ({
      initiationId: row.id,
      invoicePaymentId: row.invoicePaymentId,
      stripeRefundId: row.stripeRefundId,
      amountCents: row.amountCents,
      updatedAt: row.updatedAt,
      kind: "initiated_refund_not_yet_recorded" as const,
    })),
    stuckSubmitting: stuckSubmitting.map((row) => ({
      initiationId: row.id,
      invoicePaymentId: row.invoicePaymentId,
      amountCents: row.amountCents,
      updatedAt: row.updatedAt,
      kind: "refund_stuck_in_flight" as const,
    })),
    totalCount: initiatedNotRecorded.length + stuckSubmitting.length,
  };
}
