import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 21 FIX 6 — the heartbeat allowlist is restricted to `backup-d1` ONLY (the sole
// out-of-Worker job). A CRON_SECRET compromise (plaintext in the mac-mini launchd script) must
// NOT be able to forge fresh liveness for scheduler-reminders / sequence-runner and suppress the
// staleness alarms this phase builds — those jobs write their heartbeat CRM-side only.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-heartbeat-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.CRON_SECRET = "heartbeat-route-secret";

function heartbeatRequest(body: unknown) {
  return new Request("https://x.workers.dev/api/cron/heartbeat", {
    method: "POST",
    headers: { authorization: "Bearer heartbeat-route-secret", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main() {
  const { readJobRun } = await import("@/lib/job-runs");
  const { POST } = await import("@/app/api/cron/heartbeat/route");

  // backup-d1 is allowed → recorded.
  const okRes = await POST(heartbeatRequest({ job: "backup-d1", ok: true }) as unknown as Parameters<typeof POST>[0]);
  assert.equal(okRes.status, 200, "backup-d1 heartbeat is accepted");
  const recorded = await readJobRun("backup-d1");
  assert.ok(recorded && recorded.lastStatus === "ok", "backup-d1 heartbeat was written");

  // scheduler-reminders is NO LONGER allowed via the public endpoint → rejected, not recorded.
  for (const job of ["scheduler-reminders", "sequence-runner"]) {
    const res = await POST(heartbeatRequest({ job, ok: true }) as unknown as Parameters<typeof POST>[0]);
    assert.equal(res.status, 400, `${job} is rejected from the public heartbeat allowlist`);
    const forged = await readJobRun(job);
    assert.ok(!forged, `${job} liveness cannot be forged via the heartbeat endpoint`);
  }

  // An unknown/injected key is still rejected.
  const bad = await POST(heartbeatRequest({ job: "stripe-webhook", ok: true }) as unknown as Parameters<typeof POST>[0]);
  assert.equal(bad.status, 400, "arbitrary job keys are rejected");

  console.log("heartbeat route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
