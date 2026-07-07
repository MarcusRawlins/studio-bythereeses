// Phase 21 — the tiny shared heartbeat helper. Every autonomous background job writes one
// upserted row to job_runs on each run (success OR failure); the digest + /api/agent/health
// + /system-status read it. NON-CANONICAL: recordJobRun writes ONLY job_runs — never a
// business record, never money. recordJobRun is imported ONLY by the job entry points (the 6
// wired routes + the monitor route). NO agent/MCP export of the WRITE. (The pure, side-effect-free
// helper redactSecretEnvValues is also imported by the Phase 18 narration route to reuse the exact
// SECRET_ENV_NAMES redaction — a read-only sanitizer, not a job-runs write.)
//
// Invariants (spec §2.2):
//   - NEVER throws into the monitored job. The write is wrapped in try/catch that swallows
//     (like logActivity's audit-fail swallow). If the heartbeat write itself fails,
//     last_success_at simply stops advancing → the job reads STALE → the digest alerts.
//     That is the correct fail-toward-visible behavior.
//   - Recording a failure NEVER converts a failure into success. Callers record the outcome
//     and then preserve the original HTTP status / re-raise (enforced at each call site).
//   - error is re-sanitized HERE (defense-in-depth) — the ≤500-char cap + secret redaction
//     run inside recordJobRun, never trusting the caller to pre-clean. last_error feeds the
//     digest, so it must not carry a raw secret or an unbounded blob.
//   - No db.transaction()/db.batch() (D1 rejects them). One INSERT ... ON CONFLICT upsert.

import { db } from "@/db/client";
import { jobRuns } from "@/db/schema";
import { inArray, sql } from "drizzle-orm";

const MAX_ERROR_LEN = 500;

// The process-env secret NAMES whose VALUES must never land in last_error (which feeds the
// digest email). We redact the literal value if it appears in a caller-supplied message.
const SECRET_ENV_NAMES = [
  "RESEND_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "CRON_SECRET",
  "SCHEDULER_LINK_SECRET",
  "STUDIO_AGENT_API_TOKEN",
  "ORIGIN_PROXY_SECRET",
  "ADMIN_SESSION_SECRET",
  "TWILIO_AUTH_TOKEN",
  "INBOUND_INTAKE_SECRET",
  // Phase 24 (rev 2 note tied to MINOR 9): mandatory, not optional — a leaked webhook secret in a
  // stored error message is exactly the class of mistake SECRET_ENV_NAMES exists to prevent.
  "RESEND_WEBHOOK_SECRET",
] as const;

// Phase 18 (§3.3, finding A-3): the secret-VALUE redaction loop, extracted so a second caller
// (the daily-brief narration handler) can reuse it verbatim instead of re-implementing it — a
// hand-duplicated copy would silently drift from SECRET_ENV_NAMES the next time a secret is added.
export function redactSecretEnvValues(value: string): string {
  let text = value;
  for (const name of SECRET_ENV_NAMES) {
    const secret = process.env[name]?.trim();
    if (secret && secret.length >= 4) {
      text = text.split(secret).join("[redacted]");
    }
  }
  return text;
}

// Defense-in-depth: strip any configured secret value out of the message, then cap. A future
// careless caller that interpolates a secret into an error string cannot persist it here.
export function sanitizeJobRunError(value: string | null | undefined): string | null {
  let text = typeof value === "string" ? value : "";
  if (!text.trim()) return null;
  text = redactSecretEnvValues(text);
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, MAX_ERROR_LEN) : null;
}

export type JobName =
  | "scheduler-reminders"
  | "sequence-runner"
  | "systems-monitor"
  | "stripe-webhook"
  | "twilio-status"
  | "twilio-inbound"
  | "inbound-inquiry"
  | "backup-d1"
  // A separate, NON-ALERTING key for pre-verification Stripe signature rejects — kept OUT of
  // the CRITICAL catalog so a scanner spamming bad signatures cannot grief the money-drift alert.
  | "stripe-webhook-rejected"
  // Phase 24 (CR-6) — the Resend bounce/complaint webhook. Event-driven, WARN-only (never
  // CRITICAL): a failing bounce webhook degrades deliverability hygiene, not money state.
  | "resend-webhook"
  // A separate, NON-ALERTING key for pre-verification Resend/SVIX signature rejects (I5) — kept
  // OUT of the health catalog so a scanner spamming bad signatures cannot grief the real counter.
  | "resend-webhook-rejected"
  // A DISTINCT non-alerting key for the unset-secret 503 (diff-review MEDIUM 1). Deliberately NOT
  // read by the `resend-webhook-signature` misconfiguration WARN: an unconfigured endpoint (or a
  // scanner hitting one) must not masquerade as a "rotated/wrong secret" alert — the unconfigured
  // state is surfaced by config-preflight instead.
  | "resend-webhook-unconfigured"
  // Phase 19 (MEDIUM-5): a visibility counter for when the GLOBAL inbound_inquiries hourly insert
  // cap trips during web-form ingest. isRateLimited counts ALL inbound rows regardless of source,
  // so a web-form flood can push the global count to GLOBAL_HOURLY_INSERT_CAP, after which genuine
  // EMAIL inquiries are auto-marked spam. Recording this (instead of letting it stay silent) makes
  // a cross-channel starvation event visible. NON-ALERTING (not in the health catalog) — a raw
  // counter/heartbeat, a follow-up (per-source scoping) is deferred unless it fires in practice.
  | "lead-form-global-flood";

export type JobRunRecord = {
  jobName: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  updatedAt: string;
};

export async function recordJobRun(name: JobName, ok = true, error?: string | null): Promise<void> {
  try {
    const now = new Date().toISOString();
    if (ok) {
      // On ok, `error` (when passed) is a NON-fatal ADVISORY note (e.g. the reminders
      // transient partial-send blip: failed>0 && sent>0 — the job DID succeed and self-heals,
      // but computeSystemHealth surfaces the advisory as WARN). last_success_at still advances
      // and consecutive_failures resets to 0; only last_status stays 'ok'. Sanitized like any
      // other message. NULL when no advisory is passed (the common full-success case).
      const advisory = sanitizeJobRunError(error);
      await db
        .insert(jobRuns)
        .values({
          jobName: name,
          lastRunAt: now,
          lastSuccessAt: now,
          lastStatus: "ok",
          lastError: advisory,
          consecutiveFailures: 0,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: jobRuns.jobName,
          set: {
            lastRunAt: now,
            lastSuccessAt: now,
            lastStatus: "ok",
            lastError: advisory,
            consecutiveFailures: 0,
            updatedAt: now,
          },
        });
      return;
    }

    const cleaned = sanitizeJobRunError(error);
    await db
      .insert(jobRuns)
      .values({
        jobName: name,
        lastRunAt: now,
        // last_success_at intentionally NOT set on a failure — staleness keeps clocking from
        // the last real success.
        lastStatus: "error",
        lastError: cleaned,
        consecutiveFailures: 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: jobRuns.jobName,
        set: {
          lastRunAt: now,
          lastStatus: "error",
          lastError: cleaned,
          consecutiveFailures: sql`${jobRuns.consecutiveFailures} + 1`,
          updatedAt: now,
        },
      });
  } catch {
    // Swallow — the heartbeat must never throw into (or mask) the monitored job. A failed
    // write simply leaves last_success_at un-advanced → the job reads stale → digest alerts.
  }
}

// Reader for the monitor / health surfaces. Pure read; never throws (returns [] on error).
export async function readJobRuns(names?: readonly string[]): Promise<JobRunRecord[]> {
  try {
    const rows = names && names.length
      ? await db.select().from(jobRuns).where(inArray(jobRuns.jobName, [...names]))
      : await db.select().from(jobRuns);
    return rows.map((row) => ({
      jobName: row.jobName,
      lastRunAt: row.lastRunAt ?? null,
      lastSuccessAt: row.lastSuccessAt ?? null,
      lastStatus: row.lastStatus ?? null,
      lastError: row.lastError ?? null,
      consecutiveFailures: row.consecutiveFailures ?? 0,
      updatedAt: row.updatedAt,
    }));
  } catch {
    return [];
  }
}

export async function readJobRun(name: string): Promise<JobRunRecord | null> {
  const rows = await readJobRuns([name]);
  return rows[0] ?? null;
}
