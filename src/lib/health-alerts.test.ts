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
