import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 21 FIX 2 — an alert-delivery failure must be visible to the dead-man's-switch. When the
// monitor is enabled + ALERT_EMAIL is set and a send is ATTEMPTED-and-FAILED this run, the route
// must NOT ping DEADMAN_PING_URL, must record its own heartbeat as a FAILURE, and must return 500
// (so the fail-loud worker throws). Also asserts the MINOR safe digest-hour parse.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-systems-monitor-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.CRON_SECRET = "monitor-route-secret";
// Far-past required-since → the REQUIRED jobs are missing (maximally stale) → CRITICAL signals
// carrying alert keys, so an immediate-critical email is attempted this run.
process.env.MONITOR_REQUIRED_SINCE = "2020-01-01T00:00:00.000Z";
delete process.env.DEADMAN_PING_URL;

function monitorRequest() {
  return new Request("https://x.workers.dev/api/cron/systems-monitor", {
    method: "POST",
    headers: { authorization: "Bearer monitor-route-secret" },
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { parseDigestHour, DEFAULT_DIGEST_HOUR } = await import("@/lib/system-health");
  const { POST } = await import("@/app/api/cron/systems-monitor/route");
  const database = rawDb();

  // ---- MINOR: safe digest-hour parse falls back to the intended default ----
  assert.equal(parseDigestHour("8"), 8, "a valid hour parses");
  assert.equal(parseDigestHour("0"), 0, "0 is a valid hour");
  assert.equal(parseDigestHour("23"), 23, "23 is a valid hour");
  assert.equal(parseDigestHour(""), DEFAULT_DIGEST_HOUR, "empty string → default");
  assert.equal(parseDigestHour("   "), DEFAULT_DIGEST_HOUR, "whitespace → default");
  assert.equal(parseDigestHour(undefined), DEFAULT_DIGEST_HOUR, "unset → default");
  assert.equal(parseDigestHour("not-a-number"), DEFAULT_DIGEST_HOUR, "NaN → default");
  assert.equal(parseDigestHour("8.5"), DEFAULT_DIGEST_HOUR, "non-integer → default");
  assert.equal(parseDigestHour("-1"), DEFAULT_DIGEST_HOUR, "negative → default");
  assert.equal(parseDigestHour("24"), DEFAULT_DIGEST_HOUR, "out-of-range high → default");

  // ---- FIX 2: enabled + ALERT_EMAIL set + a critical present + send returns false → fail-loud ----
  process.env.MONITOR_ENABLED = "1";
  process.env.ALERT_EMAIL = "tyler@own.example"; // properly configured
  process.env.RESEND_API_KEY = "re_test"; // set so a send is genuinely ATTEMPTED (fetch below fails it)
  process.env.DEADMAN_PING_URL = "https://hc-ping.example/deadman";

  const originalFetch = global.fetch;
  let deadmanPinged = false;
  let sendAttempted = false;
  global.fetch = (async (url: string) => {
    const u = String(url);
    if (u.includes("hc-ping.example")) {
      deadmanPinged = true;
      return new Response("ok", { status: 200 });
    }
    if (u.includes("api.resend.com")) {
      sendAttempted = true;
      // Resend rejects → sendAdminAlertEmail returns false → attempted-and-FAILED delivery.
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const res = await POST(monitorRequest() as unknown as Parameters<typeof POST>[0]);

  global.fetch = originalFetch;

  assert.equal(res.status, 500, "attempted-and-failed delivery → route returns 500 (fail-loud)");
  assert.ok(sendAttempted, "an alert email WAS attempted this run");
  assert.equal(deadmanPinged, false, "the dead-man URL is NOT pinged on a delivery failure");
  const heartbeat = database
    .prepare("SELECT last_status AS s FROM job_runs WHERE job_name = 'systems-monitor'")
    .get() as { s: string } | undefined;
  assert.ok(heartbeat, "the systems-monitor heartbeat was written");
  assert.equal(heartbeat!.s, "error", "the systems-monitor heartbeat is recorded as a FAILURE");

  delete process.env.MONITOR_ENABLED;
  delete process.env.ALERT_EMAIL;
  delete process.env.RESEND_API_KEY;
  delete process.env.DEADMAN_PING_URL;

  console.log("systems-monitor route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
