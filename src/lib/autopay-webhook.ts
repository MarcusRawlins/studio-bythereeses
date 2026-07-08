// Phase 13 — autopay WEBHOOK recording (§6.5). The signature-verified route
// (handleStripeCheckoutWebhook) dispatches the 4 autopay event types here. These handlers key ONLY on
// server-derived rows: setup_intent.* by the consent row (metadata.consent_id), payment_intent.* by
// metadata.autopay_charge_id. Untrusted input NEVER picks which installment to charge/record (I5).
//
// The PI-succeeded recorder is a SIBLING of settleInvoicePaymentCheckoutSession that reuses the SAME
// convergence (set-to-paid → reconciledInvoicePaymentStatus → autoAdvanceProjectStageForRetainerPayment)
// and the SAME card-fee math — it invents NO new money arithmetic (I7). Every row transition is a
// single-statement CAS (D1 has no transactions). The autopay_charges ROW is canonical for the split;
// PI metadata is a cross-check only (R-9).

import { db } from "@/db/client";
import { autopayCharges, autopayConsents, clients, invoicePayments, invoices, projectParticipants, projects } from "@/db/schema";
import { logActivity } from "@/lib/activity";
// MEDIUM-4: the §6.6 fallback side effects (cancel residual PI + mint manual link + notify) are shared
// with the sync engine path. Imported lazily-safe (used only inside a handler body) so the
// autopay-charge ↔ autopay-webhook cycle never touches either module's top-level evaluation.
import { runManualFallbackSideEffects } from "@/lib/autopay-charge";
import { autopayEnabled } from "@/lib/autopay-flags";
import { sendAutopayReceipt } from "@/lib/autopay-emails";
import { calculatedCardFeeAmountCents, invoiceClientPayableBalanceCents } from "@/lib/invoice-balances";
import { autoAdvanceProjectStageForRetainerPayment, reconciledInvoicePaymentStatus } from "@/lib/sales";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";

type AutopayChargeRow = typeof autopayCharges.$inferSelect;

const MAX_ERROR_LEN = 500;
// decline_codes that are pointless to retry — a dead card. These short-circuit to failed_terminal.
export const HARD_DECLINE_CODES = new Set([
  "stolen_card",
  "lost_card",
  "pickup_card",
  "fraudulent",
  "revocation_of_authorization",
  "revocation_of_all_authorizations",
  "do_not_honor",
]);

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function capError(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, MAX_ERROR_LEN) : null;
}
function eventObject(event: Record<string, unknown>): Record<string, unknown> {
  return obj(obj(event.data).object);
}

async function primaryClientForProject(projectId: string) {
  const rows = await db
    .select({ client: clients })
    .from(projectParticipants)
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(projectParticipants.projectId, projectId))
    .orderBy(desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt))
    .limit(1);
  return rows[0]?.client ?? null;
}

// ---------------------------------------------------------------------------
// setup_intent.succeeded → activate the consent (§4.1 step 4, M6). TWO single-statement CAS writes,
// IN ORDER: (1) supersede any prior active row (a card update revokes the old card-on-file), then
// (2) activate this pending row. A crash BETWEEN them leaves ZERO active consents (the fail-safe
// direction) — never a double-active or an index-violation loop.
// ---------------------------------------------------------------------------
export async function recordAutopaySetupIntentSucceeded(event: Record<string, unknown>) {
  const si = eventObject(event);
  const setupIntentId = str(si.id);
  const metadata = obj(si.metadata);
  const consentId = str(metadata.consent_id);

  const consent = consentId
    ? await db.query.autopayConsents.findFirst({ where: eq(autopayConsents.id, consentId) })
    : setupIntentId
      ? await db.query.autopayConsents.findFirst({ where: eq(autopayConsents.setupIntentId, setupIntentId) })
      : null;
  if (!consent) return { ignored: true as const, reason: "consent_not_found" };

  // Extract pm + display-only card fields (I4) — never a PAN/CVC.
  const pmRaw = si.payment_method;
  const pmId = typeof pmRaw === "string" ? pmRaw : str(obj(pmRaw).id);
  const card = typeof pmRaw === "object" ? obj(obj(pmRaw).card) : {};
  const cardBrand = str(card.brand) || null;
  const cardLast4 = str(card.last4) || null;
  const cardExpMonth = num(card.exp_month);
  const cardExpYear = num(card.exp_year);
  const now = new Date().toISOString();

  // (1) Supersede any prior active row for THIS consent's project (project derived server-side, I5).
  await db
    .update(autopayConsents)
    .set({ status: "revoked", revokedAt: now, updatedAt: now })
    .where(and(eq(autopayConsents.projectId, consent.projectId), eq(autopayConsents.status, "active"), ne(autopayConsents.id, consent.id)));

  // (2) Activate this pending row.
  const activated = await db
    .update(autopayConsents)
    .set({
      status: "active",
      stripePaymentMethodId: pmId || consent.stripePaymentMethodId,
      cardBrand,
      cardLast4,
      cardExpMonth,
      cardExpYear,
      setupIntentId: setupIntentId || consent.setupIntentId,
      consentedAt: now,
      updatedAt: now,
    })
    .where(and(eq(autopayConsents.id, consent.id), eq(autopayConsents.status, "pending")))
    .returning({ id: autopayConsents.id });

  if (activated.length) {
    await logActivity({
      projectId: consent.projectId,
      clientId: consent.clientId,
      action: "autopay.consent_granted",
      actorType: "system",
      actorName: "Autopay",
      metadata: { consentId: consent.id, consentVersion: consent.consentVersion, cardBrand, cardLast4 },
    });
  }
  return { ignored: false as const, consentId: consent.id, activated: activated.length > 0 };
}

// setup_intent.setup_failed → consent 'failed' (the client can retry).
export async function recordAutopaySetupIntentFailed(event: Record<string, unknown>) {
  const si = eventObject(event);
  const setupIntentId = str(si.id);
  const consentId = str(obj(si.metadata).consent_id);
  const consent = consentId
    ? await db.query.autopayConsents.findFirst({ where: eq(autopayConsents.id, consentId) })
    : setupIntentId
      ? await db.query.autopayConsents.findFirst({ where: eq(autopayConsents.setupIntentId, setupIntentId) })
      : null;
  if (!consent) return { ignored: true as const, reason: "consent_not_found" };
  const now = new Date().toISOString();
  await db
    .update(autopayConsents)
    .set({ status: "failed", updatedAt: now })
    .where(and(eq(autopayConsents.id, consent.id), eq(autopayConsents.status, "pending")));
  await logActivity({
    projectId: consent.projectId,
    clientId: consent.clientId,
    action: "autopay.consent_setup_failed",
    actorType: "system",
    actorName: "Autopay",
    metadata: { consentId: consent.id, setupIntentId },
  });
  return { ignored: false as const, consentId: consent.id };
}

// ---------------------------------------------------------------------------
// The §6.5 RECORD portion — set the installment paid + recompute + stage, reusing the settle
// convergence with the PINNED split (never re-derived, MAJOR-2). Exported so the engine's R-5
// cancel-rejected-because-succeeded path drives the exact same recorder. Idempotent: an already-paid
// installment short-circuits (same-pi replay = no-op; a DIFFERENT pi = money moved twice → CRITICAL).
// ---------------------------------------------------------------------------
export async function recordAutopayInstallmentPaid(
  charge: AutopayChargeRow,
  pi: { id: string; metadata?: Record<string, unknown> },
  eventCreatedSeconds?: number | null,
) {
  const now = new Date().toISOString();
  const payment = await db.query.invoicePayments.findFirst({ where: eq(invoicePayments.id, charge.invoicePaymentId) });
  if (!payment) return { ignored: true as const, reason: "payment_missing" };
  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, payment.invoiceId) });
  if (!invoice) return { ignored: true as const, reason: "invoice_missing" };

  // Already-settled branch — distinguish a same-pi REPLAY (true no-op) from a DIFFERENT pi on an
  // already-paid installment (money moved twice → CRITICAL + Phase 9b refund candidate, BLOCKER-1).
  if (payment.status === "paid" || payment.status === "refunded") {
    if (payment.externalPaymentId && pi.id && payment.externalPaymentId !== pi.id) {
      await db
        .update(autopayCharges)
        .set({ refundCandidatePi: pi.id, lastError: capError("Different PI recorded on an already-paid installment"), updatedAt: now })
        .where(eq(autopayCharges.id, charge.id));
      await logActivity({
        projectId: charge.projectId,
        action: "autopay.double_charge_detected",
        actorType: "system",
        actorName: "Autopay",
        metadata: { chargeId: charge.id, paymentId: payment.id, recordedPi: payment.externalPaymentId, incomingPi: pi.id },
      });
      return { ignored: false as const, doubleCharge: true as const, reason: "different_pi_already_paid" };
    }
    return { ignored: true as const, reason: "already_settled" };
  }

  // Final DB backstop (I3 layer 4): a pi may record against at most one installment.
  if (pi.id) {
    const existing = await db.query.invoicePayments.findFirst({ where: eq(invoicePayments.externalPaymentId, pi.id) });
    if (existing && existing.id !== payment.id) {
      throw new Error("Stripe payment intent is already linked to another invoice payment.");
    }
  }

  // Pinned split (R-9): the ROW is canonical. If the PI metadata mirror disagrees (should be
  // impossible — same claiming statement wrote both), record from the ROW and WARN.
  const serviceOpenCents = charge.serviceAmountCents;
  const clientFeeCents = charge.clientFeeCents;
  const amountTotalCents = charge.amountCents;
  const metaService = num(obj(pi.metadata).service_amount_cents);
  const metaFee = num(obj(pi.metadata).client_fee_cents);
  if ((metaService !== null && metaService !== serviceOpenCents) || (metaFee !== null && metaFee !== clientFeeCents)) {
    await logActivity({
      projectId: charge.projectId,
      action: "autopay.split_mirror_mismatch",
      actorType: "system",
      actorName: "Autopay",
      metadata: { chargeId: charge.id, rowService: serviceOpenCents, rowFee: clientFeeCents, metaService, metaFee },
    });
  }

  const processingFeeCents = clientFeeCents > 0
    ? clientFeeCents
    : calculatedCardFeeAmountCents(serviceOpenCents, invoice.cardFeePercentBps, invoice.cardFeeFixedCents);
  const paidAt = eventCreatedSeconds ? new Date(eventCreatedSeconds * 1000).toISOString() : now;
  const netDepositCents = Math.max(amountTotalCents - processingFeeCents, 0);

  // Guard the transition with ne(status,'paid') AND capture the rowcount (MINOR-1): under two
  // CONCURRENT duplicate success webhooks both may pass the already-settled read above, but only ONE
  // performs this UPDATE — the loser matches 0 rows. The receipt (below) is sent ONLY when THIS call
  // performed the transition, so a duplicate can never double-email a receipt.
  const paidApplied = await db
    .update(invoicePayments)
    .set({
      status: "paid",
      paidAt,
      paymentMethod: "stripe",
      paidAmountCents: serviceOpenCents,
      clientFeeCents,
      processingFeeCents,
      grossCollectedCents: amountTotalCents,
      netDepositCents,
      externalPaymentId: pi.id,
      stripeCheckoutStatus: "paid",
      notes: payment.notes ?? "Recorded automatically from autopay.",
      updatedAt: now,
    })
    .where(and(eq(invoicePayments.id, payment.id), ne(invoicePayments.status, "paid")))
    .returning({ id: invoicePayments.id });

  const payments = await db.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, invoice.id) });
  const paidTotal = payments.reduce((sum, row) => {
    if (row.id === payment.id) return sum + serviceOpenCents;
    return row.status === "paid" ? sum + row.paidAmountCents : sum;
  }, 0);
  const nextStatus = reconciledInvoicePaymentStatus(invoice, paidTotal);
  await db
    .update(invoices)
    .set({ amountPaidCents: paidTotal, status: nextStatus, paidAt: nextStatus === "paid" ? paidAt : null, updatedAt: now })
    .where(eq(invoices.id, invoice.id));

  await db
    .update(autopayCharges)
    .set({ reconciledAt: now, updatedAt: now })
    .where(eq(autopayCharges.id, charge.id));

  await logActivity({
    projectId: charge.projectId,
    action: "invoice.payment_recorded_from_autopay",
    actorType: "system",
    actorName: "Autopay",
    metadata: {
      invoiceId: invoice.id,
      paymentId: payment.id,
      chargeId: charge.id,
      paymentIntentId: pi.id,
      paidAmountCents: serviceOpenCents,
      clientFeeCents,
      processingFeeCents,
      grossCollectedCents: amountTotalCents,
      netDepositCents,
    },
  });

  await autoAdvanceProjectStageForRetainerPayment({
    projectId: charge.projectId,
    invoiceId: invoice.id,
    paymentId: payment.id,
    paymentLabel: payment.label,
    status: "paid",
    paidAmountCents: serviceOpenCents,
    actorType: "system",
    actorName: "Autopay",
    metadata: { paymentIntentId: pi.id, chargeId: charge.id },
  });

  // Receipt — sent exactly once, ONLY when THIS call performed the paid transition (MINOR-1). A
  // concurrent duplicate that lost the CAS above (paidApplied.length === 0) records nothing new and
  // must NOT re-email. The gate (EMAIL_SENDING_ENABLED ∧ AUTOPAY_ENABLED ∧ live ∧ !suppressed) is
  // additionally enforced inside the helper.
  if (paidApplied.length) {
    const [client, project, freshPayments, consent] = await Promise.all([
      primaryClientForProject(charge.projectId),
      db.query.projects.findFirst({ where: eq(projects.id, charge.projectId) }),
      db.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, invoice.id) }),
      db.query.autopayConsents.findFirst({ where: eq(autopayConsents.id, charge.consentId) }),
    ]);
    const balanceRemainingCents = invoiceClientPayableBalanceCents(
      { ...invoice, amountPaidCents: paidTotal },
      freshPayments,
    );
    await sendAutopayReceipt({
      toEmail: client?.email ?? null,
      projectName: project?.name ?? "your project",
      installmentLabel: payment.label,
      amountCents: amountTotalCents,
      chargedOnDate: paidAt.slice(0, 10),
      cardBrand: consent?.cardBrand ?? null,
      cardLast4: consent?.cardLast4 ?? null,
      balanceRemainingCents,
    });
  }

  return {
    ignored: false as const,
    paymentId: payment.id,
    invoiceId: invoice.id,
    paidAmountCents: serviceOpenCents,
    clientFeeCents,
    processingFeeCents,
    grossCollectedCents: amountTotalCents,
  };
}

// ---------------------------------------------------------------------------
// payment_intent.succeeded → converge the row to 'charged' (convergent-idempotent CAS) then record.
// A non-autopay PI (no metadata.autopay_charge_id) is IGNORED — neither a stripe-webhook failure nor
// an autopay success (test 33). Exported for the engine's R-5 converge-from-charging path.
// ---------------------------------------------------------------------------
export async function recordAutopayPaymentIntentSucceeded(event: Record<string, unknown>) {
  const pi = eventObject(event);
  const created = num(event.created);
  return convergeAutopayChargeSuccess(pi, created);
}

export async function convergeAutopayChargeSuccess(
  pi: Record<string, unknown>,
  eventCreatedSeconds?: number | null,
) {
  const metadata = obj(pi.metadata);
  const chargeId = str(metadata.autopay_charge_id);
  if (!chargeId) return { ignored: true as const, reason: "not_autopay" };
  const piId = str(pi.id);
  const charge = await db.query.autopayCharges.findFirst({ where: eq(autopayCharges.id, chargeId) });
  if (!charge) return { ignored: true as const, reason: "charge_not_found" };
  if (charge.dryRun === 1) return { ignored: true as const, reason: "dry_run" };

  const now = new Date().toISOString();
  // Success convergent-idempotent CAS (§6.5): charging|charged → charged (a replay / out-of-order
  // arrival converges rather than throws). Persist the pi id if not already stored.
  await db
    .update(autopayCharges)
    .set({
      status: "charged",
      stripeStatus: "succeeded",
      stripePaymentIntentId: charge.stripePaymentIntentId ?? (piId || null),
      chargedAt: charge.chargedAt ?? now,
      updatedAt: now,
    })
    .where(and(eq(autopayCharges.id, chargeId), inArray(autopayCharges.status, ["charging", "charged"])));

  const fresh = (await db.query.autopayCharges.findFirst({ where: eq(autopayCharges.id, chargeId) })) ?? charge;
  return recordAutopayInstallmentPaid(fresh, { id: piId || charge.stripePaymentIntentId || "", metadata }, eventCreatedSeconds);
}

// ---------------------------------------------------------------------------
// payment_intent.payment_failed → a token/PI-guarded single-statement CAS (MAJOR-3) so a stale,
// out-of-order failure can never regress a SUPERSEDED attempt. The guard pins BOTH status='charging'
// AND the specific stripe_payment_intent_id: a late payment_failed for a superseded PI matches 0 rows
// → a no-op (test 36). The synchronous engine path (§6.6) owns the manual-link fallback; this webhook
// is the out-of-order-safe convergence.
// ---------------------------------------------------------------------------
export async function recordAutopayPaymentIntentFailed(event: Record<string, unknown>) {
  const pi = eventObject(event);
  const chargeId = str(obj(pi.metadata).autopay_charge_id);
  if (!chargeId) return { ignored: true as const, reason: "not_autopay" };
  const piId = str(pi.id);
  const charge = await db.query.autopayCharges.findFirst({ where: eq(autopayCharges.id, chargeId) });
  if (!charge) return { ignored: true as const, reason: "charge_not_found" };

  const lastError = obj(pi.last_payment_error);
  const code = str(lastError.code) || null;
  const declineCode = str(lastError.decline_code) || null;
  const message = str(lastError.message) || null;

  let nextStatus: "needs_action" | "failed_retryable" | "failed_terminal";
  if (code === "authentication_required") {
    nextStatus = "needs_action";
  } else if ((declineCode && HARD_DECLINE_CODES.has(declineCode)) || charge.attemptCount >= charge.maxAttempts) {
    nextStatus = "failed_terminal";
  } else {
    nextStatus = "failed_retryable";
  }

  const now = new Date().toISOString();
  const nextAttemptAt = nextStatus === "failed_retryable" ? backoffFrom(charge.attemptCount, now) : null;
  const updated = await db
    .update(autopayCharges)
    .set({
      status: nextStatus,
      declineCode: declineCode ?? code,
      lastError: capError(message ?? code),
      stripeStatus: str(pi.status) || "requires_payment_method",
      nextAttemptAt,
      updatedAt: now,
    })
    .where(and(eq(autopayCharges.id, chargeId), eq(autopayCharges.status, "charging"), eq(autopayCharges.stripePaymentIntentId, piId)))
    .returning({ id: autopayCharges.id });

  if (updated.length) {
    await logActivity({
      projectId: charge.projectId,
      action: "autopay.charge_failed",
      actorType: "system",
      actorName: "Autopay",
      metadata: { chargeId, status: nextStatus, declineCode: declineCode ?? code, paymentIntentId: piId },
    });
    // MEDIUM-4: a webhook-driven failure to needs_action/failed_terminal must run the SAME §6.6 fallback
    // the sync path runs — cancel the residual PI (R-5 guarded), mint the manual link, notify — else a
    // webhook-only failure (sync POST was ambiguous, the webhook resolves it) leaves the installment
    // with no manual collection path. CAS-first ordering preserved: the transition above already won.
    if (nextStatus === "needs_action" || nextStatus === "failed_terminal") {
      const payment = await db.query.invoicePayments.findFirst({ where: eq(invoicePayments.id, charge.invoicePaymentId) });
      if (payment) {
        const freshCharge = (await db.query.autopayCharges.findFirst({ where: eq(autopayCharges.id, chargeId) })) ?? charge;
        await runManualFallbackSideEffects(freshCharge, payment, nextStatus, { declineCode: declineCode ?? code, message });
      }
    }
  }
  return { ignored: false as const, status: nextStatus, applied: updated.length > 0 };
}

// Backoff schedule (§6.6): +1d, +3d, +5d by attempt count (post-increment 1,2,3).
export function backoffFrom(attemptCount: number, nowIso: string): string {
  const days = [1, 3, 5][Math.min(Math.max(attemptCount - 1, 0), 2)] ?? 5;
  return new Date(new Date(nowIso).getTime() + days * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Dispatch — OWNS the 4 autopay event types (returns a result, possibly ignored) so a non-autopay PI
// never falls through to the refund dispatcher and throws (test 33). Returns null ONLY for event types
// this module does not own, so the caller falls back to the refund/dispute dispatcher. Flag off ⇒ a
// no-op that reads NO autopay schema (I1).
// ---------------------------------------------------------------------------
export async function dispatchAutopayWebhookEvent(
  event: Record<string, unknown>,
  eventType: string,
): Promise<Record<string, unknown> | null> {
  if (
    eventType !== "setup_intent.succeeded"
    && eventType !== "setup_intent.setup_failed"
    && eventType !== "payment_intent.succeeded"
    && eventType !== "payment_intent.payment_failed"
  ) {
    return null;
  }
  if (!autopayEnabled()) return { ignored: true, reason: "autopay_flag_off" };
  if (eventType === "setup_intent.succeeded") return recordAutopaySetupIntentSucceeded(event);
  if (eventType === "setup_intent.setup_failed") return recordAutopaySetupIntentFailed(event);
  if (eventType === "payment_intent.succeeded") return recordAutopayPaymentIntentSucceeded(event);
  return recordAutopayPaymentIntentFailed(event);
}
