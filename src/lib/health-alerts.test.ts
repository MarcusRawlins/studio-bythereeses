import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 21 §8 tests 4 (immediate-alert selector), 5 (dedupe + re-arm), 10 (sendAdminAlertEmail
// targeting is always ALERT_EMAIL, never a client-derived address).
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-health-alerts-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
delete process.env.RESEND_API_KEY;
delete process.env.ALERT_EMAIL;

type Report = Awaited<ReturnType<typeof import("@/lib/system-health").computeSystemHealth>>;

function criticalReport(): Report {
  return {
    generatedAt: "2026-07-07T12:00:00.000Z",
    overall: "critical",
    signals: [
      {
        key: "refund-stuck:ri-1",
        label: "Refund stuck in-flight",
        severity: "critical",
        detail: "Refund initiation ri-1 stuck submitting.",
        value: 5000,
        alertKey: "critical:refund_stuck:ri-1",
      },
      {
        key: "refund-initiated-not-recorded",
        label: "Initiated refund not recorded",
        severity: "warn",
        detail: "1 succeeded initiation not recorded.",
        value: 1,
      },
    ],
  };
}

function emptyReport(): Report {
  return { generatedAt: "2026-07-07T13:00:00.000Z", overall: "green", signals: [] };
}

async function main() {
  const { processImmediateCriticalAlerts } = await import("@/lib/health-alerts");
  const { criticalAlertSignals } = await import("@/lib/system-health");

  // ---- test 4: the selector picks ONLY critical signals with an alert key ----
  const selected = criticalAlertSignals(criticalReport());
  assert.equal(selected.length, 1, "only the critical signal is selected (the WARN is not)");
  assert.equal(selected[0].alertKey, "critical:refund_stuck:ri-1");

  const sent: Array<{ subject: string; text: string }> = [];
  const send = async (input: { subject: string; text: string }) => {
    sent.push(input);
    return true;
  };

  // First sighting → emails once; the WARN is NOT emailed.
  let result = await processImmediateCriticalAlerts({ report: criticalReport(), send });
  assert.deepEqual(result.emailedKeys, ["critical:refund_stuck:ri-1"], "critical emailed on first sight");
  assert.equal(sent.length, 1, "exactly one email (the WARN did not trigger an immediate alert)");

  // ---- test 5: dedupe — same condition again emails ZERO more times ----
  result = await processImmediateCriticalAlerts({ report: criticalReport(), send });
  assert.deepEqual(result.emailedKeys, [], "second sight of the same condition does not re-email");
  assert.equal(sent.length, 1, "still exactly one email total");

  // Condition clears → marked resolved (re-arms).
  result = await processImmediateCriticalAlerts({ report: emptyReport(), send });
  assert.ok(result.resolvedKeys.includes("critical:refund_stuck:ri-1"), "cleared condition is resolved");

  // Recurrence after resolve → re-arms and emails again.
  result = await processImmediateCriticalAlerts({ report: criticalReport(), send });
  assert.deepEqual(result.emailedKeys, ["critical:refund_stuck:ri-1"], "recurrence after resolve re-arms + emails");
  assert.equal(sent.length, 2, "two emails total (first sight + re-arm)");

  // ---- FIX 1: a critical email that FAILS to deliver is NOT permanently deduped away ----
  const { rawDb } = await import("@/db/client");
  const database = rawDb();
  function fix1Report(): Report {
    return {
      generatedAt: "2026-07-07T14:00:00.000Z",
      overall: "critical",
      signals: [
        {
          key: "refund-stuck:fix1",
          label: "Refund stuck in-flight",
          severity: "critical",
          detail: "Refund initiation fix1 stuck submitting.",
          value: 1,
          alertKey: "critical:refund_stuck:fix1",
        },
      ],
    };
  }
  const lastSentOf = (key: string) =>
    (database.prepare("SELECT last_sent_at AS v FROM health_alerts WHERE alert_key = ?").get(key) as { v: string | null } | undefined)?.v ?? null;

  let fix1Attempts = 0;
  const failingSend = async () => {
    fix1Attempts += 1;
    return false; // delivery failed
  };
  // First run — sender fails. Row exists, lastSentAt NULL, email attempted, not emailed.
  let r = await processImmediateCriticalAlerts({ report: fix1Report(), send: failingSend });
  assert.equal(fix1Attempts, 1, "email was attempted on first sighting");
  assert.deepEqual(r.emailedKeys, [], "failed send is not counted as emailed");
  assert.deepEqual(r.failedKeys, ["critical:refund_stuck:fix1"], "failed send surfaced in failedKeys");
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM health_alerts WHERE alert_key = ?").get("critical:refund_stuck:fix1") as { c: number }).c,
    1,
    "row exists after the failed send (dedupe insert happened)",
  );
  assert.equal(lastSentOf("critical:refund_stuck:fix1"), null, "lastSentAt stays NULL after a failed send");

  // Second run — sender works now. The send is RETRIED (row existing did NOT dedupe it away).
  let fix1Sends = 0;
  const workingSend = async () => {
    fix1Sends += 1;
    return true;
  };
  r = await processImmediateCriticalAlerts({ report: fix1Report(), send: workingSend });
  assert.equal(fix1Sends, 1, "the previously-failed send was retried");
  assert.deepEqual(r.emailedKeys, ["critical:refund_stuck:fix1"], "retry succeeded → emailed");
  assert.ok(lastSentOf("critical:refund_stuck:fix1"), "lastSentAt is now stamped after a successful send");

  // Third run — already sent (lastSentAt set, unresolved) → no re-send.
  fix1Sends = 0;
  r = await processImmediateCriticalAlerts({ report: fix1Report(), send: workingSend });
  assert.equal(fix1Sends, 0, "no re-send once lastSentAt is set");
  assert.deepEqual(r.emailedKeys, [], "third run does not re-email");
  assert.ok(r.skippedKeys.includes("critical:refund_stuck:fix1"), "third run is deduped/skipped");

  // ---- FIX 5: a degraded-source report must NOT resolve/re-arm an active refund alert ----
  // Seed an active, emailed refund alert.
  function fix5Report(): Report {
    return {
      generatedAt: "2026-07-07T15:00:00.000Z",
      overall: "critical",
      signals: [
        {
          key: "refund-stuck:fix5",
          label: "Refund stuck in-flight",
          severity: "critical",
          detail: "Refund initiation fix5 stuck submitting.",
          value: 1,
          alertKey: "critical:refund_stuck:fix5",
        },
      ],
    };
  }
  let fix5Sends = 0;
  const send5 = async () => {
    fix5Sends += 1;
    return true;
  };
  await processImmediateCriticalAlerts({ report: fix5Report(), send: send5 });
  assert.equal(fix5Sends, 1, "refund alert emailed on first sight");

  // A degraded report: the refund source failed → NO refund signal present, but the refund
  // alert-key prefix is marked degraded. The key must be neither resolved nor re-emailed.
  const degradedReport: Report = {
    generatedAt: "2026-07-07T16:00:00.000Z",
    overall: "warn",
    signals: [],
    degradedAlertKeyPrefixes: ["critical:refund_stuck:"],
  };
  fix5Sends = 0;
  r = await processImmediateCriticalAlerts({ report: degradedReport, send: send5 });
  assert.ok(!r.resolvedKeys.includes("critical:refund_stuck:fix5"), "degraded-source key is NOT resolved");
  assert.equal(fix5Sends, 0, "degraded-source key is NOT re-emailed");
  assert.equal(
    (database.prepare("SELECT resolved_at AS v FROM health_alerts WHERE alert_key = ?").get("critical:refund_stuck:fix5") as { v: string | null }).v,
    null,
    "the refund alert row remains unresolved (held, not re-armed) while the source is degraded",
  );

  // Sanity: WITHOUT the degraded prefix, the same absent key WOULD resolve normally.
  const cleanEmpty: Report = { generatedAt: "2026-07-07T17:00:00.000Z", overall: "green", signals: [] };
  r = await processImmediateCriticalAlerts({ report: cleanEmpty, send: send5 });
  assert.ok(r.resolvedKeys.includes("critical:refund_stuck:fix5"), "once the source recovers and the condition clears, the key resolves");

  // ---- test 10: sendAdminAlertEmail always targets ALERT_EMAIL, never a client address ----
  const { sendAdminAlertEmail } = await import("@/lib/email");
  const originalFetch = global.fetch;

  // Unset ALERT_EMAIL → fail-closed false, no send.
  delete process.env.ALERT_EMAIL;
  let fetchCalls = 0;
  global.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  }) as typeof fetch;
  const noConfig = await sendAdminAlertEmail({ subject: "s", text: "t" });
  assert.equal(noConfig, false, "ALERT_EMAIL unset → returns false");
  assert.equal(fetchCalls, 0, "no Resend call when ALERT_EMAIL unset");

  // Configured → recipient is ALERT_EMAIL even when the body mentions a client email.
  process.env.ALERT_EMAIL = "tyler@own.example";
  process.env.RESEND_API_KEY = "test-key";
  let capturedTo: unknown = null;
  global.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    capturedTo = body.to;
    return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
  }) as unknown as typeof fetch;
  const ok = await sendAdminAlertEmail({
    subject: "Reese CRM CRITICAL",
    text: "A client wrote from client@evil.example — do not send here.",
  });
  assert.equal(ok, true, "delivered when configured");
  assert.equal(capturedTo, "tyler@own.example", "recipient is always ALERT_EMAIL");
  assert.notEqual(capturedTo, "client@evil.example", "a client-derived address never becomes the recipient");

  global.fetch = originalFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.ALERT_EMAIL;

  console.log("health-alerts tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
