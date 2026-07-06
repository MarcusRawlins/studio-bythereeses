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
import { and, desc, eq, inArray } from "drizzle-orm";

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

// Exported (UI enable-prep, additive) so the admin refund control can pre-disable a retainer
// row without a divergent copy of the predicate (F2) — this IS the exact rule §3.4/execute
// enforces server-side; the UI use below never changes it, only reads it.
export function isRetainerPayment(payment: InvoicePaymentRow, allPayments: InvoicePaymentRow[]) {
  return isRetainerPaymentLabel(payment.label) || payment.id === earliestPaymentId(allPayments);
}

// UI-ONLY mirror (additive) of the §3.4 dispute-eligibility gate (P5/M5) so the admin control
// can pre-disable a disputed payment. Mirrors resolveEligiblePayment's own check exactly (never
// a divergent copy); this is a display hint only — the server re-checks at prepare/execute and
// remains authoritative. Does NOT change resolveEligiblePayment or any money-moving logic.
export function isDisputeBlockedForRefundUi(payment: Pick<InvoicePaymentRow, "disputeStatus">) {
  return payment.disputeStatus === "open" || payment.disputeStatus === "lost";
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
// Returns the SERVICE ceiling and the (UNCLAMPED) already-refunded total on the service basis.
// Exposing `alreadyRefundedServiceCents` unclamped lets the execute path re-check for a
// concurrent overshoot AFTER claiming its own row (two DISTINCT initiations racing — Fable
// code-review finding 2): once both rows are 'submitting' the sum can exceed the ceiling.
async function computeRefundExposure(payment: InvoicePaymentRow) {
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
  return { serviceCollectedCents, alreadyRefundedServiceCents };
}

async function computeMaxRefundableCents(payment: InvoicePaymentRow) {
  const { serviceCollectedCents, alreadyRefundedServiceCents } = await computeRefundExposure(payment);
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
}, actorName?: string) {
  try {
    await logActivity({
      projectId,
      action: "invoice.payment_refund_initiation_failed",
      actorType: "admin",
      actorName: actorName ?? "Tyler Reese",
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

  // Audit prepare-path rejections too (§3.7 / Fable finding 3) — a blocked retainer / ineligible
  // / zero-balance attempt is a security-relevant event, not a silent no-op.
  let payment;
  let paymentIntentId;
  try {
    ({ payment, paymentIntentId } = await resolveEligiblePayment(invoiceId, paymentId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Refund is not eligible.";
    await logInitiationFailed(null, { paymentId, amountCents: 0, errorMessage: message, initiationId: null }, actorName ?? undefined);
    throw error;
  }
  const maxRefundableCents = await computeMaxRefundableCents(payment);
  if (maxRefundableCents <= 0) {
    const message = "No refundable service balance remains on this payment.";
    await logInitiationFailed(null, { paymentId, amountCents: 0, errorMessage: message, initiationId: null }, actorName ?? undefined);
    throw new Error(message);
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

  // (8) CAS claim pending → submitting, PINNING the amount + a per-execute CLAIM TOKEN, in ONE
  //     UPDATE, BEFORE the network call (M3). The claim token is how we detect the CAS WINNER:
  //     a no-op UPDATE by a concurrent loser matches 0 rows and writes nothing, so a plain
  //     status re-read would see 'submitting' for BOTH racers (Fable code-review BLOCKER). Only
  //     the writer whose token survives the re-read may POST. No db.transaction (D1 rejects it).
  const claimToken = crypto.randomUUID();
  await db
    .update(refundInitiations)
    .set({
      status: "submitting",
      amountCents: amount,
      reason: cleanReason,
      serviceNotRenderedConfirmed: 1,
      stripeReason: cleanStripeReason,
      claimToken,
      updatedAt: now,
    })
    .where(and(eq(refundInitiations.id, initiationId), eq(refundInitiations.status, "pending")));

  const claimed = await db.query.refundInitiations.findFirst({
    where: eq(refundInitiations.id, initiationId),
  });
  if (!claimed || claimed.status !== "submitting" || claimed.claimToken !== claimToken) {
    // Lost the pending→submitting race to a concurrent execute (its token, not ours, is on the
    // row) — do NOT call Stripe. The winner is in flight; surface it for reconciliation.
    return {
      status: "submitting" as const,
      inProgress: true,
      needsReconciliation: true,
      initiationId,
      amountCents: claimed?.amountCents ?? amount,
    };
  }

  // (8b) Post-claim overshoot guard (Fable finding 2): two DISTINCT pending initiations on the
  //      same payment each pass the pre-claim cap (each excludes the other's still-`pending`
  //      row), then both claim — jointly exceeding the service ceiling. Re-read the ledger with
  //      OUR row now `submitting` and fail-closed if the committed total exceeds the ceiling.
  //      Revert our own row (token-guarded) and do NOT POST. Both racers reverting is safe
  //      over-block; the admin re-submits one.
  const freshPayment = await db.query.invoicePayments.findFirst({ where: eq(invoicePayments.id, paymentId) });
  if (freshPayment) {
    const { serviceCollectedCents, alreadyRefundedServiceCents } = await computeRefundExposure(freshPayment);
    if (alreadyRefundedServiceCents > serviceCollectedCents) {
      const message = "A concurrent refund on this payment would exceed the refundable service balance.";
      await db
        .update(refundInitiations)
        .set({ status: "failed", errorMessage: capReason(message), updatedAt: new Date().toISOString() })
        .where(and(
          eq(refundInitiations.id, initiationId),
          eq(refundInitiations.status, "submitting"),
          eq(refundInitiations.claimToken, claimToken),
        ));
      await logInitiationFailed(projectId, { paymentId, amountCents: claimed.amountCents, errorMessage: message, initiationId });
      throw new Error(message);
    }
  }

  // (9) The money-moving call. Sends claimed.amountCents + claimed.stripeReason (the ROW's
  //     persisted, pinned values — byte-identical to the row, the Σ-cap, and any retry).
  try {
    const refund = await createStripeRefund({
      paymentIntentId,
      amountCents: claimed.amountCents,
      // Re-normalize the persisted value (idempotent — the CAS stored a normalized reason);
      // coerces the nullable column type to the definite string the Stripe call requires.
      stripeReason: normalizedStripeReason(claimed.stripeReason),
      idempotencyKey: initiationId, // = the row id
      invoicePaymentId: paymentId,
      initiationId,
    });
    // Terminal UPDATE guarded by status+token: only the CAS winner can finalize, so a late
    // loser can never clobber a `succeeded` row (nor mask moved money with `failed`).
    await db
      .update(refundInitiations)
      .set({ status: "succeeded", stripeRefundId: refund.id, errorMessage: null, updatedAt: new Date().toISOString() })
      .where(and(
        eq(refundInitiations.id, initiationId),
        eq(refundInitiations.status, "submitting"),
        eq(refundInitiations.claimToken, claimToken),
      ));

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
        stripeReason: claimed.stripeReason,
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
      .where(and(
        eq(refundInitiations.id, initiationId),
        eq(refundInitiations.status, "submitting"),
        eq(refundInitiations.claimToken, claimToken),
      ));
    await logInitiationFailed(projectId, { paymentId, amountCents: claimed.amountCents, errorMessage: message, initiationId }, actorName ?? undefined);
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

// ---------------------------------------------------------------------------
// UI ENABLE-PREP (read-only, additive, NOT money-moving) — the pieces the deferred
// admin-UI + reconciliation-wiring tasks need. Neither function writes anything; both
// only join existing rows for display. They never touch payment_refunds/refunded_amount_cents
// and are never called from prepare/execute.
// ---------------------------------------------------------------------------

// Newest-first list of this payment's refund_initiations, for the admin UI to show under a
// payment ("Refund history for this payment") so a double-submit / prior failure is visually
// obvious (§5 task 1). Read-only; never used by the money path.
export async function listRefundInitiationsForPayment(invoicePaymentId: string) {
  const rows = await db.query.refundInitiations.findMany({
    where: eq(refundInitiations.invoicePaymentId, invoicePaymentId),
    orderBy: [desc(refundInitiations.createdAt)],
  });
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    amountCents: row.amountCents,
    stripeRefundId: row.stripeRefundId,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

// Enriches getRefundInitiationReconciliation's two tripwires with the invoice/payment context
// (invoice id/number, payment label, a direct link) needed to surface them as read-only rows in
// the /finance needs-reconciliation view and the agent finance report reconciliation block
// (§4.4). Always-on read (no flag); returns empty arrays when there are zero initiations, so it
// stays inert until a refund has actually been initiated.
export async function getRefundInitiationReconciliationWithContext(options?: {
  now?: Date;
  succeededThresholdMs?: number;
  submittingThresholdMs?: number;
}) {
  const recon = await getRefundInitiationReconciliation(options);
  const paymentIds = Array.from(
    new Set([
      ...recon.initiatedNotRecorded.map((row) => row.invoicePaymentId),
      ...recon.stuckSubmitting.map((row) => row.invoicePaymentId),
    ]),
  );
  if (!paymentIds.length) {
    return { ...recon, initiatedNotRecorded: [], stuckSubmitting: [] };
  }

  const payments = await db.query.invoicePayments.findMany({ where: inArray(invoicePayments.id, paymentIds) });
  const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
  const invoiceIds = Array.from(new Set(payments.map((payment) => payment.invoiceId)));
  const invoiceRows = invoiceIds.length
    ? await db.query.invoices.findMany({ where: inArray(invoices.id, invoiceIds) })
    : [];
  const invoiceById = new Map(invoiceRows.map((invoice) => [invoice.id, invoice]));

  function enrich<T extends { invoicePaymentId: string }>(row: T) {
    const payment = paymentById.get(row.invoicePaymentId);
    const invoice = payment ? invoiceById.get(payment.invoiceId) : undefined;
    return {
      ...row,
      paymentLabel: payment?.label ?? null,
      invoiceId: invoice?.id ?? null,
      invoiceNumber: invoice?.invoiceNumber ?? null,
      href: invoice ? `/invoices/${invoice.id}#payment-${row.invoicePaymentId}` : null,
    };
  }

  return {
    ...recon,
    initiatedNotRecorded: recon.initiatedNotRecorded.map(enrich),
    stuckSubmitting: recon.stuckSubmitting.map(enrich),
  };
}
