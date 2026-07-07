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

  // ---- Phase 18 §9 test 11: the narration WRITE surface is not an MCP tool -------------------
  // (the MCP tool list may — and does — reference `computeDailyBrief`/`studio_get_daily_brief`,
  // the read-only counterpart; what must stay absent is the WRITE table/route itself.)
  for (const forbidden of ["daily_brief_narrations", "daily-brief-narrative"]) {
    assert.ok(!mcpSource.includes(forbidden), `MCP tool surface must not reference the narration write surface '${forbidden}'`);
  }

  // ---- Phase 18 §9 test 11: studio_get_daily_brief is READ-ONLY (never writes) ---------------
  const { handleStudioMcpMessage } = await import("@/lib/studio-mcp");
  const narrationCountBefore = (database.prepare("SELECT COUNT(*) AS c FROM daily_brief_narrations").get() as { c: number }).c;
  const dailyBriefToolCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 100,
    method: "tools/call",
    params: { name: "studio_get_daily_brief", arguments: {} },
  });
  assert.equal(dailyBriefToolCall?.result?.isError, false, "studio_get_daily_brief succeeds");
  for (const table of CANONICAL_TABLES) {
    assert.equal(countRows(database, table), 1, `studio_get_daily_brief must not mutate canonical table ${table}`);
    assert.deepEqual(database.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), snapshot[table], `studio_get_daily_brief must not mutate canonical table ${table} (no UPDATE)`);
  }
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM daily_brief_narrations").get() as { c: number }).c,
    narrationCountBefore,
    "studio_get_daily_brief (read-only) does not write to daily_brief_narrations either",
  );

  // ---- Phase 18 §9 test 10: computeDailyBrief + the narration endpoint + a full digest send ---
  // (flag on) write rows ONLY to daily_brief_narrations (+ the existing job_runs/health_alerts) —
  // extends the zero-canonical-write guard above to these new code paths.
  const { computeDailyBrief } = await import("@/lib/daily-brief");
  await computeDailyBrief(new Date());

  process.env.STUDIO_AGENT_API_TOKEN = "obs-guard-agent-token";
  const { POST: narrationPOST } = await import("@/app/api/agent/daily-brief-narrative/route");
  const narrationRes = await narrationPOST(
    new Request("https://studio.bythereeses.com/api/agent/daily-brief-narrative", {
      method: "POST",
      headers: { authorization: "Bearer obs-guard-agent-token" },
      body: JSON.stringify({ narrative: "Guard-test narration." }),
    }),
  );
  assert.equal(narrationRes.status, 200, "the narration endpoint accepts the write");

  process.env.MONITOR_ENABLED = "1";
  process.env.DAILY_BRIEF_ENABLED = "1";
  process.env.ALERT_EMAIL = "";
  // route.ts computes `now = new Date()` internally and only builds the digest when the real ET
  // hour matches MONITOR_DIGEST_HOUR — set it to "whatever hour it is right now" so this run
  // deterministically exercises the digest-building branch (mirrors the same technique used in
  // daily-brief-digest.test.ts).
  const easternHourParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date());
  process.env.MONITOR_DIGEST_HOUR = String(Number(easternHourParts.find((p) => p.type === "hour")?.value ?? "0") % 24);
  const digestRes = await monitorPOST(
    new Request("https://x.workers.dev/api/cron/systems-monitor", {
      method: "POST",
      headers: { authorization: "Bearer obs-guard-secret" },
    }) as unknown as Parameters<typeof monitorPOST>[0],
  );
  assert.equal(digestRes.status, 200, "a full digest run (DAILY_BRIEF_ENABLED=1) still succeeds");
  delete process.env.DAILY_BRIEF_ENABLED;

  for (const table of CANONICAL_TABLES) {
    assert.equal(countRows(database, table), 1, `daily-brief code paths must not INSERT/DELETE canonical table ${table}`);
    assert.deepEqual(database.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), snapshot[table], `daily-brief code paths must not mutate canonical table ${table} (no UPDATE)`);
  }
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM daily_brief_narrations").get() as { c: number }).c,
    1,
    "the narration endpoint upserts exactly one non-canonical row (one call this run)",
  );

  console.log("observability guard tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
