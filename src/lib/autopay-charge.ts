// Phase 13 — the autopay charge engine + the exactly-once CAS state machine (§6, the hardest part).
// Modeled VERBATIM on stripe-refund-initiation.ts (CAS claim token, pinned amount + idempotency key
// set BEFORE the network call, terminal-unknown on ambiguity, reconcile tripwire) + the sequences.ts
// claim-first ledger. D1 has NO transactions — every money transition is a single-statement CAS.
//
// Exactly-once (I3), four layers, no transaction:
//   1. partial UNIQUE(invoice_payment_id) WHERE dry_run=0  — one REAL charge row per installment ever
//   2. single-statement Layer-2 CAS claim with a per-attempt claim token
//   3. a Stripe idempotency key materialized IN the claiming UPDATE, pinned before the POST
//   4. UNIQUE(external_payment_id) — the final double-record backstop
// An ambiguous in-flight charge is TERMINAL-UNKNOWN and is NEVER blind-retried (§6.4).

import { db } from "@/db/client";
import { autopayCharges, autopayConsents, clients, invoicePayments, invoices, projectParticipants, projects } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { AUTOPAY_CONSENT_VERSION, autopayConsentTextHash } from "@/lib/autopay-consent";
import { sendAutopayUpcomingNotice } from "@/lib/autopay-emails";
import {
  autopayBatchMax,
  autopayChargeMode,
  autopayEnabled,
  autopayMaxAttempts,
  autopayMaxChargeCents,
  autopayNoticeLeadDays,
  autopayPilotAllowlist,
} from "@/lib/autopay-flags";
import { HARD_DECLINE_CODES, backoffFrom, recordAutopayInstallmentPaid } from "@/lib/autopay-webhook";
import { invoicePaymentClientPayableOpenCents, invoicePaymentOpenCents } from "@/lib/invoice-balances";
import {
  cancelStripePaymentIntent,
  createAutopaySetupCheckoutSession,
  createOffSessionPaymentIntent,
  createStripeCustomer,
  detachStripePaymentMethod,
  getStripePaymentIntent,
} from "@/lib/stripe-autopay";
import {
  createInvoicePaymentCheckoutSession,
  expireStripeCheckoutSessionById,
  fetchStripeCheckoutSessionForSettle,
  fetchStripeCheckoutSessionReturnUrls,
  settleInvoicePaymentCheckoutSession,
} from "@/lib/stripe-checkout";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

const COLLECTIBLE_INVOICE_STATUSES = ["sent", "partially_paid", "overdue"] as const;
const MAX_ERROR_LEN = 500;

type ConsentRow = typeof autopayConsents.$inferSelect;
type ChargeRow = typeof autopayCharges.$inferSelect;
type PaymentRow = typeof invoicePayments.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;

export type AutopayRunSummary = {
  selected: number;
  wouldCharge: number;
  charged: number;
  // A sync POST that returned "succeeded" leaves the row 'charging' (the webhook is authoritative for
  // recording, §6.1) — count it here, NOT under `charged`, so `charged` means "row provably charged"
  // (MINOR-5). The R-5 converge (a cancel-rejected-because-succeeded) DOES record and increments `charged`.
  confirmedPendingWebhook: number;
  declined: number;
  needsAction: number;
  failedTerminal: number;
  aborted: number;
  skippedCapped: number;
  ambiguous: number;
  deferred: number;
  noticesSent: number;
  lost: number;
};

function newSummary(): AutopayRunSummary {
  return {
    selected: 0, wouldCharge: 0, charged: 0, confirmedPendingWebhook: 0, declined: 0, needsAction: 0,
    failedTerminal: 0, aborted: 0, skippedCapped: 0, ambiguous: 0, deferred: 0, noticesSent: 0, lost: 0,
  };
}

function capError(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, MAX_ERROR_LEN) : null;
}

function appBaseUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SCHEDULE_URL || "http://localhost:3000").replace(/\/$/, "");
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
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

// The client-payable open amount (service + passed-through card fee) for an installment — the SAME
// basis the manual checkout uses (stripe-checkout.ts:341-345). No new amount math (I7).
function computePayable(invoice: InvoiceRow, payment: PaymentRow, allPayments: PaymentRow[]) {
  const paidClientFeeCents = allPayments.reduce((sum, p) => (p.status === "paid" ? sum + p.clientFeeCents : sum), 0);
  const remainingClientFeeCents = Math.max(invoice.cardFeeAmountCents - paidClientFeeCents, 0);
  const openServiceTotalCents = allPayments.reduce((sum, p) => sum + invoicePaymentOpenCents(p), 0);
  const serviceOpenCents = invoicePaymentOpenCents(payment);
  const clientPayableOpenCents = invoicePaymentClientPayableOpenCents({ payment, openServiceTotalCents, remainingClientFeeCents });
  return { clientPayableOpenCents, serviceOpenCents };
}

// ---------------------------------------------------------------------------
// §5.1 selection — every condition AND-ed, derived SERVER-SIDE from consented rows.
// ---------------------------------------------------------------------------
type Candidate = {
  payment: PaymentRow;
  invoice: InvoiceRow;
  consent: ConsentRow;
  clientPayableOpenCents: number;
  serviceOpenCents: number;
};

async function selectQualifyingInstallments(now: Date, batchMax: number): Promise<Candidate[]> {
  const nowKey = dateKey(now);
  const allowlist = autopayPilotAllowlist();

  // Rule 5: active consent, current version, non-null pm. Rule 8: pilot allowlist.
  const consents = await db.query.autopayConsents.findMany({
    where: and(eq(autopayConsents.status, "active"), eq(autopayConsents.consentVersion, AUTOPAY_CONSENT_VERSION)),
  });
  const consentByProject = new Map<string, ConsentRow>();
  for (const consent of consents) {
    if (!consent.stripePaymentMethodId) continue;
    if (allowlist && !allowlist.has(consent.projectId)) continue;
    consentByProject.set(consent.projectId, consent);
  }
  if (consentByProject.size === 0) return [];

  const candidates: Candidate[] = [];
  for (const [projectId, consent] of consentByProject) {
    // Rule 3: collectible invoice ALLOWLIST (fails closed) — the invoice-reminder precedent.
    const projectInvoices = await db.query.invoices.findMany({
      where: and(eq(invoices.projectId, projectId), inArray(invoices.status, [...COLLECTIBLE_INVOICE_STATUSES])),
    });
    for (const invoice of projectInvoices) {
      const allPayments = await db.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, invoice.id) });
      for (const payment of allPayments) {
        if (!payment.dueDate) continue; // rule 2: a null-due installment never autopays
        if (payment.dueDate.slice(0, 10) > nowKey) continue; // rule 2: due date not yet arrived
        if (invoicePaymentOpenCents(payment) <= 0) continue; // rule 4: settled/paid → skip
        const { clientPayableOpenCents, serviceOpenCents } = computePayable(invoice, payment, allPayments);
        if (clientPayableOpenCents <= 0) continue; // rule 4
        candidates.push({ payment, invoice, consent, clientPayableOpenCents, serviceOpenCents });
        if (candidates.length >= batchMax) return candidates; // rule §5.3 bounded batch
      }
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// §6.2a post-claim re-verification (MAJOR-1 + R-2). Re-read installment + invoice + consent; if ANY
// §5.1 condition no longer holds OR the recomputed payable ≠ the pinned amount, the caller CASes to
// aborted_ineligible and does NOT POST.
// ---------------------------------------------------------------------------
export async function recheckEligibility(charge: ChargeRow): Promise<
  { ok: true; payment: PaymentRow; invoice: InvoiceRow; consent: ConsentRow } | { ok: false; reason: string }
> {
  const payment = await db.query.invoicePayments.findFirst({ where: eq(invoicePayments.id, charge.invoicePaymentId) });
  if (!payment) return { ok: false, reason: "payment_missing" };
  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, payment.invoiceId) });
  if (!invoice || !(COLLECTIBLE_INVOICE_STATUSES as readonly string[]).includes(invoice.status)) {
    return { ok: false, reason: "invoice_not_collectible" };
  }
  if (invoicePaymentOpenCents(payment) <= 0) return { ok: false, reason: "installment_settled" };
  const consent = await db.query.autopayConsents.findFirst({ where: eq(autopayConsents.id, charge.consentId) });
  if (!consent || consent.status !== "active" || consent.consentVersion !== AUTOPAY_CONSENT_VERSION || !consent.stripePaymentMethodId) {
    return { ok: false, reason: "consent_inactive" };
  }
  // R-2: re-verify the AMOUNT, not just the booleans — an installment edited/paid-down after claim
  // still passes payable>0 while the pinned amount is now an overcharge.
  const allPayments = await db.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, invoice.id) });
  const { clientPayableOpenCents, serviceOpenCents } = computePayable(invoice, payment, allPayments);
  if (clientPayableOpenCents !== charge.amountCents || serviceOpenCents !== charge.serviceAmountCents) {
    return { ok: false, reason: "amount_drift" };
  }
  // MAJOR-1 (defense-in-depth, third layer): even when the recomputed payable equals the pinned
  // amount, a claim that ends up over the hard cap must NEVER POST — a fat-fingered large installment
  // can never be silently auto-drained (§5.1 rule 7). The over-cap CAS + isClaimable cap guard should
  // already have re-routed it to skipped_capped before the claim; this is the last-ditch backstop.
  if (clientPayableOpenCents > autopayMaxChargeCents()) {
    return { ok: false, reason: "over_cap" };
  }
  return { ok: true, payment, invoice, consent };
}

// Token-guarded transition to a provable non-charged terminal (aborted_ineligible). No POST was made.
async function abortCharge(chargeId: string, claimToken: string, reason: string) {
  const now = new Date().toISOString();
  await db
    .update(autopayCharges)
    .set({ status: "aborted_ineligible", abortReason: reason, lastError: capError(reason), updatedAt: now })
    .where(and(eq(autopayCharges.id, chargeId), eq(autopayCharges.status, "charging"), eq(autopayCharges.claimToken, claimToken)));
}

// Token-guarded release back to pending (a provable nothing-was-sent) so the next tick re-resolves.
// Build caution (a): a §6.2b resolution failure (null session read R-1, or an unresolved expire R-3)
// made ZERO charge attempts, so it must NOT burn the retry budget — DECREMENT attempt_count in the
// SAME CAS (a repeated deferral would otherwise inflate attempt_count and prematurely trip
// failed_terminal). The never-sent idempotency key is cleared here and safely RE-DERIVED (id:count+1)
// by the claiming UPDATE on the next re-claim. The claim_token is released so the row is unowned.
async function releaseToPending(chargeId: string, claimToken: string) {
  const now = new Date().toISOString();
  await db
    .update(autopayCharges)
    .set({
      status: "pending",
      attemptCount: sql`MAX(${autopayCharges.attemptCount} - 1, 0)`,
      idempotencyKey: null,
      claimToken: null,
      updatedAt: now,
    })
    .where(and(eq(autopayCharges.id, chargeId), eq(autopayCharges.status, "charging"), eq(autopayCharges.claimToken, claimToken)));
}

// ---------------------------------------------------------------------------
// §6.2b cross-channel resolution — the manual checkout link stays live for the SAME installment.
// Returns "proceed" (POST is safe), "abort_settled" (manual already paid — do NOT charge), or
// "defer" (fail-closed — do NOT POST this tick, row released to pending).
// ---------------------------------------------------------------------------
async function resolveCrossChannel(payment: PaymentRow, chargeId: string, claimToken: string): Promise<"proceed" | "abort_settled" | "defer"> {
  const sessionId = payment.stripeCheckoutSessionId;
  if (!sessionId || payment.stripeCheckoutStatus !== "link_ready") return "proceed";

  const settleComplete = async () => {
    await abortCharge(chargeId, claimToken, "session_complete");
    const full = await fetchStripeCheckoutSessionForSettle(sessionId);
    if (full) {
      try {
        await settleInvoicePaymentCheckoutSession(full);
      } catch {
        // The delayed webhook remains the recorder of record; §6.4 signal 4 covers the gap.
      }
    }
    return "abort_settled" as const;
  };

  const read = await fetchStripeCheckoutSessionReturnUrls(sessionId);
  // R-1: a non-null session id means a session provably EXISTS, so null = THE READ FAILED → FAIL CLOSED.
  if (read === null) {
    await releaseToPending(chargeId, claimToken);
    return "defer";
  }
  if (read.status === "complete") return settleComplete();
  if (read.status === "expired") return "proceed"; // already uncompletable
  if (read.status === "open") {
    // Expire FIRST so the hosted tab becomes uncompletable, THEN POST.
    try {
      await expireStripeCheckoutSessionById(sessionId);
      return "proceed";
    } catch {
      // R-3: expire rejected → the session may have completed in the GET→expire window. Re-GET.
      const re = await fetchStripeCheckoutSessionReturnUrls(sessionId);
      if (re && re.status === "complete") return settleComplete();
      // anything else (incl. a second failure) → do NOT POST this tick; release to pending.
      await releaseToPending(chargeId, claimToken);
      return "defer";
    }
  }
  // Unknown status → fail closed.
  await releaseToPending(chargeId, claimToken);
  return "defer";
}

// ---------------------------------------------------------------------------
// §6.6 manual fallback — cancel the residual PI, then mint the manual link + notify. R-5: if the
// cancel is rejected because the PI just SUCCEEDED, do NOT mint; converge to charged + record.
// Caution (b): the R-5 converge uses its OWN dedicated status-guarded CAS (needs_action/failed_terminal
// → charged) BEFORE recording — §6.5's success guard (charging/charged) does NOT cover it.
// ---------------------------------------------------------------------------
// §6.6 manual-fallback SIDE EFFECTS, shared by the sync engine path (handleManualFallback) AND the
// webhook failure path (recordAutopayPaymentIntentFailed, MEDIUM-4). The CAS state transition to
// needs_action/failed_terminal is the CALLER's job — each path guards it differently (the sync path
// by claim_token, the webhook by stripe_payment_intent_id) — and this helper runs ONLY AFTER that
// transition has provably succeeded (CAS-first ordering preserved). It cancels the residual PI (R-5
// guarded), then mints the manual link + notifies. Returns "converged" when R-5 found the PI already
// SUCCEEDED (the row was converged to 'charged' + recorded — the caller must treat it as a real
// charge, not a fallback) or "fell_back" for the normal manual-link outcome.
export async function runManualFallbackSideEffects(
  charge: ChargeRow,
  payment: PaymentRow,
  targetStatus: "needs_action" | "failed_terminal",
  detail: { declineCode?: string | null; message?: string | null },
): Promise<"converged" | "fell_back"> {
  const now = new Date().toISOString();
  // Cancel any still-cancelable PI first (MINOR-2) so no residual completion path double-charges.
  if (charge.stripePaymentIntentId) {
    try {
      await cancelStripePaymentIntent(charge.stripePaymentIntentId);
    } catch {
      // R-5: cancel rejected — GET the PI. If it just SUCCEEDED (slow-confirm race), do NOT mint a
      // manual link on top of a real charge; converge + record instead. Caution (b): this converge
      // uses its OWN status-guarded CAS (needs_action/failed_terminal → charged) BEFORE recording.
      const pi = await getStripePaymentIntent(charge.stripePaymentIntentId);
      if (pi && pi.status === "succeeded") {
        const converged = await db
          .update(autopayCharges)
          .set({ status: "charged", stripeStatus: "succeeded", chargedAt: now, updatedAt: now })
          .where(and(eq(autopayCharges.id, charge.id), inArray(autopayCharges.status, ["needs_action", "failed_terminal"])))
          .returning({ id: autopayCharges.id });
        if (converged.length) {
          const fresh = (await db.query.autopayCharges.findFirst({ where: eq(autopayCharges.id, charge.id) })) ?? charge;
          await recordAutopayInstallmentPaid(fresh, { id: pi.id, metadata: {} });
        }
        return "converged"; // do NOT mint a manual link
      }
      // Benign cancel error (already canceled/failed) → proceed to the manual fallback.
    }
  }

  // Mint the existing manual checkout link + notify (the pre-autopay world: manual link + dunning).
  try {
    await createInvoicePaymentCheckoutSession(payment.invoiceId, payment.id, { actorType: "system", actorName: "Autopay" });
  } catch {
    // A mint failure must not crash the tick; dunning/reminders still surface the open balance.
  }
  await logActivity({
    projectId: charge.projectId,
    action: "autopay.manual_fallback",
    actorType: "system",
    actorName: "Autopay",
    metadata: { chargeId: charge.id, paymentId: payment.id, status: targetStatus, declineCode: detail.declineCode ?? null },
  });
  return "fell_back";
}

async function handleManualFallback(
  charge: ChargeRow,
  payment: PaymentRow,
  targetStatus: "needs_action" | "failed_terminal",
  claimToken: string,
  detail: { declineCode?: string | null; message?: string | null },
  summary: AutopayRunSummary,
) {
  const now = new Date().toISOString();
  // 1. Transition charging → targetStatus (token-guarded). CAS-first: side effects run only after this.
  const transitioned = await db
    .update(autopayCharges)
    .set({
      status: targetStatus,
      declineCode: detail.declineCode ?? null,
      lastError: capError(detail.message ?? targetStatus),
      updatedAt: now,
    })
    .where(and(eq(autopayCharges.id, charge.id), eq(autopayCharges.status, "charging"), eq(autopayCharges.claimToken, claimToken)))
    .returning({ id: autopayCharges.id });
  if (!transitioned.length) {
    summary.lost += 1;
    return;
  }

  // 2. + 3. Cancel residual PI (R-5), mint manual link, notify (shared with the webhook path).
  const outcome = await runManualFallbackSideEffects(charge, payment, targetStatus, detail);
  if (outcome === "converged") {
    summary.charged += 1;
    return;
  }
  if (targetStatus === "needs_action") summary.needsAction += 1;
  else summary.failedTerminal += 1;
}

// ---------------------------------------------------------------------------
// §6 per-installment state machine.
// ---------------------------------------------------------------------------
async function processInstallment(candidate: Candidate, mode: "log_only" | "live", now: Date, summary: AutopayRunSummary) {
  const { payment, invoice, consent } = candidate;
  const nowIso = now.toISOString();
  const maxAttempts = autopayMaxAttempts();
  const cap = autopayMaxChargeCents();

  // Re-pin the amount from the freshest read at process time.
  const allPayments = await db.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, invoice.id) });
  const { clientPayableOpenCents: amountCents, serviceOpenCents } = computePayable(invoice, payment, allPayments);
  if (amountCents <= 0) return;
  const clientFeeCents = amountCents - serviceOpenCents;

  // --- log_only tick: a pure audit row OUTSIDE the exactly-once ledger; NO Stripe call, EVER. Bounded
  // to ONE upserted dry_run=1 row per installment (R-8) — refresh the would-charge amounts each observation.
  if (mode === "log_only") {
    // Raw single-statement partial-index UPSERT (R-8). drizzle's onConflictDoUpdate qualifies the
    // conflict-target column ("autopay_charges"."invoice_payment_id"), which SQLite/D1 REJECT for a
    // partial index, so this is expressed with an explicit `sql` template (bare column in the target).
    await db.run(sql`
      INSERT INTO autopay_charges (
        id, invoice_payment_id, invoice_id, project_id, consent_id, stripe_customer_id,
        stripe_payment_method_id, amount_cents, service_amount_cents, client_fee_cents, currency,
        status, dry_run, attempt_count, max_attempts, created_at, updated_at
      ) VALUES (
        ${crypto.randomUUID()}, ${payment.id}, ${invoice.id}, ${invoice.projectId}, ${consent.id}, ${consent.stripeCustomerId},
        ${consent.stripePaymentMethodId ?? ""}, ${amountCents}, ${serviceOpenCents}, ${clientFeeCents}, 'usd',
        'pending', 1, 0, ${maxAttempts}, ${nowIso}, ${nowIso}
      )
      ON CONFLICT (invoice_payment_id) WHERE dry_run = 1
      DO UPDATE SET amount_cents = ${amountCents}, service_amount_cents = ${serviceOpenCents},
        client_fee_cents = ${clientFeeCents}, updated_at = ${nowIso}
    `);
    await logActivity({
      projectId: invoice.projectId,
      action: "autopay.would_charge",
      actorType: "system",
      actorName: "Autopay",
      metadata: { paymentId: payment.id, invoiceId: invoice.id, amountCents, serviceOpenCents, clientFeeCents, dueDate: payment.dueDate },
    });
    summary.wouldCharge += 1;
    return;
  }

  // --- live tick. Layer 1: one REAL (dry_run=0) row per installment, ever. A fresh OVER-CAP installment
  // is INSERTed DIRECTLY as skipped_capped (never pending — R-6). ON CONFLICT (dry_run=0 partial index)
  // DO NOTHING; a pre-existing dry_run=1 row is invisible to it (BLOCKER-2).
  const overCap = amountCents > cap;
  const chargeId = crypto.randomUUID();
  const inserted = await db
    .insert(autopayCharges)
    .values({
      id: chargeId,
      invoicePaymentId: payment.id,
      invoiceId: invoice.id,
      projectId: invoice.projectId,
      consentId: consent.id,
      stripeCustomerId: consent.stripeCustomerId,
      stripePaymentMethodId: consent.stripePaymentMethodId ?? "",
      amountCents,
      serviceAmountCents: serviceOpenCents,
      clientFeeCents,
      currency: "usd",
      status: overCap ? "skipped_capped" : "pending",
      dryRun: 0,
      attemptCount: 0,
      maxAttempts,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .onConflictDoNothing()
    .returning({ id: autopayCharges.id });

  let row: ChargeRow | undefined;
  if (inserted.length) {
    if (overCap) {
      // Alert-storm guard (M3): fire the alert ONLY on the transition into skipped_capped.
      await logActivity({
        projectId: invoice.projectId,
        action: "autopay.skipped_capped",
        actorType: "system",
        actorName: "Autopay",
        metadata: { paymentId: payment.id, invoiceId: invoice.id, amountCents, capCents: cap },
      });
      summary.skippedCapped += 1;
      return;
    }
    row = await db.query.autopayCharges.findFirst({ where: eq(autopayCharges.id, chargeId) });
  } else {
    // A real row already exists — re-evaluate it (M2). Only the dry_run=0 row matters.
    row = await db.query.autopayCharges.findFirst({
      where: and(eq(autopayCharges.invoicePaymentId, payment.id), eq(autopayCharges.dryRun, 0)),
    });
  }
  if (!row) return;

  // Existing claimable row grown OVER-CAP → plain status-guarded CAS to skipped_capped (R-6). No claim
  // token — no money moves on this transition. Alert once (transition in). MAJOR-1: aborted_ineligible
  // is included — a re-qualified aborted row whose fresh payable is now over-cap must be re-routed to
  // skipped_capped (alert-once), NEVER re-claimed and POSTed over the hard ceiling (§5.1 rule 7).
  if (overCap && (row.status === "pending" || row.status === "failed_retryable" || row.status === "aborted_ineligible")) {
    const capped = await db
      .update(autopayCharges)
      .set({ status: "skipped_capped", updatedAt: nowIso })
      .where(and(eq(autopayCharges.id, row.id), inArray(autopayCharges.status, ["pending", "failed_retryable", "aborted_ineligible"])))
      .returning({ id: autopayCharges.id });
    if (capped.length) {
      await logActivity({
        projectId: invoice.projectId,
        action: "autopay.skipped_capped",
        actorType: "system",
        actorName: "Autopay",
        metadata: { paymentId: payment.id, invoiceId: invoice.id, amountCents, capCents: cap },
      });
      summary.skippedCapped += 1;
    }
    return;
  }

  // Rule 6: is this real row claimable on THIS tick?
  if (!isClaimable(row, { amountCents, cap, now })) return;

  // Layer 2: per-attempt CAS claim with a claim token. The idempotency_key + attempt_count are
  // materialized in this ONE statement (M1) so the key's suffix always matches the incremented count.
  const claimToken = crypto.randomUUID();
  await db
    .update(autopayCharges)
    .set({
      status: "charging",
      claimToken,
      idempotencyKey: sql`${autopayCharges.id} || ':' || (${autopayCharges.attemptCount} + 1)`,
      amountCents,
      serviceAmountCents: serviceOpenCents,
      clientFeeCents,
      // Re-pin the CONSENT (and its card) to the CURRENT active consent — a cured aborted_ineligible
      // row (revoke → re-consent, R-4) references the OLD consent, so re-pinning here lets §6.2a's
      // consent re-check see the fresh active row rather than the stale revoked one.
      consentId: consent.id,
      stripeCustomerId: consent.stripeCustomerId,
      stripePaymentMethodId: consent.stripePaymentMethodId ?? "",
      attemptCount: sql`${autopayCharges.attemptCount} + 1`,
      updatedAt: nowIso,
    })
    .where(and(
      eq(autopayCharges.id, row.id),
      eq(autopayCharges.dryRun, 0),
      inArray(autopayCharges.status, ["pending", "failed_retryable", "skipped_capped", "aborted_ineligible"]),
      // MEDIUM-2: in-statement retry-pacing guard so a stale pre-read can never claim a row that
      // another tick has meanwhile carried to failed_retryable (with backoff / at the attempt cap).
      // The JS isClaimable() checks are fast-path filters; THIS is the atomic backstop (I8 pacing).
      sql`(${autopayCharges.status} != 'failed_retryable' OR (${autopayCharges.attemptCount} < ${autopayCharges.maxAttempts} AND (${autopayCharges.nextAttemptAt} IS NULL OR ${autopayCharges.nextAttemptAt} <= ${nowIso})))`,
    ));

  // Re-read; proceed ONLY IF status='charging' AND claim_token=OURS (else another worker owns it).
  const claimed = await db.query.autopayCharges.findFirst({ where: eq(autopayCharges.id, row.id) });
  if (!claimed || claimed.status !== "charging" || claimed.claimToken !== claimToken) {
    summary.lost += 1;
    return;
  }

  // §6.2a post-claim re-verification (incl. amount equality, R-2).
  const recheck = await recheckEligibility(claimed);
  if (!recheck.ok) {
    await abortCharge(claimed.id, claimToken, recheck.reason);
    summary.aborted += 1;
    return;
  }

  // §6.2b cross-channel resolution.
  const resolution = await resolveCrossChannel(recheck.payment, claimed.id, claimToken);
  if (resolution === "abort_settled") {
    summary.aborted += 1;
    return;
  }
  if (resolution === "defer") {
    summary.deferred += 1;
    return;
  }

  // POST /v1/payment_intents (off_session:true, confirm:true), pinned amount + pinned idempotency key.
  let result;
  try {
    result = await createOffSessionPaymentIntent({
      customerId: claimed.stripeCustomerId,
      paymentMethodId: claimed.stripePaymentMethodId,
      amountCents: claimed.amountCents,
      currency: claimed.currency,
      idempotencyKey: claimed.idempotencyKey ?? `${claimed.id}:${claimed.attemptCount}`,
      metadata: {
        autopay_charge_id: claimed.id,
        invoice_payment_id: claimed.invoicePaymentId,
        invoice_id: claimed.invoiceId,
        project_id: claimed.projectId,
        service_amount_cents: String(claimed.serviceAmountCents),
        client_fee_cents: String(claimed.clientFeeCents),
      },
    });
  } catch {
    // AMBIGUOUS (network throw / 5xx / timeout) — money MAY have moved. LEAVE the row 'charging'
    // (TERMINAL-UNKNOWN). NEVER auto-retry — recovery is reconcile-against-Stripe (§6.4 tripwire).
    summary.ambiguous += 1;
    return;
  }

  // Persist the PI id IMMEDIATELY (MAJOR-3), token-guarded, whenever the POST returns any PI object
  // (including a decline/error body that carries a pi_...), so a later webhook/reconcile can match it.
  if (result.paymentIntentId) {
    await db
      .update(autopayCharges)
      .set({ stripePaymentIntentId: result.paymentIntentId, stripeStatus: result.stripeStatus ?? null, updatedAt: new Date().toISOString() })
      .where(and(eq(autopayCharges.id, claimed.id), eq(autopayCharges.claimToken, claimToken)));
  }
  const withPi = (await db.query.autopayCharges.findFirst({ where: eq(autopayCharges.id, claimed.id) })) ?? claimed;

  if (result.outcome === "succeeded") {
    // Leave the row 'charging'; the payment_intent.succeeded webhook is AUTHORITATIVE for recording
    // (§6.1 diagram). The reconcile tripwire fires only if the webhook never lands. The row is NOT yet
    // provably 'charged', so count it under confirmedPendingWebhook, never `charged` (MINOR-5).
    summary.confirmedPendingWebhook += 1;
    return;
  }
  if (result.outcome === "requires_action") {
    // SCA — an off-session charge CANNOT complete SCA. needs_action IMMEDIATELY, no off-session retry.
    await handleManualFallback(withPi, recheck.payment, "needs_action", claimToken, { declineCode: result.declineCode, message: "authentication_required" }, summary);
    return;
  }
  if (result.outcome === "failed") {
    // A PROVABLE decline — money did NOT move.
    const hard = result.declineCode ? HARD_DECLINE_CODES.has(result.declineCode) : false;
    // At-cap uses the ROW's own pinned max_attempts (MINOR-5) — the same basis the webhook path uses
    // (autopay-webhook.ts) — not autopayMaxAttempts() from env, which can drift from what a re-claimed
    // row was created with.
    const atCap = withPi.attemptCount >= withPi.maxAttempts;
    if (hard || atCap) {
      await handleManualFallback(withPi, recheck.payment, "failed_terminal", claimToken, { declineCode: result.declineCode, message: result.message }, summary);
      return;
    }
    // failed_retryable — a later tick (after next_attempt_at) retries with a NEW idempotency key.
    await db
      .update(autopayCharges)
      .set({
        status: "failed_retryable",
        declineCode: result.declineCode ?? result.code ?? null,
        lastError: capError(result.message ?? result.code),
        nextAttemptAt: backoffFrom(withPi.attemptCount, nowIso),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(autopayCharges.id, claimed.id), eq(autopayCharges.status, "charging"), eq(autopayCharges.claimToken, claimToken)));
    summary.declined += 1;
    return;
  }
  // "other" (requires_payment_method / processing / unknown) — leave 'charging' for the webhook/reconcile.
  summary.ambiguous += 1;
}

// Rule 6 claimability of a REAL row (dry_run=0). charged/charging/needs_action/failed_terminal → blocking.
function isClaimable(row: ChargeRow, ctx: { amountCents: number; cap: number; now: Date }): boolean {
  switch (row.status) {
    case "pending":
      return true;
    case "failed_retryable":
      return row.attemptCount < row.maxAttempts && (!row.nextAttemptAt || ctx.now.toISOString() >= row.nextAttemptAt);
    case "skipped_capped":
      return ctx.amountCents <= ctx.cap; // re-claimable ONLY if the freshly-pinned payable is now under cap
    case "aborted_ineligible":
      // §5.1 selection already re-qualified this installment on THIS tick (collectible invoice + open
      // payable + active current-version consent); §6.2a re-pins + re-guards post-claim, so a row that
      // only LOOKED re-qualified aborts right back without a POST (self-guarding). MAJOR-1: it is also
      // claimable ONLY when the freshly-pinned payable is under the hard cap — an over-cap re-qualified
      // aborted row is re-routed to skipped_capped above and must never reach a POST over the ceiling.
      return ctx.amountCents <= ctx.cap;
    default:
      return false; // charged | charging | needs_action | failed_terminal → blocking
  }
}

// ---------------------------------------------------------------------------
// Upcoming-charge notices (§8.1) — LIVE only. Selects installments due within the lead window and
// emits an idempotent notice (the helper enforces the gate + dedupe).
// ---------------------------------------------------------------------------
async function emitAutopayUpcomingNotices(now: Date, summary: AutopayRunSummary) {
  const leadDays = autopayNoticeLeadDays();
  const nowKey = dateKey(now);
  const windowEndKey = dateKey(new Date(now.getTime() + leadDays * 86_400_000));
  const allowlist = autopayPilotAllowlist();

  const consents = await db.query.autopayConsents.findMany({
    where: and(eq(autopayConsents.status, "active"), eq(autopayConsents.consentVersion, AUTOPAY_CONSENT_VERSION)),
  });
  for (const consent of consents) {
    if (!consent.stripePaymentMethodId) continue;
    if (allowlist && !allowlist.has(consent.projectId)) continue;
    const project = await db.query.projects.findFirst({ where: eq(projects.id, consent.projectId) });
    const client = await primaryClientForProject(consent.projectId);
    const projectInvoices = await db.query.invoices.findMany({
      where: and(eq(invoices.projectId, consent.projectId), inArray(invoices.status, [...COLLECTIBLE_INVOICE_STATUSES])),
    });
    for (const invoice of projectInvoices) {
      const allPayments = await db.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, invoice.id) });
      for (const payment of allPayments) {
        if (!payment.dueDate) continue;
        const dueKey = payment.dueDate.slice(0, 10);
        if (dueKey <= nowKey || dueKey > windowEndKey) continue; // only FUTURE installments within the lead window
        if (invoicePaymentOpenCents(payment) <= 0) continue;
        const { clientPayableOpenCents } = computePayable(invoice, payment, allPayments);
        if (clientPayableOpenCents <= 0) continue;
        // MINOR-4 (cheap half): never promise a charge that won't happen. If the installment's REAL
        // (dry_run=0) charge row is already in a blocking state — needs_action / failed_terminal (fell
        // back to manual), or charged / charging (already in flight) — the upcoming autopay charge will
        // NOT occur as advertised, so skip the "we'll charge your card" notice for it.
        const existingCharge = await db.query.autopayCharges.findFirst({
          where: and(eq(autopayCharges.invoicePaymentId, payment.id), eq(autopayCharges.dryRun, 0)),
        });
        if (existingCharge && ["needs_action", "failed_terminal", "charged", "charging"].includes(existingCharge.status)) {
          continue;
        }
        // Accepted limitation (MINOR-4, other half): the notice is one-shot — the dedupe row is claimed
        // by sendAutopayUpcomingNotice before send, so a TRANSIENT send failure is never retried (the
        // installment simply gets no notice, not a double notice). Fail-safe direction for email volume.
        const res = await sendAutopayUpcomingNotice({
          projectId: consent.projectId,
          clientId: consent.clientId,
          invoicePaymentId: payment.id,
          toEmail: client?.email ?? null,
          projectName: project?.name ?? "your project",
          amountCents: clientPayableOpenCents,
          dueDate: dueKey,
          cardBrand: consent.cardBrand,
          cardLast4: consent.cardLast4,
        });
        if (res.ok) summary.noticesSent += 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry (cron-only, §5.2/§5.3). No-op when AUTOPAY_ENABLED is off (defense-in-depth; the cron
// route also short-circuits). Mode is read ONCE at tick start and pinned per row at INSERT (§6.1).
// ---------------------------------------------------------------------------
export async function runDueAutopayCharges(now: Date = new Date()): Promise<AutopayRunSummary | { skipped: "flag_off" }> {
  if (!autopayEnabled()) return { skipped: "flag_off" };
  const mode = autopayChargeMode(); // read EXACTLY ONCE (BLOCKER-2)
  const summary = newSummary();

  const candidates = await selectQualifyingInstallments(now, autopayBatchMax());
  summary.selected = candidates.length;
  for (const candidate of candidates) {
    try {
      await processInstallment(candidate, mode, now, summary);
    } catch (error) {
      // One bad installment never blocks the rest (per-row isolation, like the sequence runner).
      await logActivity({
        projectId: candidate.invoice.projectId,
        action: "autopay.charge_error",
        actorType: "system",
        actorName: "Autopay",
        metadata: { paymentId: candidate.payment.id, error: capError(error instanceof Error ? error.message : String(error)) },
      }).catch(() => {});
    }
  }

  // Upcoming-charge notices only fire in live mode (log_only sends ZERO client emails, §8).
  if (mode === "live") {
    try {
      await emitAutopayUpcomingNotices(now, summary);
    } catch {
      // Notices are best-effort; never fail the charge tick over an email.
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// §6.4 reconciliation tripwires — NEVER a re-POST; recovery is reconcile-against-Stripe.
//
// Build caution (d) / MINOR-1: when a human hand-reconciles a stuck 'charging' row, Stripe has NO
// "get by idempotency key" API — reconcile by the row's persisted stripe_payment_intent_id (MAJOR-3)
// via GET /v1/payment_intents/:id, or by
// GET /v1/payment_intents/search?query=metadata['autopay_charge_id']. That SEARCH is EVENTUALLY
// CONSISTENT (up to ~1 minute of indexing lag), so a "no PI exists at all" conclusion must NEVER rest
// on a search miss alone for a young row — re-search after a delay and check any captured PI id first.
// The ~1h tripwire age below makes this moot in the normal flow. These tripwires only SURFACE the
// rows; the resolving Stripe query is a deliberate human-in-the-loop step, never an automatic re-POST.
// ---------------------------------------------------------------------------
export async function getAutopayChargeReconciliation(options?: {
  now?: Date;
  chargingThresholdMs?: number;
  chargedThresholdMs?: number;
  consentPendingThresholdMs?: number;
  sessionCompleteThresholdMs?: number;
}) {
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const chargingThresholdMs = options?.chargingThresholdMs ?? 60 * 60 * 1000; // ~1h
  const chargedThresholdMs = options?.chargedThresholdMs ?? 24 * 60 * 60 * 1000; // ~24h
  const consentPendingThresholdMs = options?.consentPendingThresholdMs ?? 60 * 60 * 1000; // ~1h
  const sessionCompleteThresholdMs = options?.sessionCompleteThresholdMs ?? 60 * 60 * 1000; // ~1h
  const ageMs = (iso: string | null) => (iso ? nowMs - new Date(iso).getTime() : Number.POSITIVE_INFINITY);

  const charging = await db.query.autopayCharges.findMany({ where: and(eq(autopayCharges.status, "charging"), eq(autopayCharges.dryRun, 0)) });
  const charged = await db.query.autopayCharges.findMany({ where: and(eq(autopayCharges.status, "charged"), eq(autopayCharges.dryRun, 0)) });
  const abortedComplete = await db.query.autopayCharges.findMany({ where: and(eq(autopayCharges.status, "aborted_ineligible"), eq(autopayCharges.dryRun, 0)) });
  const pendingConsents = await db.query.autopayConsents.findMany({ where: eq(autopayConsents.status, "pending") });

  // (1) charging older than ~1h → stuck in-flight (CRITICAL, per-row alertKey).
  const stuckCharging = charging.filter((row) => ageMs(row.updatedAt) >= chargingThresholdMs);

  // (2) charged older than ~24h with no recorded paid installment for THIS pi → not reconciled (CRITICAL).
  const notReconciled: ChargeRow[] = [];
  for (const row of charged) {
    if (ageMs(row.chargedAt ?? row.updatedAt) < chargedThresholdMs) continue;
    const payment = await db.query.invoicePayments.findFirst({ where: eq(invoicePayments.id, row.invoicePaymentId) });
    const recorded = payment?.status === "paid" && !!row.stripePaymentIntentId && payment.externalPaymentId === row.stripePaymentIntentId;
    if (!recorded) notReconciled.push(row);
  }

  // (3) pending consent with a seti_ older than ~1h → WARN "consent stuck pending" (MINOR-5).
  const consentStuckPending = pendingConsents.filter((row) => Boolean(row.setupIntentId) && ageMs(row.updatedAt) >= consentPendingThresholdMs);

  // (4) aborted_ineligible(session_complete) with the installment STILL unsettled after ~1h → CRITICAL
  // "paid at Stripe, unrecorded" (R-7) — a complete manual session whose settle failed AND whose
  // webhook never landed.
  const paidUnrecorded: ChargeRow[] = [];
  for (const row of abortedComplete) {
    if (row.abortReason !== "session_complete") continue;
    if (ageMs(row.updatedAt) < sessionCompleteThresholdMs) continue;
    const payment = await db.query.invoicePayments.findFirst({ where: eq(invoicePayments.id, row.invoicePaymentId) });
    if (payment && invoicePaymentOpenCents(payment) > 0) paidUnrecorded.push(row);
  }

  // Double-charge candidates (BLOCKER-1) — a DIFFERENT pi recorded on an already-paid installment.
  // MINOR-2: recordAutopayInstallmentPaid can set refund_candidate_pi while the row is in ANY state
  // (charged/charging/aborted_ineligible AND needs_action/failed_terminal — a different-pi success can
  // land on an already-paid installment whose autopay row fell back), so scan by the flag directly
  // across every real (dry_run=0) row rather than a fixed status subset.
  const doubleCharge = await db.query.autopayCharges.findMany({
    where: and(eq(autopayCharges.dryRun, 0), isNotNull(autopayCharges.refundCandidatePi)),
  });

  const map = (row: ChargeRow, kind: string) => ({
    chargeId: row.id,
    invoicePaymentId: row.invoicePaymentId,
    amountCents: row.amountCents,
    stripePaymentIntentId: row.stripePaymentIntentId,
    updatedAt: row.updatedAt,
    kind,
  });

  return {
    stuckCharging: stuckCharging.map((row) => map(row, "autopay_charge_stuck_in_flight")),
    notReconciled: notReconciled.map((row) => map(row, "autopay_charge_not_reconciled")),
    consentStuckPending: consentStuckPending.map((row) => ({
      consentId: row.id,
      projectId: row.projectId,
      setupIntentId: row.setupIntentId,
      updatedAt: row.updatedAt,
      kind: "autopay_consent_stuck_pending",
    })),
    paidUnrecorded: paidUnrecorded.map((row) => map(row, "autopay_paid_at_stripe_unrecorded")),
    doubleCharge: doubleCharge.map((row) => ({ ...map(row, "autopay_double_charge"), refundCandidatePi: row.refundCandidatePi })),
    totalCount: stuckCharging.length + notReconciled.length + consentStuckPending.length + paidUnrecorded.length + doubleCharge.length,
  };
}

// ---------------------------------------------------------------------------
// Consent capture (§4.1/§4.3) — invoked by the portal-token-authed routes with a project resolved
// ONLY from the token (never the request body; no IDOR). AUTOPAY_ENABLED off ⇒ these no-op/throw (I1).
// ---------------------------------------------------------------------------
export async function setupAutopayConsent(projectId: string): Promise<{ url: string; consentId: string }> {
  if (!autopayEnabled()) throw new Error("Autopay is disabled.");
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new Error("Project not found.");
  const client = await primaryClientForProject(projectId);
  if (!client?.email) throw new Error("Add a primary client with an email address before turning on autopay.");

  // Find-or-create is idempotent only within Stripe's ~24h idempotency-key window (key
  // `autopay-cus:${projectId}`): a re-consent MORE than 24h after the first setup can mint a second
  // `cus_…` for the same project. Accepted limitation (MINOR-3) — cosmetic at Stripe (a duplicate,
  // unused customer), never a money or exactly-once risk (charges key on the consent row, not the cus).
  const customer = await createStripeCustomer({
    projectId,
    email: client.email,
    name: [client.firstName, client.lastName].filter(Boolean).join(" ") || null,
  });

  const consentId = crypto.randomUUID();
  const now = new Date().toISOString();
  // Supersede any prior non-active (pending/failed) row so a re-attempt starts clean.
  await db
    .update(autopayConsents)
    .set({ status: "failed", updatedAt: now })
    .where(and(eq(autopayConsents.projectId, projectId), eq(autopayConsents.status, "pending")));
  await db.insert(autopayConsents).values({
    id: consentId,
    projectId,
    clientId: client.id,
    stripeCustomerId: customer.id,
    stripePaymentMethodId: null,
    consentVersion: AUTOPAY_CONSENT_VERSION,
    consentTextHash: autopayConsentTextHash(),
    status: "pending",
    setupIntentId: null,
    createdAt: now,
    updatedAt: now,
  });

  const base = appBaseUrl();
  const session = await createAutopaySetupCheckoutSession({
    customerId: customer.id,
    projectId,
    consentId,
    successUrl: `${base}/portal?autopay=success`,
    cancelUrl: `${base}/portal?autopay=cancelled`,
  });
  if (session.setupIntentId) {
    await db
      .update(autopayConsents)
      .set({ setupIntentId: session.setupIntentId, updatedAt: new Date().toISOString() })
      .where(eq(autopayConsents.id, consentId));
  }
  await logActivity({
    projectId,
    clientId: client.id,
    action: "autopay.consent_setup_started",
    actorType: "client",
    actorName: "Client",
    metadata: { consentId, consentVersion: AUTOPAY_CONSENT_VERSION },
  });
  return { url: session.url, consentId };
}

export async function revokeAutopayConsent(projectId: string): Promise<{ revoked: number }> {
  if (!autopayEnabled()) throw new Error("Autopay is disabled.");
  const now = new Date().toISOString();
  const revoked = await db
    .update(autopayConsents)
    .set({ status: "revoked", revokedAt: now, updatedAt: now })
    .where(and(eq(autopayConsents.projectId, projectId), eq(autopayConsents.status, "active")))
    .returning({ id: autopayConsents.id, stripePaymentMethodId: autopayConsents.stripePaymentMethodId, clientId: autopayConsents.clientId });

  for (const row of revoked) {
    if (row.stripePaymentMethodId) await detachStripePaymentMethod(row.stripePaymentMethodId);
    await logActivity({
      projectId,
      clientId: row.clientId,
      action: "autopay.consent_revoked",
      actorType: "client",
      actorName: "Client",
      metadata: { consentId: row.id },
    });
  }
  return { revoked: revoked.length };
}

// Read-only helper for the portal UI (§4.3) — the active card-on-file, if any (display fields only, I4).
export async function getActiveAutopayConsent(projectId: string) {
  if (!autopayEnabled()) return null;
  const consent = await db.query.autopayConsents.findFirst({
    where: and(eq(autopayConsents.projectId, projectId), eq(autopayConsents.status, "active")),
  });
  if (!consent) return null;
  return {
    consentId: consent.id,
    cardBrand: consent.cardBrand,
    cardLast4: consent.cardLast4,
    cardExpMonth: consent.cardExpMonth,
    cardExpYear: consent.cardExpYear,
    consentVersion: consent.consentVersion,
    isCurrentVersion: consent.consentVersion === AUTOPAY_CONSENT_VERSION,
  };
}
