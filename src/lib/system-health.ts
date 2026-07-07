// Phase 21 — the single read-only health-computation module. computeSystemHealth() assembles
// the §1 catalog into a typed report. PURE READ: it reads job_runs + existing reconciliation
// queries + direct counts over sequence_sends / project_communications. NO writes, NO flag
// (always callable). It feeds the digest, the immediate-critical scan, /api/agent/health, and
// the /system-status page. Every external query is wrapped so a single failing signal degrades
// to INFO rather than throwing the whole report (monitoring is best-effort).

import { db } from "@/db/client";
import { emailSuppressions, projectCommunications, sequenceSends } from "@/db/schema";
import { readJobRuns } from "@/lib/job-runs";
import { getAgentFinanceReport } from "@/lib/agent-finance";
import { and, eq, inArray, lt } from "drizzle-orm";

export type HealthSeverity = "ok" | "info" | "warn" | "critical";

export type HealthSignal = {
  key: string;
  label: string;
  severity: HealthSeverity;
  detail: string;
  value?: number | string | null;
  // Set on CRITICAL signals so the monitor route can dedupe the immediate email (§4.4).
  alertKey?: string;
};

export type SystemHealthReport = {
  generatedAt: string;
  overall: "green" | "warn" | "critical";
  signals: HealthSignal[];
  // Alert-key prefixes whose SOURCE failed to read this run (e.g. the finance/refund read threw).
  // The resolve sweep must NOT resolve/re-arm keys matching these — the condition may still be
  // active but was unreadable this cycle (FIX 5).
  degradedAlertKeyPrefixes?: string[];
};

const SEVERITY_RANK: Record<HealthSeverity, number> = { ok: 0, info: 1, warn: 2, critical: 3 };
function maxSeverity(a: HealthSeverity, b: HealthSeverity): HealthSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Flag + config helpers (read in body; never as default params). MONITOR_ENABLED gates the
// monitor route's autonomous EMAIL + ping only — computeSystemHealth itself is always callable.
// ---------------------------------------------------------------------------
export function monitorEnabled(): boolean {
  return process.env.MONITOR_ENABLED === "1";
}
export function alertEmail(): string | null {
  return process.env.ALERT_EMAIL?.trim() || null;
}
export function deadmanPingUrl(): string | null {
  return process.env.DEADMAN_PING_URL?.trim() || null;
}

// The intended default digest hour (8 ET). A config typo (empty / NaN / non-integer / out of
// [0,23]) must not silently disable the digest — nor, via NaN, make easternHour() never match and
// skip it forever. Pure + exported so the parse is unit-testable.
export const DEFAULT_DIGEST_HOUR = 8;
export function parseDigestHour(value: string | undefined | null): number {
  if (typeof value !== "string" || value.trim() === "") return DEFAULT_DIGEST_HOUR;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) return DEFAULT_DIGEST_HOUR;
  return parsed;
}

const HOUR_MS = 60 * 60 * 1000;

// REQUIRED-cadence jobs: a MISSING row OR NULL last_success_at is treated as maximally stale
// (clocked from the enablement timestamp), NOT green and NOT not-configured (spec §1/§4.1).
type RequiredJobConfig = {
  label: string;
  warnMs: number;
  criticalMs: number;
  // failure escalation for a recorded FAILURE (last_status='error'): warn at warnFailures,
  // critical at criticalFailures consecutive failures.
  warnFailures: number;
  criticalFailures: number;
  alertKey: string;
};

const REQUIRED_JOBS: Record<string, RequiredJobConfig> = {
  "scheduler-reminders": {
    label: "Reminders cron",
    warnMs: 2 * HOUR_MS,
    criticalMs: 6 * HOUR_MS,
    warnFailures: 1,
    criticalFailures: 3,
    alertKey: "critical:reminders_stale",
  },
  "sequence-runner": {
    label: "Sequence runner",
    warnMs: 26 * HOUR_MS,
    criticalMs: 50 * HOUR_MS,
    warnFailures: 1,
    criticalFailures: 3,
    alertKey: "critical:sequence_runner_stale",
  },
  "systems-monitor": {
    label: "Systems monitor",
    warnMs: 2 * HOUR_MS,
    criticalMs: 6 * HOUR_MS,
    warnFailures: 1,
    criticalFailures: 3,
    alertKey: "critical:systems_monitor_stale",
  },
};

// Event-driven webhook/inbound handlers: error-RATE is the signal, staleness is meaningless.
// A missing row is genuinely not-configured (INFO), never a stale alarm.
type WebhookJobConfig = {
  label: string;
  warnFailures: number;
  criticalFailures: number;
  alertKey?: string; // only set when the job can reach CRITICAL
};

const WEBHOOK_JOBS: Record<string, WebhookJobConfig> = {
  "stripe-webhook": { label: "Stripe webhook", warnFailures: 1, criticalFailures: 3, alertKey: "critical:stripe_webhook_failing" },
  "twilio-status": { label: "Twilio status webhook", warnFailures: 5, criticalFailures: Number.POSITIVE_INFINITY },
  "twilio-inbound": { label: "Twilio inbound webhook", warnFailures: 5, criticalFailures: Number.POSITIVE_INFINITY },
  "inbound-inquiry": { label: "Inbound inquiry email", warnFailures: 3, criticalFailures: Number.POSITIVE_INFINITY },
  // Phase 24 (CR-6) — WARN-only, mirrors twilio-inbound/inbound-inquiry: a failing bounce/
  // complaint webhook degrades deliverability hygiene, not money state, so it should never page.
  "resend-webhook": { label: "Resend bounce/complaint webhook", warnFailures: 3, criticalFailures: Number.POSITIVE_INFINITY },
};

// Stripe signature-misconfiguration signal (FIX 4). A rotated/wrong STRIPE_WEBHOOK_SECRET makes
// every real event reject pre-verify (recorded under the non-alerting 'stripe-webhook-rejected'
// key) while 'stripe-webhook' quietly stays ok/info and payments/refunds/disputes stop landing.
// We WARN when rejects are RECENT + REPEATED and no stripe-webhook success is recent. Tuned so a
// one-off scanner probe (a single, stale reject with a healthy recent success) does NOT warn.
const STRIPE_REJECT_FRESH_MS = 6 * HOUR_MS; // a reject this recent counts as "real events rejecting now"
const STRIPE_REJECT_MIN_COUNT = 2; // >1 so a single scanner probe never trips it
const STRIPE_WEBHOOK_SUCCESS_FRESH_MS = 24 * HOUR_MS; // a success this recent means the secret is fine

// Phase 24 (CR-6, rev 2 MAJOR 2) — the identical Resend/SVIX misconfiguration signal, mirroring
// the Stripe constants immediately above. A rotated/wrong RESEND_WEBHOOK_SECRET makes every real
// event reject pre-verify (recorded only under the non-alerting 'resend-webhook-rejected' key)
// while 'resend-webhook' quietly stops accumulating successes and never escalates on its own.
const RESEND_REJECT_FRESH_MS = 6 * HOUR_MS;
const RESEND_REJECT_MIN_COUNT = 2;
const RESEND_WEBHOOK_SUCCESS_FRESH_MS = 24 * HOUR_MS;

const BACKUP_STALE_MS = 36 * HOUR_MS; // matches deploy:preflight's <=36h D1 check
const SEQUENCE_STUCK_MS = 2 * HOUR_MS; // a claimed send older than a run interval
const SMS_FAILURE_WINDOW_MS = 24 * HOUR_MS;
const TWILIO_FAILED_DELIVERY_STATES = ["failed", "undelivered"] as const;

function ageMs(now: number, iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY;
}

// Staleness for the REQUIRED-cadence branch. An UNPARSEABLE/NULL reference already yields
// +Infinity (fail toward CRITICAL). A FUTURE reference (config typo — e.g. MONITOR_REQUIRED_SINCE
// set ahead of now) yields a NEGATIVE age; clamp so it fails TOWARD stale, never green: a MISSING
// required job is treated as maximally stale (+Infinity), a present job as at-least-zero age
// (MINOR: future since-date must not render a missing required job green).
function requiredStalenessMs(now: number, iso: string | null, missing: boolean): number {
  const age = ageMs(now, iso);
  if (age < 0) return missing ? Number.POSITIVE_INFINITY : 0;
  return age;
}

export type ComputeHealthOptions = {
  now?: Date;
  // ISO enablement timestamp for the REQUIRED jobs (a missing/NULL row clocks staleness from
  // here). Config constant, overridable in tests. Falls back to MONITOR_REQUIRED_SINCE env.
  requiredJobEnabledAt?: string;
  // Injectable finance/refund reconciliation loader (defaults to getAgentFinanceReport). When it
  // THROWS, the source is treated as DEGRADED (FIX 5): the refund/reconciliation signals surface
  // as WARN (never dropped to green) and their alert keys are protected from the resolve sweep.
  loadFinanceReport?: () => Promise<Awaited<ReturnType<typeof getAgentFinanceReport>>>;
};

function requiredEnabledAt(options?: ComputeHealthOptions): string {
  return (
    options?.requiredJobEnabledAt ||
    process.env.MONITOR_REQUIRED_SINCE?.trim() ||
    "2026-07-06T00:00:00.000Z"
  );
}

export async function computeSystemHealth(options?: ComputeHealthOptions): Promise<SystemHealthReport> {
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const enabledAt = requiredEnabledAt(options);
  const signals: HealthSignal[] = [];
  // Alert-key prefixes whose source failed this run (FIX 5) — carried to the resolve sweep.
  const degradedAlertKeyPrefixes: string[] = [];

  const jobRows = await readJobRuns();
  const jobByName = new Map(jobRows.map((row) => [row.jobName, row]));

  // --- Required-cadence jobs (staleness + recorded failure) --------------------------------
  for (const [name, cfg] of Object.entries(REQUIRED_JOBS)) {
    const row = jobByName.get(name);
    // Recorded FAILURE branch: latest run errored → evaluate on last_status/consecutive_failures.
    if (row && row.lastStatus === "error") {
      const failures = row.consecutiveFailures || 1;
      const errorSeverity: HealthSeverity = failures >= cfg.criticalFailures ? "critical" : "warn";
      // FIX 3: a job frozen at last_status='error' must STILL escalate on staleness — otherwise a
      // job stuck at consecutive_failures:1 renders WARN forever even months past its last success.
      // Take the MAX of the error-derived severity and the staleness-derived severity.
      const staleRef = row.lastSuccessAt ?? enabledAt;
      const stale = requiredStalenessMs(nowMs, staleRef, !row.lastSuccessAt);
      let staleSeverity: HealthSeverity = "ok";
      if (stale >= cfg.criticalMs) staleSeverity = "critical";
      else if (stale >= cfg.warnMs) staleSeverity = "warn";
      const severity = maxSeverity(errorSeverity, staleSeverity);
      const staleNote =
        staleSeverity !== "ok" && !row.lastSuccessAt
          ? ` No successful run on record (clocked from enablement ${enabledAt}).`
          : staleSeverity !== "ok"
            ? ` Last success ${row.lastSuccessAt} is stale.`
            : "";
      signals.push({
        key: name,
        label: cfg.label,
        severity,
        detail: `${cfg.label} last run FAILED (${failures} consecutive): ${row.lastError ?? "no detail"}.${staleNote}`,
        value: failures,
        alertKey: severity === "critical" ? cfg.alertKey : undefined,
      });
      continue;
    }

    // Staleness branch. Missing row OR NULL last_success_at = maximally stale from enablement.
    const missing = !row || !row.lastSuccessAt;
    const reference = row?.lastSuccessAt ?? enabledAt;
    const stale = requiredStalenessMs(nowMs, reference, missing);
    let severity: HealthSeverity = "ok";
    if (stale >= cfg.criticalMs) severity = "critical";
    else if (stale >= cfg.warnMs) severity = "warn";

    // A required job with last_status='ok' but an advisory last_error (e.g. reminders' transient
    // partial-send blip: failed>0 && sent>0, recorded ok but noted) → WARN self-healing, unless
    // staleness already escalated higher.
    if (severity === "ok" && row?.lastStatus === "ok" && row.lastError) {
      severity = "warn";
    }

    const detailBase = missing
      ? `${cfg.label} has NO recorded successful run (missing heartbeat) — clocked stale from enablement ${enabledAt}.`
      : `${cfg.label} last succeeded ${row?.lastSuccessAt}.`;
    const advisory = severity === "warn" && row?.lastStatus === "ok" && row.lastError ? ` Advisory: ${row.lastError}.` : "";
    signals.push({
      key: name,
      label: cfg.label,
      severity,
      detail: `${detailBase}${advisory}`,
      value: row?.lastSuccessAt ?? null,
      alertKey: severity === "critical" ? cfg.alertKey : undefined,
    });
  }

  // --- Event-driven webhook/inbound handlers (error-rate) ----------------------------------
  for (const [name, cfg] of Object.entries(WEBHOOK_JOBS)) {
    const row = jobByName.get(name);
    if (!row) {
      signals.push({
        key: name,
        label: cfg.label,
        severity: "info",
        detail: `${cfg.label} has no recorded run yet (event-driven — not-configured, not an alarm).`,
        value: null,
      });
      continue;
    }
    const failures = row.lastStatus === "error" ? row.consecutiveFailures || 0 : 0;
    let severity: HealthSeverity = "ok";
    if (failures >= cfg.criticalFailures) severity = "critical";
    else if (failures >= cfg.warnFailures) severity = "warn";
    else if (row.lastStatus === "error") severity = "info";
    signals.push({
      key: name,
      label: cfg.label,
      severity,
      detail:
        severity === "ok"
          ? `${cfg.label} last call ok (${row.lastRunAt ?? "unknown"}).`
          : `${cfg.label} failing: ${failures} consecutive failures. ${row.lastError ?? ""}`.trim(),
      value: failures,
      alertKey: severity === "critical" ? cfg.alertKey : undefined,
    });
  }

  // --- Stripe signature misconfiguration (FIX 4) -------------------------------------------
  // A persistent rotated/wrong STRIPE_WEBHOOK_SECRET is otherwise INVISIBLE: real events reject
  // pre-verify (→ 'stripe-webhook-rejected', in no catalog) while 'stripe-webhook' stays ok/info.
  {
    const rejected = jobByName.get("stripe-webhook-rejected");
    const webhook = jobByName.get("stripe-webhook");
    const rejectCount = rejected?.consecutiveFailures ?? 0;
    const rejectsFresh = rejected ? ageMs(nowMs, rejected.lastRunAt) <= STRIPE_REJECT_FRESH_MS : false;
    const webhookRecentlySucceeded = webhook
      ? ageMs(nowMs, webhook.lastSuccessAt) <= STRIPE_WEBHOOK_SUCCESS_FRESH_MS
      : false;
    if (rejectsFresh && rejectCount >= STRIPE_REJECT_MIN_COUNT && !webhookRecentlySucceeded) {
      signals.push({
        key: "stripe-webhook-signature",
        label: "Stripe webhook signature",
        severity: "warn",
        detail: `Stripe events are being REJECTED pre-verification (${rejectCount} recent rejects) while no stripe-webhook success is recent — likely a rotated/wrong STRIPE_WEBHOOK_SECRET; payments/refunds/disputes may be silently not landing. Re-check the webhook signing secret.`,
        value: rejectCount,
      });
    }
  }

  // --- Resend webhook signature misconfiguration (Phase 24, rev 2 MAJOR 2 — mirrors FIX 4) -----
  // A persistent rotated/wrong RESEND_WEBHOOK_SECRET is otherwise INVISIBLE: real events reject
  // pre-verify (→ 'resend-webhook-rejected', in no catalog) while 'resend-webhook' stays ok/info.
  {
    // Gate on the secret actually being set (diff-review MEDIUM 1). The WARN means "the secret is
    // configured but wrong/rotated" — pre-verify rejects while no success is recent. When the
    // secret is UNSET the endpoint 503s (recorded under the distinct `resend-webhook-unconfigured`
    // key, which this block never reads), and config-preflight — not this WARN — is the surface
    // for the unconfigured state. Without this gate, an endpoint that was never configured (or a
    // scanner hitting it) would light a "rotated/wrong secret" WARN that has no such secret to fix.
    const secretConfigured = Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim());
    const rejected = jobByName.get("resend-webhook-rejected");
    const webhook = jobByName.get("resend-webhook");
    const rejectCount = rejected?.consecutiveFailures ?? 0;
    const rejectsFresh = rejected ? ageMs(nowMs, rejected.lastRunAt) <= RESEND_REJECT_FRESH_MS : false;
    const webhookRecentlySucceeded = webhook
      ? ageMs(nowMs, webhook.lastSuccessAt) <= RESEND_WEBHOOK_SUCCESS_FRESH_MS
      : false;
    if (secretConfigured && rejectsFresh && rejectCount >= RESEND_REJECT_MIN_COUNT && !webhookRecentlySucceeded) {
      signals.push({
        key: "resend-webhook-signature",
        label: "Resend webhook signature",
        severity: "warn",
        detail: `Resend bounce/complaint events are being REJECTED pre-verification (${rejectCount} recent rejects) while no resend-webhook success is recent — likely a rotated/wrong RESEND_WEBHOOK_SECRET; bounces/complaints may be silently not landing. Re-check the webhook signing secret.`,
        value: rejectCount,
      });
    }
  }

  // --- Email suppressions (Phase 24, §6 — INFO only; a suppression is healthy, expected --------
  // behavior, never an alert). Pure read over email_suppressions, wrapped best-effort like the
  // other blocks in this function so a read failure degrades to "signal skipped," never a throw.
  try {
    const rows = await db
      .select({ source: emailSuppressions.source, suppressedAt: emailSuppressions.suppressedAt })
      .from(emailSuppressions);
    const bySource = new Map<string, number>();
    let mostRecent: string | null = null;
    for (const row of rows) {
      const key = row.source ?? "unknown";
      bySource.set(key, (bySource.get(key) ?? 0) + 1);
      if (row.suppressedAt && (!mostRecent || row.suppressedAt > mostRecent)) mostRecent = row.suppressedAt;
    }
    const unsubscribeCount = bySource.get("unsubscribe_link") ?? 0;
    const bounceCount = bySource.get("bounce") ?? 0;
    const complaintCount = bySource.get("complaint") ?? 0;
    signals.push({
      key: "email-suppressions",
      label: "Email suppressions",
      severity: "info",
      detail: rows.length > 0
        ? `${rows.length} suppressed address(es) (unsubscribe ${unsubscribeCount}, bounce ${bounceCount}, complaint ${complaintCount}); most recent ${mostRecent ?? "unknown"}.`
        : "No suppressed email addresses on record.",
      value: rows.length,
    });
  } catch {
    // Best-effort; a read failure here must not affect any other signal.
  }

  // --- Backup freshness (non-required; missing → not-configured) ----------------------------
  {
    const row = jobByName.get("backup-d1");
    if (!row || !row.lastSuccessAt) {
      signals.push({
        key: "backup-d1",
        label: "D1 backup freshness",
        severity: "info",
        detail: "No backup heartbeat wired (optional). Authoritative gate remains deploy:preflight.",
        value: null,
      });
    } else {
      const stale = ageMs(nowMs, row.lastSuccessAt);
      signals.push({
        key: "backup-d1",
        label: "D1 backup freshness",
        severity: stale >= BACKUP_STALE_MS ? "warn" : "ok",
        detail: `Last D1 backup heartbeat ${row.lastSuccessAt}.`,
        value: row.lastSuccessAt,
      });
    }
  }

  // --- Reconciliation queues (money-critical) ----------------------------------------------
  try {
    const finance = await (options?.loadFinanceReport ?? getAgentFinanceReport)();
    const refunds = finance.reconciliation.refundInitiations;
    for (const stuck of refunds.stuckSubmitting) {
      signals.push({
        key: `refund-stuck:${stuck.initiationId}`,
        label: "Refund stuck in-flight",
        severity: "critical",
        detail: `Refund initiation ${stuck.initiationId} has been 'submitting' too long — money may have left the bank; reconcile against Stripe.`,
        value: stuck.amountCents,
        alertKey: `critical:refund_stuck:${stuck.initiationId}`,
      });
    }
    if (refunds.initiatedNotRecorded.length > 0) {
      signals.push({
        key: "refund-initiated-not-recorded",
        label: "Initiated refund not recorded",
        severity: "warn",
        detail: `${refunds.initiatedNotRecorded.length} succeeded refund initiation(s) with no matching payment_refunds row (webhook never landed).`,
        value: refunds.initiatedNotRecorded.length,
      });
    }
    const paymentCount = Number(finance.reconciliation.paymentCount ?? 0);
    if (paymentCount > 0) {
      signals.push({
        key: "payments-need-reconciliation",
        label: "Payments needing reconciliation",
        severity: "warn",
        detail: `${paymentCount} payment(s) need reconciliation (missing evidence / over-cap / open dispute).`,
        value: paymentCount,
      });
    }
  } catch {
    // FIX 5: a finance-read failure must NOT drop the money-critical refund tripwires to green or
    // silently resolve their active alerts. Surface as WARN (so overall is not green) and mark the
    // refund-stuck alert-key prefix DEGRADED so the resolve sweep skips it — a flapping read must
    // not re-email the same stuck refund every cycle, nor let a persistently failing read hide it.
    degradedAlertKeyPrefixes.push("critical:refund_stuck:");
    signals.push({
      key: "reconciliation",
      label: "Reconciliation queues",
      severity: "warn",
      detail:
        "Reconciliation report unavailable this run (finance read failed) — refund/reconciliation tripwires could NOT be evaluated; treated as DEGRADED (not green) and active refund alerts are held (not resolved). Retried next run.",
      value: null,
    });
  }

  // --- Sequence sends stuck / failed --------------------------------------------------------
  try {
    const stuckBefore = new Date(nowMs - SEQUENCE_STUCK_MS).toISOString();
    const stuckRows = await db
      .select({ id: sequenceSends.id })
      .from(sequenceSends)
      .where(and(eq(sequenceSends.status, "claimed"), lt(sequenceSends.firedAt, stuckBefore)));
    if (stuckRows.length > 0) {
      signals.push({
        key: "sequence-sends-stuck",
        label: "Sequence sends stuck",
        severity: "warn",
        detail: `${stuckRows.length} sequence send(s) 'claimed' longer than one run interval.`,
        value: stuckRows.length,
      });
    }
    const failedRows = await db
      .select({ id: sequenceSends.id })
      .from(sequenceSends)
      .where(eq(sequenceSends.status, "failed"));
    if (failedRows.length > 0) {
      signals.push({
        key: "sequence-sends-failed",
        label: "Sequence sends failed",
        severity: "warn",
        detail: `${failedRows.length} sequence send(s) in a failed (retry-exhausted) state.`,
        value: failedRows.length,
      });
    }
  } catch {
    // sequence tables absent → skip (nothing to report).
  }

  // --- SMS delivery failures (trailing window) ---------------------------------------------
  try {
    const rows = await db
      .select({ id: projectCommunications.id, deliveryStatus: projectCommunications.deliveryStatus, updatedAt: projectCommunications.updatedAt })
      .from(projectCommunications)
      .where(inArray(projectCommunications.deliveryStatus, [...TWILIO_FAILED_DELIVERY_STATES]));
    const recent = rows.filter((row) => ageMs(nowMs, row.updatedAt) <= SMS_FAILURE_WINDOW_MS);
    if (recent.length > 0) {
      signals.push({
        key: "sms-delivery-failures",
        label: "SMS delivery failures",
        severity: "warn",
        detail: `${recent.length} SMS message(s) in a Twilio failure state (failed/undelivered) in the trailing window.`,
        value: recent.length,
      });
    }
  } catch {
    // project_communications absent → skip.
  }

  // --- Dead-man's-switch advisory (§4.3) ----------------------------------------------------
  if (!deadmanPingUrl()) {
    signals.push({
      key: "deadman",
      label: "External dead-man ping",
      severity: "info",
      detail:
        "DEADMAN_PING_URL not set — the only layer that survives a full-stack death is NOT armed. Recommended: a free healthchecks.io 'expect a ping every 24h' check.",
      value: null,
    });
  }

  const overall: SystemHealthReport["overall"] = signals.some((s) => s.severity === "critical")
    ? "critical"
    : signals.some((s) => s.severity === "warn")
      ? "warn"
      : "green";

  return {
    generatedAt: now.toISOString(),
    overall,
    signals,
    degradedAlertKeyPrefixes: degradedAlertKeyPrefixes.length ? degradedAlertKeyPrefixes : undefined,
  };
}

// ---------------------------------------------------------------------------
// Digest body builder — built ONLY from whitelisted report fields (labels, severities, details,
// counts, ISO timestamps, cleaned error messages). It MUST NEVER interpolate process.env
// (secret-redaction test §8/6). last_error is already re-sanitized inside recordJobRun.
// ---------------------------------------------------------------------------
export function buildHealthDigest(report: SystemHealthReport, options?: { deadmanArmed?: boolean }): { subject: string; text: string } {
  const criticalCount = report.signals.filter((s) => s.severity === "critical").length;
  const warnCount = report.signals.filter((s) => s.severity === "warn").length;
  const subject =
    report.overall === "green"
      ? "Reese CRM Systems: all green"
      : report.overall === "critical"
        ? `Reese CRM Systems: ${criticalCount} CRITICAL, ${warnCount} warning`
        : `Reese CRM Systems: ${warnCount} warning`;

  const order: HealthSeverity[] = ["critical", "warn", "info", "ok"];
  const lines: string[] = [
    `Systems health digest — ${report.generatedAt}`,
    `Overall: ${report.overall.toUpperCase()}`,
    "",
  ];
  for (const severity of order) {
    const group = report.signals.filter((s) => s.severity === severity);
    if (!group.length) continue;
    lines.push(`${severity.toUpperCase()}:`);
    for (const signal of group) {
      lines.push(`  - ${signal.label}: ${signal.detail}`);
    }
    lines.push("");
  }
  lines.push("—");
  lines.push("If you did NOT receive today's Systems email, THAT is the alarm — the monitor is down. Investigate.");
  lines.push(`External dead-man ping: ${options?.deadmanArmed ? "armed" : "NOT armed — recommended, see phase-21 §4.3"}.`);
  return { subject, text: lines.join("\n") };
}

// Selector for the immediate-critical scan (§4.4): the CRITICAL signals that carry an alertKey.
export function criticalAlertSignals(report: SystemHealthReport): HealthSignal[] {
  return report.signals.filter((s) => s.severity === "critical" && Boolean(s.alertKey));
}
