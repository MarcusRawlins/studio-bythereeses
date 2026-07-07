import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-scheduler-reminders-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.CRON_SECRET = "cron-test-secret";
delete process.env.RESEND_API_KEY;

async function main() {
  const { POST } = await import("./route");

  const unauthorized = await POST(new Request("https://studio.test/api/cron/scheduler-reminders", {
    method: "POST",
  }));
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "Unauthorized" });

  const authorized = await POST(new Request("https://studio.test/api/cron/scheduler-reminders", {
    method: "POST",
    headers: {
      authorization: "Bearer cron-test-secret",
    },
  }));
  assert.equal(authorized.status, 200);
  // Phase 21: extended return shape {checked, due, sent, failed}. No bookings → all zero, and
  // the route records a successful heartbeat.
  assert.deepEqual(await authorized.json(), { checked: 0, due: 0, sent: 0, failed: 0 });

  const { readJobRun } = await import("@/lib/job-runs");
  const heartbeat = await readJobRun("scheduler-reminders");
  assert.ok(heartbeat && heartbeat.lastStatus === "ok", "an empty successful run records an ok heartbeat");

  console.log("scheduler reminders cron route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});