// Phase 9a: three-state gate for the refund status-transition behavior.
//
//   off          — do nothing extra (child tables still recorded; see below).
//   record_only  — DEFAULT. Write child ledger rows + summary columns + surface
//                  them in net figures/reconciliation, but do NOT flip
//                  payment.status to "refunded" and do NOT recompute the invoice.
//   enforce      — ALSO flip payment.status and recompute the parent invoice.
//
// Recording the raw event (payment_refunds / payment_disputes / the summary
// columns) is ALWAYS-ON and safe — only the derived payment.status mutation +
// invoice recompute is gated. This gives an observation window before the risky
// status-flip goes live; Tyler flips to "enforce" after watching real refund data
// (Autonomous Build Loop guardrail 2 — enablement flips are not autonomous).
//
// Modeled on cspMode()/adminProofEnforced(): read from process.env INSIDE the body
// (never as a default param) so the narrow param type never absorbs the weak
// ProcessEnv type under strict TS (avoids TS2559).

export type FinanceRefundRecordingMode = "off" | "record_only" | "enforce";

export function financeRefundRecordingMode(env?: { FINANCE_REFUND_RECORDING?: string }): FinanceRefundRecordingMode {
  const value = (env ?? process.env).FINANCE_REFUND_RECORDING;
  if (value === "off") return "off";
  if (value === "enforce") return "enforce";
  // Unset, empty, or any typo → the safe default. record_only records everything
  // but never mutates canonical payment/invoice status.
  return "record_only";
}

// True only when the derived payment.status="refunded" flip + invoice recompute
// should run. `off` and `record_only` both leave canonical status untouched.
export function financeRefundStatusFlipEnabled(env?: { FINANCE_REFUND_RECORDING?: string }): boolean {
  return financeRefundRecordingMode(env) === "enforce";
}

// True when the child tables + summary columns should be written at all. Only a
// literal `off` disables recording; the always-on default records.
export function financeRefundRecordingEnabled(env?: { FINANCE_REFUND_RECORDING?: string }): boolean {
  return financeRefundRecordingMode(env) !== "off";
}

// Phase 9b: hard money gate for admin-triggered Stripe refund INITIATION (the only
// code that calls POST /v1/refunds). Default OFF. Parsed strict `=== "1"` — exactly
// like adminProofEnforced (admin-proxy-auth.test.ts:194-197): unset, "", "0", "true",
// "on", any typo → OFF; only the literal "1" enables. No fuzzy truthiness on a money
// gate. Read INSIDE the body (never as a default param) to avoid TS2559 on ProcessEnv.
export function refundInitiationEnabled(env?: { REFUND_INITIATION_ENABLED?: string }): boolean {
  return (env ?? process.env).REFUND_INITIATION_ENABLED === "1";
}

// Phase 12: unified accept-sign-PAY. Off by default. A SIMPLE boolean (not three-state) — there
// is no autonomous money movement to gate (the client always completes hosted Stripe Checkout, the
// same client-initiated mechanism as existing installment pay), so there is no observation window.
// Parsed strict `=== "1"` (unset, "", "0", "true", "on", any typo → OFF). Read INSIDE the body
// (never as a default param) to avoid TS2559 on the weak ProcessEnv type. Flag OFF ⇒ the accept
// route behaves byte-identically to today (sign → ?accepted=1; pay via existing per-installment links).
export function unifiedSignPayEnabled(env?: { UNIFIED_SIGN_PAY?: string }): boolean {
  return (env ?? process.env).UNIFIED_SIGN_PAY === "1";
}
