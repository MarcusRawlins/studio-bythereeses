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

  // Seed ONE known row in each canonical table BEFORE any monitoring runs. This strengthens the
  // guard beyond "no new INSERT" (an empty-db count only catches inserts): we snapshot each seeded
  // row and assert it is byte-for-byte unchanged afterwards, so an UPDATE or DELETE by the
  // monitoring layer would also fail the guard.
  const now = new Date().toISOString();
  database.exec(`
    INSERT INTO clients (id, first_name, last_name, email, sms_opt_in, created_at, updated_at)
      VALUES ('cli-1','Ada','Lovelace','ada@example.com',0,'${now}','${now}');
    INSERT INTO projects (id, name, type, stage, status, calendar_sync_status, created_at, updated_at)
      VALUES ('proj-1','Guard Project','wedding','inquiry','active','not_connected','${now}','${now}');
    INSERT INTO invoices (id, project_id, invoice_number, status, created_at, updated_at)
      VALUES ('inv-1','proj-1','INV-GUARD-1','draft','${now}','${now}');
    INSERT INTO invoice_payments (id, invoice_id, label, created_at, updated_at)
      VALUES ('pay-1','inv-1','Balance','${now}','${now}');
    INSERT INTO payment_refunds (id, stripe_refund_id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at)
      VALUES ('pref-1','re_guard','pay-1',5000,'usd','succeeded','${now}','${now}');
    INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, stripe_refund_id, created_at, updated_at)
      VALUES ('ri-1','pay-1',5000,'usd','succeeded','re_guard','${now}','${now}');
    INSERT INTO sequence_sends (id, project_id, sequence_key, step_key, dedupe_key, channel, mode, status, attempts, fired_at)
      VALUES ('seq-1','proj-1','welcome','step1','dedupe-guard-1','email','auto_send','sent',0,'${now}');
  `);
  const snapshot: Record<string, unknown[]> = {};
  for (const table of CANONICAL_TABLES) {
    snapshot[table] = database.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    assert.equal((snapshot[table] as unknown[]).length, 1, `${table} seeded with exactly one row`);
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
  // ZERO canonical MUTATION from all of the above: no new INSERT (count unchanged at 1) AND the
  // seeded rows are byte-for-byte identical (no UPDATE / no DELETE).
  for (const table of CANONICAL_TABLES) {
    assert.equal(countRows(database, table), 1, `monitoring must not INSERT/DELETE canonical table ${table}`);
    const after = database.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    assert.deepEqual(after, snapshot[table], `monitoring must not mutate canonical table ${table} (no UPDATE)`);
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
