// Phase 13 — Autopay / card-on-file flag helpers (the money gate, §7).
//
// All strict, all read INSIDE the body (never as a default param) to avoid the TS2559
// weak-ProcessEnv pitfall — modeled exactly on refundInitiationEnabled /
// financeRefundRecordingMode (finance-flags.ts). Off-by-default; a dark deploy is a
// zero-behavior no-op (I1). AUTOPAY_CHARGE_MODE defaults to log_only (I2 Guardrail 2):
// even with the master flag ON the engine issues ZERO Stripe charge calls until Tyler
// flips it to `live`.

// Master flag. Strict `=== "1"` — unset / "" / "0" / "true" / "on" / any typo → OFF.
// ONLY the literal "1" enables (Tyler-only flip #1). Off ⇒ total no-op (I1).
export function autopayEnabled(env?: { AUTOPAY_ENABLED?: string }): boolean {
  return (env ?? process.env).AUTOPAY_ENABLED === "1";
}

export type AutopayChargeMode = "log_only" | "live";

// Two-state charge mode (read like financeRefundRecordingMode). ONLY the literal "live"
// enables real off-session charges (Tyler-only flip #2). Any unset / typo / "log_only" →
// the fail-safe `log_only` (would-charge audit rows, ZERO Stripe charge calls, ZERO emails).
// Read EXACTLY ONCE per tick and pinned into every row's dry_run at INSERT (§6.1, BLOCKER-2).
export function autopayChargeMode(env?: { AUTOPAY_CHARGE_MODE?: string }): AutopayChargeMode {
  return (env ?? process.env).AUTOPAY_CHARGE_MODE === "live" ? "live" : "log_only";
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

// Per-charge hard ceiling (§5.1 rule 7). Payable above it ⇒ skipped_capped + one alert,
// never charged. Default $1,000.
export function autopayMaxChargeCents(env?: { AUTOPAY_MAX_CHARGE_CENTS?: string }): number {
  return intEnv((env ?? process.env).AUTOPAY_MAX_CHARGE_CENTS, 100000);
}

// Optional pilot allowlist of project ids (§5.1 rule 8). Unset/empty ⇒ null (= all consented
// projects). When set, only listed projects auto-charge — a controlled first-live pilot.
export function autopayPilotAllowlist(env?: { AUTOPAY_PILOT_ALLOWLIST?: string }): Set<string> | null {
  const raw = (env ?? process.env).AUTOPAY_PILOT_ALLOWLIST;
  if (!raw || !raw.trim()) return null;
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length ? new Set(ids) : null;
}

// Retry cap (I8). Default 3.
export function autopayMaxAttempts(env?: { AUTOPAY_MAX_ATTEMPTS?: string }): number {
  return intEnv((env ?? process.env).AUTOPAY_MAX_ATTEMPTS, 3);
}

// Max installments charged per tick (§5.3). Default 50.
export function autopayBatchMax(env?: { AUTOPAY_BATCH_MAX?: string }): number {
  return intEnv((env ?? process.env).AUTOPAY_BATCH_MAX, 50);
}

// Lead days for the upcoming-charge notice (§8.1). Default 3.
export function autopayNoticeLeadDays(env?: { AUTOPAY_NOTICE_LEAD_DAYS?: string }): number {
  return intEnv((env ?? process.env).AUTOPAY_NOTICE_LEAD_DAYS, 3);
}
