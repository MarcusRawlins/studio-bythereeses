import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 21 §8 tests 2, 2b, 3, 4, 6 — computeSystemHealth thresholds, the missing-required-row
// branch, "ran but sent nothing", healthy-green, a critical refund tripwire, and the digest
// secret-redaction guard.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-system-health-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
delete process.env.RESEND_API_KEY;
delete process.env.DEADMAN_PING_URL;

const NOW = new Date("2026-07-07T12:00:00.000Z");
const ENABLED_AT = "2026-07-06T00:00:00.000Z"; // > any critical window ago

function iso(msAgo: number) {
  return new Date(NOW.getTime() - msAgo).toISOString();
}
const HOUR = 60 * 60 * 1000;

async function main() {
  const { rawDb } = await import("@/db/client");
  const { computeSystemHealth, buildHealthDigest } = await import("@/lib/system-health");
  const db = rawDb();

  function upsertJobRun(name: string, fields: Record<string, unknown>) {
    db.prepare("DELETE FROM job_runs WHERE job_name = ?").run(name);
    db.prepare(
      `INSERT INTO job_runs (job_name, last_run_at, last_success_at, last_status, last_error, consecutive_failures, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      name,
      fields.lastRunAt ?? null,
      fields.lastSuccessAt ?? null,
      fields.lastStatus ?? null,
      fields.lastError ?? null,
      fields.consecutiveFailures ?? 0,
      fields.updatedAt ?? NOW.toISOString(),
    );
  }

  function findSignal(signals: Awaited<ReturnType<typeof computeSystemHealth>>["signals"], key: string) {
    return signals.find((s) => s.key === key);
  }

  // ---- test 2: staleness thresholds for a REQUIRED job (scheduler-reminders) ----
  upsertJobRun("scheduler-reminders", { lastRunAt: iso(7 * HOUR), lastSuccessAt: iso(7 * HOUR), lastStatus: "ok" });
  let report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  assert.equal(findSignal(report.signals, "scheduler-reminders")!.severity, "critical", "7h stale → CRITICAL");

  upsertJobRun("scheduler-reminders", { lastRunAt: iso(3 * HOUR), lastSuccessAt: iso(3 * HOUR), lastStatus: "ok" });
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  assert.equal(findSignal(report.signals, "scheduler-reminders")!.severity, "warn", "3h stale → WARN");

  upsertJobRun("scheduler-reminders", { lastRunAt: iso(30 * 60 * 1000), lastSuccessAt: iso(30 * 60 * 1000), lastStatus: "ok" });
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  assert.equal(findSignal(report.signals, "scheduler-reminders")!.severity, "ok", "30 min → ok/green");

  // ---- test 2 missing-row: a required job with NO row is maximally stale (not green) ----
  db.prepare("DELETE FROM job_runs").run();
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  for (const name of ["scheduler-reminders", "sequence-runner", "systems-monitor"]) {
    const sig = findSignal(report.signals, name)!;
    assert.ok(sig.severity === "critical" || sig.severity === "warn", `${name} missing row → maximally stale, not green`);
    assert.notEqual(sig.severity, "info", `${name} missing row must NOT render not-configured`);
  }
  // Contrast: a missing NON-required job row → not-configured INFO (no alarm).
  assert.equal(findSignal(report.signals, "stripe-webhook")!.severity, "info", "missing stripe-webhook row → not-configured INFO");
  assert.equal(findSignal(report.signals, "backup-d1")!.severity, "info", "missing backup-d1 row → not-configured INFO");

  // ---- test 2b: reminders "ran but sent nothing" → FAILURE; transient blip → WARN ----
  db.prepare("DELETE FROM job_runs").run();
  // Fresh last_run_at but a recorded FAILURE (due>0, sent=0).
  upsertJobRun("scheduler-reminders", {
    lastRunAt: iso(5 * 60 * 1000),
    lastSuccessAt: iso(3 * HOUR),
    lastStatus: "error",
    lastError: "Reminders ran but sent nothing: 2 due, 2 failed to deliver.",
    consecutiveFailures: 1,
  });
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  const sig = findSignal(report.signals, "scheduler-reminders")!;
  assert.ok(sig.severity === "warn" || sig.severity === "critical", "ran-but-sent-nothing (fresh run) → failing, not green");

  // Escalation via consecutive_failures.
  upsertJobRun("scheduler-reminders", {
    lastRunAt: iso(5 * 60 * 1000),
    lastSuccessAt: iso(3 * HOUR),
    lastStatus: "error",
    lastError: "Reminders ran but sent nothing.",
    consecutiveFailures: 3,
  });
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  assert.equal(findSignal(report.signals, "scheduler-reminders")!.severity, "critical", "3 consecutive failures → CRITICAL");

  // Transient blip: recorded ok WITH an advisory note, fresh success → WARN self-healing.
  upsertJobRun("scheduler-reminders", {
    lastRunAt: iso(5 * 60 * 1000),
    lastSuccessAt: iso(5 * 60 * 1000),
    lastStatus: "ok",
    lastError: "Transient: 1 of 2 reminders failed to deliver (retries next hour).",
    consecutiveFailures: 0,
  });
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  assert.equal(findSignal(report.signals, "scheduler-reminders")!.severity, "warn", "transient blip → WARN only (self-healing)");

  // ---- test 3: healthy run → green + all-green digest subject ----
  db.prepare("DELETE FROM job_runs").run();
  for (const name of ["scheduler-reminders", "sequence-runner", "systems-monitor"]) {
    upsertJobRun(name, { lastRunAt: iso(5 * 60 * 1000), lastSuccessAt: iso(5 * 60 * 1000), lastStatus: "ok" });
  }
  process.env.DEADMAN_PING_URL = "https://hc-ping.example/abc"; // arm so the advisory INFO drops
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  assert.equal(report.overall, "green", "all fresh + zero reconciliation → green");
  const greenDigest = buildHealthDigest(report, { deadmanArmed: true });
  assert.match(greenDigest.subject, /all green/i, "green digest subject is the all-green line");
  delete process.env.DEADMAN_PING_URL;

  // ---- test 4: a stuck-submitting refund → CRITICAL signal; >24h not-recorded → WARN only ----
  // Seed the minimal FK chain (foreign_keys is ON).
  db.prepare("INSERT INTO projects (id, name) VALUES ('proj-1','Test Project')").run();
  db.prepare("INSERT INTO invoices (id, project_id, invoice_number) VALUES ('inv-1','proj-1','INV-1')").run();
  db.prepare("INSERT INTO invoice_payments (id, invoice_id, label) VALUES ('pay-1','inv-1','Balance')").run();
  // Use a fixed far-past timestamp: getAgentFinanceReport's refund tripwires clock from the real
  // wall clock (not our injected NOW), so anchor well in the past to be stuck regardless.
  db.prepare(
    `INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at)
     VALUES ('ri-stuck','pay-1', 5000, 'usd', 'submitting', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
  ).run(); // submitting >> 1h → stuck
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  const stuck = report.signals.find((s) => s.key.startsWith("refund-stuck:"));
  assert.ok(stuck, "stuck refund produces a signal");
  assert.equal(stuck!.severity, "critical", "stuck submitting refund → CRITICAL");
  assert.ok(stuck!.alertKey?.startsWith("critical:refund_stuck:"), "critical signal carries a stable alert key");
  assert.equal(report.overall, "critical", "a critical signal makes the overall report critical");

  // A >24h succeeded-not-recorded refund is WARN only (no critical).
  db.prepare("DELETE FROM refund_initiations").run();
  db.prepare(
    `INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, stripe_refund_id, created_at, updated_at)
     VALUES ('ri-nr','pay-1', 5000, 'usd', 'succeeded', 're_notrecorded', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
  ).run();
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  assert.ok(!report.signals.some((s) => s.key.startsWith("refund-stuck:")), "no stuck-submitting signal now");
  const nr = findSignal(report.signals, "refund-initiated-not-recorded");
  assert.ok(nr && nr.severity === "warn", "initiated-not-recorded → WARN");

  // ---- test 6: digest body never contains process.env secret values ----
  process.env.RESEND_API_KEY = "re_secretkey_should_not_appear";
  process.env.STRIPE_SECRET_KEY = "sk_live_should_not_appear";
  process.env.CRON_SECRET = "cron_should_not_appear";
  process.env.STUDIO_AGENT_API_TOKEN = "agenttok_should_not_appear";
  const pollutedReport = {
    generatedAt: NOW.toISOString(),
    overall: "warn" as const,
    signals: [
      {
        key: "twilio-status",
        label: "Twilio status webhook",
        severity: "warn" as const,
        // last_error is already sanitized inside recordJobRun; the digest builder must not
        // re-introduce any env secret either.
        detail: "Twilio status webhook failing: 5 consecutive failures. cleaned message",
        value: 5,
      },
    ],
  };
  const digest = buildHealthDigest(pollutedReport, { deadmanArmed: false });
  for (const secret of [
    process.env.RESEND_API_KEY,
    process.env.STRIPE_SECRET_KEY,
    process.env.CRON_SECRET,
    process.env.STUDIO_AGENT_API_TOKEN,
  ]) {
    assert.ok(!digest.text.includes(secret!), `digest must not contain the secret value ${secret}`);
    assert.ok(!digest.subject.includes(secret!), "digest subject must not contain a secret value");
  }

  // ---- FIX 3: a required job frozen at last_status=error STILL escalates on staleness ----
  db.prepare("DELETE FROM job_runs").run();
  db.prepare("DELETE FROM refund_initiations").run();
  // error, only 1 consecutive failure (would be WARN on failures alone), but last success 7h ago.
  upsertJobRun("scheduler-reminders", {
    lastRunAt: iso(5 * 60 * 1000),
    lastSuccessAt: iso(7 * HOUR),
    lastStatus: "error",
    lastError: "frozen at consecutive_failures:1",
    consecutiveFailures: 1,
  });
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  assert.equal(
    findSignal(report.signals, "scheduler-reminders")!.severity,
    "critical",
    "error branch + last success 7h ago → CRITICAL via staleness, not frozen at WARN",
  );
  // Contrast: the same error but a FRESH last success stays WARN (error-derived only).
  upsertJobRun("scheduler-reminders", {
    lastRunAt: iso(5 * 60 * 1000),
    lastSuccessAt: iso(30 * 60 * 1000),
    lastStatus: "error",
    lastError: "recent error",
    consecutiveFailures: 1,
  });
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  assert.equal(findSignal(report.signals, "scheduler-reminders")!.severity, "warn", "error + fresh success → WARN");

  // ---- FIX 4: Stripe signature misconfiguration WARNs; a benign scanner probe does NOT ----
  // Misconfig pattern: recent + repeated rejects, no recent stripe-webhook success (absent here).
  db.prepare("DELETE FROM job_runs").run();
  upsertJobRun("stripe-webhook-rejected", { lastRunAt: iso(5 * 60 * 1000), lastStatus: "error", lastError: "sig", consecutiveFailures: 8 });
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  const misconfig = findSignal(report.signals, "stripe-webhook-signature");
  assert.ok(misconfig && misconfig.severity === "warn", "persistent recent rejects + no recent success → WARN");

  // Benign one-off scanner probe: a single, STALE reject with a healthy recent success → no warn.
  db.prepare("DELETE FROM job_runs").run();
  upsertJobRun("stripe-webhook-rejected", { lastRunAt: iso(10 * HOUR), lastStatus: "error", lastError: "sig", consecutiveFailures: 1 });
  upsertJobRun("stripe-webhook", { lastRunAt: iso(30 * 60 * 1000), lastSuccessAt: iso(30 * 60 * 1000), lastStatus: "ok" });
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  assert.ok(!findSignal(report.signals, "stripe-webhook-signature"), "one-off stale reject + healthy recent success → NO warn");

  // Active scanner (recent, repeated rejects) but a healthy recent success (secret is fine) → no warn.
  db.prepare("DELETE FROM job_runs").run();
  upsertJobRun("stripe-webhook-rejected", { lastRunAt: iso(5 * 60 * 1000), lastStatus: "error", lastError: "sig", consecutiveFailures: 8 });
  upsertJobRun("stripe-webhook", { lastRunAt: iso(30 * 60 * 1000), lastSuccessAt: iso(30 * 60 * 1000), lastStatus: "ok" });
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  assert.ok(!findSignal(report.signals, "stripe-webhook-signature"), "recent rejects but healthy recent success → NO warn (discriminator is a stale/absent success)");

  // ---- FIX 5: a finance-read failure → WARN (not green) + refund alert-key prefix degraded ----
  db.prepare("DELETE FROM job_runs").run();
  db.prepare("DELETE FROM refund_initiations").run();
  for (const name of ["scheduler-reminders", "sequence-runner", "systems-monitor"]) {
    upsertJobRun(name, { lastRunAt: iso(5 * 60 * 1000), lastSuccessAt: iso(5 * 60 * 1000), lastStatus: "ok" });
  }
  process.env.DEADMAN_PING_URL = "https://hc-ping.example/abc"; // arm so its INFO advisory drops
  report = await computeSystemHealth({
    now: NOW,
    requiredJobEnabledAt: ENABLED_AT,
    loadFinanceReport: async () => {
      throw new Error("finance read down");
    },
  });
  delete process.env.DEADMAN_PING_URL;
  const recon = findSignal(report.signals, "reconciliation");
  assert.ok(recon && recon.severity === "warn", "finance read failure → WARN reconciliation signal (not INFO)");
  assert.notEqual(report.overall, "green", "a degraded finance read must NOT render green");
  assert.equal(report.overall, "warn", "degraded finance read → overall WARN");
  assert.ok(
    (report.degradedAlertKeyPrefixes ?? []).includes("critical:refund_stuck:"),
    "refund alert-key prefix marked degraded so the resolve sweep skips it",
  );

  // ---- MINOR: a FUTURE / unparseable required-since must not render a missing job green ----
  db.prepare("DELETE FROM job_runs").run();
  const FUTURE = new Date(NOW.getTime() + 5 * 24 * HOUR).toISOString();
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: FUTURE });
  for (const name of ["scheduler-reminders", "sequence-runner", "systems-monitor"]) {
    assert.equal(
      findSignal(report.signals, name)!.severity,
      "critical",
      `${name} missing row + FUTURE since-date → maximally stale CRITICAL, not green (fail-toward-visible)`,
    );
  }
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: "not-a-real-date" });
  assert.equal(
    findSignal(report.signals, "scheduler-reminders")!.severity,
    "critical",
    "unparseable since-date fails toward CRITICAL (preserved behavior)",
  );

  // ---- Phase 25 (§3.4, tests 18-19) — cap-tripped signal severity + not-configured branch ----
  // Reset job_runs to a healthy baseline first (prior tests above left required-job rows deleted /
  // future-dated on purpose) so the assertions below isolate THIS signal's own severity.
  db.prepare("DELETE FROM job_runs").run();
  db.prepare("DELETE FROM refund_initiations").run();
  for (const name of ["scheduler-reminders", "sequence-runner", "systems-monitor"]) {
    upsertJobRun(name, { lastRunAt: iso(5 * 60 * 1000), lastSuccessAt: iso(5 * 60 * 1000), lastStatus: "ok" });
  }
  upsertJobRun("sequences-daily-cap-tripped", {
    lastRunAt: iso(5 * 60 * 1000),
    lastStatus: "error",
    lastError: "12 auto-sends in the trailing 24h reached the SEQUENCES_DAILY_SEND_CAP of 10",
    consecutiveFailures: 1,
  });
  // Flag ON + tripped row -> WARN, never critical.
  process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED = "1";
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  const capSignal = findSignal(report.signals, "sequences-daily-cap-tripped");
  assert.ok(capSignal, "a recorded cap-tripped heartbeat produces a signal while the flag is on");
  assert.equal(capSignal!.severity, "warn", "cap-tripped heartbeat -> WARN, never critical");
  assert.notEqual(report.overall, "critical", "a WARN-only cap signal must never make the overall report critical by itself");

  // Diff-review Finding 2: flag turned OFF while the last row is still the tripped ok:false —
  // WITHOUT the flag gate this would WARN indefinitely (the self-reset only runs while the flag is
  // on, so the row can never clear). With the gate, the signal is ABSENT entirely: the feature is
  // off, so its backstop stops reporting.
  delete process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED;
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  assert.equal(
    findSignal(report.signals, "sequences-daily-cap-tripped"),
    undefined,
    "flag off + a stale tripped row -> signal absent (never a frozen indefinite WARN)",
  );

  // Flag ON + no heartbeat row at all -> not-configured (info), via the existing WEBHOOK_JOBS
  // missing-row branch — reachable INDEFINITELY, not just on a fresh install (MINOR 8/12).
  process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED = "1";
  db.prepare("DELETE FROM job_runs WHERE job_name = 'sequences-daily-cap-tripped'").run();
  for (let i = 0; i < 3; i += 1) {
    report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
    assert.equal(
      findSignal(report.signals, "sequences-daily-cap-tripped")!.severity,
      "info",
      "flag on, no heartbeat row -> not-configured INFO, reachable across repeated computeSystemHealth calls",
    );
  }
  delete process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED;

  // ---- Phase 25 (§3.5, tests 20-24) — bounce/complaint-rate signal (trailing 7 days) ----
  function seedSuppression(email: string, source: string, msAgo: number) {
    db.prepare("INSERT INTO email_suppressions (email, suppressed_at, source) VALUES (?, ?, ?)").run(email, iso(msAgo), source);
  }
  const DAY = 24 * HOUR;

  // test 20: below threshold -> ok, value 2.
  db.prepare("DELETE FROM email_suppressions").run();
  seedSuppression("bounce1@example.com", "bounce", 1 * DAY);
  seedSuppression("bounce2@example.com", "bounce", 2 * DAY);
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  let bc = findSignal(report.signals, "email-bounce-complaint-rate-7d");
  assert.ok(bc, "bounce/complaint-rate signal present");
  assert.equal(bc!.severity, "ok", "2 bounces, 0 complaints -> below threshold -> ok");
  assert.equal(bc!.value, 2);

  // test 21: combined bounce+complaint threshold (>=5) -> warn.
  db.prepare("DELETE FROM email_suppressions").run();
  for (let i = 0; i < 3; i += 1) seedSuppression(`bounce-combo-${i}@example.com`, "bounce", 1 * DAY);
  for (let i = 0; i < 2; i += 1) seedSuppression(`complaint-combo-${i}@example.com`, "complaint", 1 * DAY);
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  bc = findSignal(report.signals, "email-bounce-complaint-rate-7d");
  assert.equal(bc!.severity, "warn", "3 bounce + 2 complaint (combined 5) -> warn");
  assert.equal(bc!.value, 5);

  // test 22: a single complaint ALONE trips warn, independent of the combined threshold.
  db.prepare("DELETE FROM email_suppressions").run();
  seedSuppression("solo-complaint@example.com", "complaint", 1 * DAY);
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  bc = findSignal(report.signals, "email-bounce-complaint-rate-7d");
  assert.equal(bc!.severity, "warn", "a single complaint alone -> warn (complaint-alone threshold)");
  assert.equal(bc!.value, 1);

  // test 23: window boundary — exactly 8 days old is excluded; 6 days old is included.
  db.prepare("DELETE FROM email_suppressions").run();
  seedSuppression("old-8d@example.com", "bounce", 8 * DAY);
  seedSuppression("recent-6d@example.com", "bounce", 6 * DAY);
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  bc = findSignal(report.signals, "email-bounce-complaint-rate-7d");
  assert.equal(bc!.value, 1, "an 8-day-old suppression is excluded from the trailing-7-day window; a 6-day-old one is included");

  // test 24: a read failure degrades to signal-skipped, not a thrown page (best-effort, mirrors
  // every other block in computeSystemHealth).
  db.exec("ALTER TABLE email_suppressions RENAME TO email_suppressions_test24_bak");
  let degradedReport: Awaited<ReturnType<typeof computeSystemHealth>> | undefined;
  try {
    degradedReport = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  } finally {
    db.exec("ALTER TABLE email_suppressions_test24_bak RENAME TO email_suppressions");
  }
  assert.ok(degradedReport, "computeSystemHealth must still return a report when the email_suppressions read throws");
  assert.ok(
    !findSignal(degradedReport.signals, "email-bounce-complaint-rate-7d"),
    "bounce/complaint-rate signal is simply absent that cycle on a read failure, not a thrown page",
  );

  // test 25: the EXISTING lifetime email-suppressions signal (Phase 24) is unchanged — additive,
  // not a rewrite. Same key, severity ("info"), and detail shape as before this phase.
  db.prepare("DELETE FROM email_suppressions").run();
  seedSuppression("lifetime-check@example.com", "unsubscribe_link", 1 * DAY);
  report = await computeSystemHealth({ now: NOW, requiredJobEnabledAt: ENABLED_AT });
  const lifetimeSignal = findSignal(report.signals, "email-suppressions");
  assert.ok(lifetimeSignal, "the Phase-24 lifetime email-suppressions signal must still exist");
  assert.equal(lifetimeSignal!.severity, "info", "the lifetime signal's severity stays info — untouched by this phase");
  assert.match(
    lifetimeSignal!.detail,
    /^1 suppressed address\(es\) \(unsubscribe 1, bounce 0, complaint 0\); most recent .+\.$/,
    "the lifetime signal's detail shape is byte-identical to before this phase",
  );

  console.log("system-health tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
