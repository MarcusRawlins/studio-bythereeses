import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Phase 21 §8 test 7 — monitoring writes ZERO canonical rows (mirrors the sequences/inbound
// zero-canonical-write guards), and recordJobRun / monitor internals are NOT exported to any
// agent/MCP surface. Also test 9 (monitor route flag-off → no autonomous work).
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-observability-guard-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.CRON_SECRET = "obs-guard-secret";
delete process.env.RESEND_API_KEY;
delete process.env.ALERT_EMAIL;
delete process.env.DEADMAN_PING_URL;

const CANONICAL_TABLES = [
  "projects",
  "clients",
  "invoices",
  "invoice_payments",
  "payment_refunds",
  "refund_initiations",
  "sequence_sends",
] as const;

const here = path.dirname(fileURLToPath(import.meta.url));

function countRows(database: ReturnType<typeof import("@/db/client").rawDb>, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { recordJobRun } = await import("@/lib/job-runs");
  const database = rawDb();

  // Baseline: canonical tables empty.
  for (const table of CANONICAL_TABLES) {
    assert.equal(countRows(database, table), 0, `${table} must start empty`);
  }

  // recordJobRun writes only job_runs.
  await recordJobRun("stripe-webhook", true);
  await recordJobRun("scheduler-reminders", false, "boom");

  // ---- test 9: monitor route flag-off → {skipped:'flag_off'}, no writes at all ----
  delete process.env.MONITOR_ENABLED;
  const { POST: monitorPOST } = await import("@/app/api/cron/systems-monitor/route");
  const flagOffRes = await monitorPOST(
    new Request("https://x.workers.dev/api/cron/systems-monitor", {
      method: "POST",
      headers: { authorization: "Bearer obs-guard-secret" },
    }) as unknown as Parameters<typeof monitorPOST>[0],
  );
  assert.equal(flagOffRes.status, 200);
  assert.deepEqual(await flagOffRes.json(), { skipped: "flag_off" }, "flag-off returns skipped");
  // Flag-off wrote no systems-monitor heartbeat and no health_alerts.
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM job_runs WHERE job_name = 'systems-monitor'").get() as { c: number }).c,
    0,
    "flag-off does not write a systems-monitor heartbeat",
  );
  assert.equal((database.prepare("SELECT COUNT(*) AS c FROM health_alerts").get() as { c: number }).c, 0, "flag-off writes no alerts");

  // ---- full monitor run (flag on) still writes ONLY operational tables ----
  process.env.MONITOR_ENABLED = "1";
  process.env.MONITOR_REQUIRED_SINCE = new Date().toISOString(); // fresh → no required-job criticals
  const onRes = await monitorPOST(
    new Request("https://x.workers.dev/api/cron/systems-monitor", {
      method: "POST",
      headers: { authorization: "Bearer obs-guard-secret" },
    }) as unknown as Parameters<typeof monitorPOST>[0],
  );
  assert.equal(onRes.status, 200, "monitor run succeeds");
  // The heartbeat was self-written.
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM job_runs WHERE job_name = 'systems-monitor'").get() as { c: number }).c,
    1,
    "monitor run wrote its own heartbeat",
  );
  // ZERO canonical writes from all of the above.
  for (const table of CANONICAL_TABLES) {
    assert.equal(countRows(database, table), 0, `monitoring must write ZERO rows to canonical table ${table}`);
  }

  // ---- no agent/MCP export of monitoring internals ----
  const mcpSource = fs.readFileSync(path.join(here, "studio-mcp.ts"), "utf8");
  for (const forbidden of ["recordJobRun", "computeSystemHealth", "job_runs", "health_alerts", "systems-monitor"]) {
    assert.ok(!mcpSource.includes(forbidden), `MCP tool surface must not reference monitoring internal '${forbidden}'`);
  }
  // /api/agent/health exists but is NOT registered as an MCP tool name.
  assert.ok(!/studio_[a-z_]*health/i.test(mcpSource) || !mcpSource.includes("agent/health"), "health endpoint is not an MCP tool");

  console.log("observability guard tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
