// Phase 9a — Refund / dispute / chargeback WEBHOOK recording.
//
// SCOPE BOUNDARY: this module moves ZERO money. Every function here reacts to an
// INBOUND, signature-verified Stripe webhook (Stripe is the source of truth for
// what already happened) and mirrors it into our ledger. NOTHING here calls a
// Stripe mutating endpoint (no POST /v1/refunds, charge, capture). That is Phase 9b.
//
// Idempotency is built on PER-OBJECT CONVERGENCE, never a transaction — D1 rejects
// db.transaction at runtime (Fable finding #1). Each write is safe to replay on its
// own: UNIQUE stripe id + set-to-authoritative (a set, not an increment). The
// event-id dedupe row is written LAST, after processing succeeds, so a mid-write
// throw leaves no dedupe row → Stripe retries → reprocessing converges to the same
// state. Even with the dedupe row absent, per-object convergence prevents double-count.

import { db } from "@/db/client";
import { invoicePayments, invoices, paymentDisputes, paymentRefunds, schedulerBookings, stripeWebhookEvents } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { financeRefundStatusFlipEnabled } from "@/lib/finance-flags";
import { reconciledInvoicePaymentStatus } from "@/lib/sales";
import { eq } from "drizzle-orm";

const MAX_ID_LEN = 255;
const MAX_REASON_LEN = 500;
// Orphaned rows (no linked payment) have no grossCollected to cap against — apply an
// absolute sanity ceiling instead ($1,000,000). An out-of-range orphan amount is
// stored clamped and flagged at read time, never trusted or dropped (Fable finding #9).
const ABSOLUTE_AMOUNT_CEILING_CENTS = 100_000_000;

const TERMINAL_REFUND_STATUSES = new Set(["succeeded", "failed", "canceled"]);
const TERMINAL_DISPUTE_STATUSES = new Set(["won", "lost"]);

// ---------------------------------------------------------------------------
// Untrusted-field helpers (every field hostile, even post-signature).
// ---------------------------------------------------------------------------

function stripeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stripeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function capId(value: unknown) {
  const text = stripeString(value);
  return text ? text.slice(0, MAX_ID_LEN) : null;
}

function capReason(value: unknown) {
  const text = stripeString(value);
  return text ? text.slice(0, MAX_REASON_LEN) : null;
}

// Non-negative integer cents, clamped to an absolute sanity ceiling. `cap` (when the
// row is linked to a known payment) is the linked payment's grossCollectedCents.
function clampAmountCents(value: unknown, cap = ABSOLUTE_AMOUNT_CEILING_CENTS) {
  const raw = stripeNumber(value);
  if (raw === null || raw < 0) return 0;
  return Math.min(Math.round(raw), Math.max(0, Math.min(cap, ABSOLUTE_AMOUNT_CEILING_CENTS)));
}

function eventObject(event: Record<string, unknown>) {
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const object = (data as Record<string, unknown>).object;
  return object && typeof object === "object" ? object as Record<string, unknown> : null;
}

// A Stripe id field can be a string ("pi_...") or an expanded object ({ id: "pi_..." }).
function idFromField(value: unknown) {
  if (typeof value === "string") return capId(value);
  if (value && typeof value === "object") return capId((value as Record<string, unknown>).id);
  return null;
}

function isoFromEpoch(value: unknown) {
  const seconds = stripeNumber(value);
  if (!seconds || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Link resolution (§1.4). Never UPDATE a canonical payment row from an unmatched
// inbound event — an orphan is recorded with a NULL link and surfaced, not dropped.
// ---------------------------------------------------------------------------

type ResolvedLink = {
  invoicePayment: typeof invoicePayments.$inferSelect | null;
  booking: typeof schedulerBookings.$inferSelect | null;
};

async function resolveLink(paymentIntentId: string | null): Promise<ResolvedLink> {
  if (!paymentIntentId) return { invoicePayment: null, booking: null };
  const invoicePayment = await db.query.invoicePayments.findFirst({
    where: eq(invoicePayments.externalPaymentId, paymentIntentId),
  });
  if (invoicePayment) return { invoicePayment, booking: null };
  const booking = await db.query.schedulerBookings.findFirst({
    where: eq(schedulerBookings.externalPaymentId, paymentIntentId),
  });
  return { invoicePayment: null, booking: booking ?? null };
}

async function projectIdForInvoicePayment(payment: typeof invoicePayments.$inferSelect) {
  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, payment.invoiceId) });
  return invoice?.projectId ?? null;
}

// ---------------------------------------------------------------------------
// Child refund upsert (shared by charge.refunded's embedded refunds and refund.*).
// Convergent: INSERT ON CONFLICT DO NOTHING, then a set-to-authoritative UPDATE that
// never overwrites a TERMINAL child status with a non-terminal/older snapshot (N1).
// ---------------------------------------------------------------------------

async function upsertRefundChild({
  refund,
  link,
  eventCreatedIso,
  now,
}: {
  refund: Record<string, unknown>;
  link: ResolvedLink;
  eventCreatedIso: string | null;
  now: string;
}) {
  const stripeRefundId = capId(refund.id);
  if (!stripeRefundId) return null; // a refund with no id is not recordable; skip (charge summary still set)

  // The child row preserves the TRUE Stripe refund amount (absolute sanity ceiling only),
  // NOT clamped to grossCollected. The trusted/capped figure lives in the summary
  // refunded_amount_cents (set on the payment); keeping the child un-capped is what lets
  // the read-time over-cap / divergence flag actually fire (§1.5 "still record but flag").
  const amountCents = clampAmountCents(refund.amount, ABSOLUTE_AMOUNT_CEILING_CENTS);
  const stripeCreatedAt = isoFromEpoch(refund.created) ?? eventCreatedIso;
  const values = {
    id: crypto.randomUUID(),
    stripeRefundId,
    stripeChargeId: idFromField(refund.charge),
    stripePaymentIntentId: idFromField(refund.payment_intent),
    invoicePaymentId: link.invoicePayment?.id ?? null,
    schedulerBookingId: link.booking?.id ?? null,
    amountCents,
    currency: capId(refund.currency) ?? "usd",
    reason: capReason(refund.reason),
    status: capId(refund.status),
    stripeCreatedAt,
    // created_at is the money-event date (Stripe event time; falls back to receive time).
    // Net-of-refunds figures period-scope on this (§2.2) — in prod receive≈event time.
    createdAt: stripeCreatedAt ?? now,
    updatedAt: now,
  };

  await db.insert(paymentRefunds).values(values).onConflictDoNothing({ target: paymentRefunds.stripeRefundId });

  const existing = await db.query.paymentRefunds.findFirst({ where: eq(paymentRefunds.stripeRefundId, stripeRefundId) });
  if (existing) {
    const existingTerminal = TERMINAL_REFUND_STATUSES.has(existing.status ?? "");
    const incomingTerminal = TERMINAL_REFUND_STATUSES.has(values.status ?? "");
    // Newer OR unknown ordering counts as "not older". A late non-terminal snapshot
    // must never demote a terminal one out of the net.
    const incomingNotOlder = !existing.stripeCreatedAt || !stripeCreatedAt || stripeCreatedAt >= existing.stripeCreatedAt;
    const allowStatusUpdate = incomingTerminal || (!existingTerminal && incomingNotOlder);
    await db.update(paymentRefunds).set({
      stripeChargeId: values.stripeChargeId ?? existing.stripeChargeId,
      stripePaymentIntentId: values.stripePaymentIntentId ?? existing.stripePaymentIntentId,
      invoicePaymentId: values.invoicePaymentId ?? existing.invoicePaymentId,
      schedulerBookingId: values.schedulerBookingId ?? existing.schedulerBookingId,
      amountCents: values.amountCents,
      currency: values.currency,
      reason: values.reason,
      status: allowStatusUpdate ? values.status : existing.status,
      stripeCreatedAt: incomingNotOlder ? stripeCreatedAt : existing.stripeCreatedAt,
      updatedAt: now,
    }).where(eq(paymentRefunds.stripeRefundId, stripeRefundId));
  }

  return { stripeRefundId, amountCents, status: values.status };
}

// ---------------------------------------------------------------------------
// charge.refunded — authoritative cumulative amount_refunded → summary column.
// ---------------------------------------------------------------------------

export async function recordStripeChargeRefunded(event: Record<string, unknown>) {
  const charge = eventObject(event);
  if (!charge) throw new Error("Stripe charge.refunded payload is missing.");
  const now = new Date().toISOString();
  const eventCreatedIso = isoFromEpoch(event.created);
  const eventId = capId(event.id);
  const paymentIntentId = idFromField(charge.payment_intent);
  const link = await resolveLink(paymentIntentId);

  // Record any embedded refund objects (Stripe includes charge.refunds.data[]). This
  // keeps the child ledger and the summary consistent (no false divergence flag).
  const refundsList = charge.refunds && typeof charge.refunds === "object"
    ? (charge.refunds as Record<string, unknown>).data
    : null;
  if (Array.isArray(refundsList)) {
    for (const item of refundsList) {
      if (item && typeof item === "object") {
        await upsertRefundChild({ refund: item as Record<string, unknown>, link, eventCreatedIso, now });
      }
    }
  }

  if (!link.invoicePayment) {
    // Booking-linked or orphan: no invoice_payments summary column to set (bookings are
    // NOT mutated from a webhook in 9a). The child rows above + net/reconciliation
    // surfacing carry it. Never silent-drop.
    return {
      recorded: true,
      kind: link.booking ? "charge_refunded_booking_linked" : "charge_refunded_orphan",
      eventId,
      paymentIntentId,
      bookingId: link.booking?.id ?? null,
    };
  }

  const payment = link.invoicePayment;
  const gross = Math.max(payment.grossCollectedCents, 0);
  const amountRefunded = clampAmountCents(charge.amount_refunded, gross);
  // Monotonic (N1): never DECREASE the stored cumulative value from a stale/reordered
  // delivery; then cap at gross. Set-to-authoritative (not +=) → replays converge.
  const nextRefunded = Math.min(Math.max(amountRefunded, payment.refundedAmountCents), gross);

  await db.update(invoicePayments).set({
    refundedAmountCents: nextRefunded,
    lastRefundAt: eventCreatedIso ?? now,
    updatedAt: now,
  }).where(eq(invoicePayments.id, payment.id));

  let flipped = false;
  // The status flip (and ONLY the flip) is gated by FINANCE_REFUND_RECORDING=enforce.
  // Guard with gross > 0 so a zero-gross paid row never flips on 0 >= 0.
  if (financeRefundStatusFlipEnabled() && gross > 0 && nextRefunded >= gross && payment.status !== "refunded") {
    // Flip invoice_payments ONLY (never scheduler_bookings). PRESERVE
    // paidAt/paidAmountCents/grossCollectedCents/netDepositCents — only status changes,
    // else P1 gross is deleted by the paidAt-scoped query and the dunning-stop breaks.
    await db.update(invoicePayments).set({
      status: "refunded",
      updatedAt: now,
    }).where(eq(invoicePayments.id, payment.id));
    flipped = true;
    await recomputeInvoiceAfterRefund(payment.invoiceId, eventCreatedIso ?? now, now);
  }

  const projectId = await projectIdForInvoicePayment(payment);
  await logActivity({
    projectId,
    action: "invoice.payment_refunded_from_stripe",
    actorType: "system",
    actorName: "Stripe",
    metadata: {
      invoiceId: payment.invoiceId,
      paymentId: payment.id,
      amountCents: nextRefunded,
      grossCollectedCents: gross,
      status: flipped ? "refunded" : payment.status,
      flipped,
      eventId,
    },
  });

  return { recorded: true, kind: "charge_refunded", paymentId: payment.id, refundedAmountCents: nextRefunded, flipped, eventId };
}

// Recompute the parent invoice system-from-webhook (actorType "system"). The refunded
// payment contributes 0 to amountPaidCents. A fully-refunded invoice must NOT resurrect
// into "sent"/dunning — its preserved grossCollected keeps the client-payable balance at
// 0 (invoiceClientPayableBalanceCents), so the dunning-stop still holds.
async function recomputeInvoiceAfterRefund(invoiceId: string, paidAtIso: string, now: string) {
  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, invoiceId) });
  if (!invoice) return;
  const payments = await db.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, invoiceId) });
  const paidTotal = payments.reduce((sum, row) => (row.status === "paid" ? sum + row.paidAmountCents : sum), 0);
  const nextStatus = reconciledInvoicePaymentStatus(invoice, paidTotal);
  await db.update(invoices).set({
    amountPaidCents: paidTotal,
    status: nextStatus,
    paidAt: nextStatus === "paid" ? (invoice.paidAt ?? paidAtIso) : null,
    updatedAt: now,
  }).where(eq(invoices.id, invoiceId));
}

// ---------------------------------------------------------------------------
// refund.created / refund.updated — a single refund object's lifecycle.
// ---------------------------------------------------------------------------

export async function recordStripeRefund(event: Record<string, unknown>) {
  const refund = eventObject(event);
  if (!refund) throw new Error("Stripe refund payload is missing.");
  const stripeRefundId = capId(refund.id);
  if (!stripeRefundId) throw new Error("Stripe refund id is required.");
  const now = new Date().toISOString();
  const eventCreatedIso = isoFromEpoch(event.created);
  const eventId = capId(event.id);
  const paymentIntentId = idFromField(refund.payment_intent);
  const link = await resolveLink(paymentIntentId);

  const child = await upsertRefundChild({ refund, link, eventCreatedIso, now });

  if (link.invoicePayment) {
    // last_refund_at is a cheap always-on freshness marker; the summary
    // refunded_amount_cents itself is driven by charge.refunded's cumulative value.
    await db.update(invoicePayments).set({
      lastRefundAt: eventCreatedIso ?? now,
      updatedAt: now,
    }).where(eq(invoicePayments.id, link.invoicePayment.id));
  }

  const projectId = link.invoicePayment ? await projectIdForInvoicePayment(link.invoicePayment) : null;
  await logActivity({
    projectId,
    action: "invoice.payment_refunded_from_stripe",
    actorType: "system",
    actorName: "Stripe",
    metadata: {
      invoiceId: link.invoicePayment?.invoiceId ?? null,
      paymentId: link.invoicePayment?.id ?? null,
      stripeRefundId,
      amountCents: child?.amountCents ?? 0,
      reason: capReason(refund.reason),
      status: child?.status ?? null,
      eventId,
    },
  });

  return {
    recorded: true,
    kind: link.invoicePayment ? "refund" : (link.booking ? "refund_booking_linked" : "refund_orphan"),
    stripeRefundId,
    paymentId: link.invoicePayment?.id ?? null,
    bookingId: link.booking?.id ?? null,
    amountCents: child?.amountCents ?? 0,
    eventId,
  };
}

// ---------------------------------------------------------------------------
// charge.dispute.* — dispute / chargeback lifecycle.
// ---------------------------------------------------------------------------

function disputeSummaryStatus(eventType: string, rawStatus: string | null): "open" | "won" | "lost" | "reinstated" | null {
  if (eventType === "charge.dispute.funds_reinstated") return "reinstated";
  if (eventType === "charge.dispute.created") return "open";
  if (rawStatus === "won") return "won";
  if (rawStatus === "lost") return "lost";
  if (rawStatus === "warning_closed" || rawStatus === "charge_refunded") return "won";
  if (eventType === "charge.dispute.closed") return "lost"; // closed without won → treat funds as lost
  return "open";
}

// Terminal precedence so a reordered `updated` (non-terminal) never demotes a
// resolved dispute back to "open" (N1).
const DISPUTE_SUMMARY_PRECEDENCE: Record<string, number> = { open: 0, lost: 1, won: 2, reinstated: 3 };

export async function recordStripeDispute(event: Record<string, unknown>, eventType: string) {
  const dispute = eventObject(event);
  if (!dispute) throw new Error("Stripe dispute payload is missing.");
  const stripeDisputeId = capId(dispute.id);
  if (!stripeDisputeId) throw new Error("Stripe dispute id is required.");
  const now = new Date().toISOString();
  const eventCreatedIso = isoFromEpoch(event.created);
  const eventId = capId(event.id);
  const paymentIntentId = idFromField(dispute.payment_intent);
  const link = await resolveLink(paymentIntentId);

  const gross = link.invoicePayment ? Math.max(link.invoicePayment.grossCollectedCents, 0) : ABSOLUTE_AMOUNT_CEILING_CENTS;
  const amountCents = clampAmountCents(dispute.amount, gross);
  const rawStatus = capId(dispute.status);
  const summaryStatus = disputeSummaryStatus(eventType, rawStatus);
  const isReinstated = eventType === "charge.dispute.funds_reinstated";
  const isClosed = eventType === "charge.dispute.closed" || isReinstated;
  const stripeCreatedAt = eventCreatedIso;

  const values = {
    id: crypto.randomUUID(),
    stripeDisputeId,
    stripeChargeId: idFromField(dispute.charge),
    stripePaymentIntentId: paymentIntentId,
    invoicePaymentId: link.invoicePayment?.id ?? null,
    schedulerBookingId: link.booking?.id ?? null,
    amountCents,
    currency: capId(dispute.currency) ?? "usd",
    reason: capReason(dispute.reason),
    status: rawStatus,
    fundsReinstated: isReinstated ? 1 : 0,
    openedAt: eventType === "charge.dispute.created" ? (eventCreatedIso ?? now) : null,
    closedAt: isClosed ? (eventCreatedIso ?? now) : null,
    stripeCreatedAt,
    // Money-event date (see payment_refunds) — net-of-disputes figures scope on this.
    createdAt: stripeCreatedAt ?? now,
    updatedAt: now,
  };

  await db.insert(paymentDisputes).values(values).onConflictDoNothing({ target: paymentDisputes.stripeDisputeId });

  const existing = await db.query.paymentDisputes.findFirst({ where: eq(paymentDisputes.stripeDisputeId, stripeDisputeId) });
  if (existing) {
    const existingTerminal = TERMINAL_DISPUTE_STATUSES.has(existing.status ?? "");
    const incomingTerminal = TERMINAL_DISPUTE_STATUSES.has(values.status ?? "");
    const incomingNotOlder = !existing.stripeCreatedAt || !stripeCreatedAt || stripeCreatedAt >= existing.stripeCreatedAt;
    const allowStatusUpdate = incomingTerminal || (!existingTerminal && incomingNotOlder);
    await db.update(paymentDisputes).set({
      stripeChargeId: values.stripeChargeId ?? existing.stripeChargeId,
      stripePaymentIntentId: values.stripePaymentIntentId ?? existing.stripePaymentIntentId,
      invoicePaymentId: values.invoicePaymentId ?? existing.invoicePaymentId,
      schedulerBookingId: values.schedulerBookingId ?? existing.schedulerBookingId,
      amountCents: values.amountCents,
      currency: values.currency,
      reason: values.reason,
      status: allowStatusUpdate ? values.status : existing.status,
      // funds_reinstated and closed_at are latched forward (never un-reinstate / re-open).
      fundsReinstated: existing.fundsReinstated || values.fundsReinstated,
      openedAt: existing.openedAt ?? values.openedAt,
      closedAt: existing.closedAt ?? values.closedAt,
      stripeCreatedAt: incomingNotOlder ? stripeCreatedAt : existing.stripeCreatedAt,
      updatedAt: now,
    }).where(eq(paymentDisputes.stripeDisputeId, stripeDisputeId));
  }

  if (link.invoicePayment && summaryStatus) {
    const currentSummary = link.invoicePayment.disputeStatus;
    const currentRank = currentSummary ? (DISPUTE_SUMMARY_PRECEDENCE[currentSummary] ?? -1) : -1;
    const nextRank = DISPUTE_SUMMARY_PRECEDENCE[summaryStatus] ?? -1;
    // Never demote a resolved dispute summary back to "open" from a reordered event.
    const nextSummary = nextRank >= currentRank ? summaryStatus : currentSummary;
    await db.update(invoicePayments).set({
      disputeStatus: nextSummary,
      disputedAmountCents: Math.max(amountCents, link.invoicePayment.disputedAmountCents),
      updatedAt: now,
    }).where(eq(invoicePayments.id, link.invoicePayment.id));
    // NOTE: a dispute NEVER flips payment.status (only a full refund does). Funds are at
    // risk / lost, but the original collection stays recorded; net math handles the effect.
  }

  const action = isReinstated
    ? "invoice.payment_dispute_funds_reinstated_from_stripe"
    : isClosed
      ? "invoice.payment_dispute_closed_from_stripe"
      : "invoice.payment_dispute_opened_from_stripe";
  const projectId = link.invoicePayment ? await projectIdForInvoicePayment(link.invoicePayment) : null;
  await logActivity({
    projectId,
    action,
    actorType: "system",
    actorName: "Stripe",
    metadata: {
      invoiceId: link.invoicePayment?.invoiceId ?? null,
      paymentId: link.invoicePayment?.id ?? null,
      stripeDisputeId,
      amountCents,
      reason: capReason(dispute.reason),
      status: rawStatus,
      eventId,
    },
  });

  return {
    recorded: true,
    kind: link.invoicePayment ? "dispute" : (link.booking ? "dispute_booking_linked" : "dispute_orphan"),
    stripeDisputeId,
    paymentId: link.invoicePayment?.id ?? null,
    bookingId: link.booking?.id ?? null,
    summaryStatus,
    eventId,
  };
}

// ---------------------------------------------------------------------------
// Dispatch + event-id dedupe (written LAST). Delegated to by
// handleStripeCheckoutWebhook AFTER its checkout branch. Signature is already
// verified upstream; this never re-verifies or bypasses it.
// ---------------------------------------------------------------------------

const REFUND_DISPUTE_EVENT_TYPES = new Set([
  "charge.refunded",
  "refund.created",
  "refund.updated",
]);

function isRefundOrDisputeEvent(eventType: string) {
  return REFUND_DISPUTE_EVENT_TYPES.has(eventType) || eventType.startsWith("charge.dispute.");
}

export async function dispatchStripeRefundOrDisputeEvent(event: Record<string, unknown>, eventType: string) {
  if (!isRefundOrDisputeEvent(eventType)) {
    return { ignored: true, reason: "unsupported_event", eventType };
  }

  // Validate event.id FIRST; a missing/blank id is rejected (throw → non-2xx so Stripe
  // retries — never silent-drop).
  const eventId = capId(event.id);
  if (!eventId) throw new Error("Stripe event id is required.");

  // Fast-path skip: a redelivered event we already fully processed.
  const seen = await db.query.stripeWebhookEvents.findFirst({ where: eq(stripeWebhookEvents.eventId, eventId) });
  if (seen) return { ignored: true, reason: "duplicate_event", eventId };

  // Process through convergent per-object writes. If this throws, no dedupe row is
  // written below → Stripe retries → reprocessing is safe (every write is convergent).
  let result: Record<string, unknown>;
  if (eventType === "charge.refunded") {
    result = await recordStripeChargeRefunded(event);
  } else if (eventType === "refund.created" || eventType === "refund.updated") {
    result = await recordStripeRefund(event);
  } else {
    result = await recordStripeDispute(event, eventType);
  }

  // Dedupe row written LAST, ON CONFLICT DO NOTHING (belt-and-suspenders — per-object
  // convergence is the primary safety, not this row).
  const auditResult = JSON.stringify(result).slice(0, MAX_REASON_LEN);
  await db.insert(stripeWebhookEvents).values({
    eventId,
    eventType,
    createdAt: new Date().toISOString(),
    stripeCreatedAt: isoFromEpoch(event.created),
    result: auditResult,
  }).onConflictDoNothing({ target: stripeWebhookEvents.eventId });

  return result;
}
