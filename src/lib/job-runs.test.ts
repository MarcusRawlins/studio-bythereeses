import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 21 §8 test 1 — recordJobRun upsert semantics + defense-in-depth secret redaction.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-job-runs-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.CRON_SECRET = "supersecretcronvalue-abc123";
delete process.env.RESEND_API_KEY;

async function main() {
  const { recordJobRun, readJobRun, sanitizeJobRunError } = await import("./job-runs");

  // First ok inserts: consecutive_failures=0, last_success_at set, last_error null.
  await recordJobRun("stripe-webhook", true);
  let row = await readJobRun("stripe-webhook");
  assert.ok(row, "row exists after first ok");
  assert.equal(row!.consecutiveFailures, 0);
  assert.equal(row!.lastStatus, "ok");
  assert.equal(row!.lastError, null);
  assert.ok(row!.lastSuccessAt, "last_success_at is set on ok");
  const firstSuccessAt = row!.lastSuccessAt;

  // A fail sets error, increments consecutive_failures, sets last_error, and does NOT touch
  // last_success_at.
  await recordJobRun("stripe-webhook", false, "processing blew up");
  row = await readJobRun("stripe-webhook");
  assert.equal(row!.lastStatus, "error");
  assert.equal(row!.consecutiveFailures, 1);
  assert.equal(row!.lastError, "processing blew up");
  assert.equal(row!.lastSuccessAt, firstSuccessAt, "last_success_at unchanged by a fail");

  // Second consecutive fail increments again.
  await recordJobRun("stripe-webhook", false, "blew up again");
  row = await readJobRun("stripe-webhook");
  assert.equal(row!.consecutiveFailures, 2);

  // A following ok resets failures to 0 and clears last_error; advances last_success_at.
  await recordJobRun("stripe-webhook", true);
  row = await readJobRun("stripe-webhook");
  assert.equal(row!.consecutiveFailures, 0);
  assert.equal(row!.lastStatus, "ok");
  assert.equal(row!.lastError, null);
  assert.ok(row!.lastSuccessAt, "last_success_at present after recovery");

  // Advisory-on-ok (reminders transient blip): stored in last_error but last_status stays ok
  // and failures stay 0.
  await recordJobRun("scheduler-reminders", true, "Transient: 1 of 2 reminders failed to deliver.");
  const remRow = await readJobRun("scheduler-reminders");
  assert.equal(remRow!.lastStatus, "ok");
  assert.equal(remRow!.consecutiveFailures, 0);
  assert.equal(remRow!.lastError, "Transient: 1 of 2 reminders failed to deliver.");

  // Secret redaction runs INSIDE recordJobRun (defense-in-depth) — a caller that leaks a secret
  // value cannot land it in last_error.
  await recordJobRun("twilio-status", false, "auth failed with token supersecretcronvalue-abc123 rejected");
  const twRow = await readJobRun("twilio-status");
  assert.ok(twRow!.lastError, "error recorded");
  assert.ok(!twRow!.lastError!.includes("supersecretcronvalue-abc123"), "secret value must be redacted from last_error");
  assert.ok(twRow!.lastError!.includes("[redacted]"), "redaction marker present");

  // sanitizeJobRunError caps at 500 chars.
  const long = "x".repeat(1200);
  const capped = sanitizeJobRunError(long);
  assert.equal(capped!.length, 500, "error message capped at 500 chars");
  assert.equal(sanitizeJobRunError(""), null);
  assert.equal(sanitizeJobRunError(null), null);

  console.log("job-runs tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
