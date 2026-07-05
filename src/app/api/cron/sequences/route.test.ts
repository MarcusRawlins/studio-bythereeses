import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-cron-sequences-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

// Start from a clean secret/flag env.
delete process.env.CRON_SECRET;
delete process.env.SCHEDULER_LINK_SECRET;
delete process.env.SEQUENCES_ENABLED;

function post(secret?: string) {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers.authorization = `Bearer ${secret}`;
  return new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/cron/sequences", {
    method: "POST",
    headers,
  });
}

async function main() {
  await import("@/db/client"); // ensure migrations run
  const route = await import("./route");
  const { NextRequest } = await import("next/server");
  const asReq = (req: Request) => new NextRequest(req);

  // --- 503 when CRON_SECRET unset (fail closed) ---
  const unset = await route.POST(asReq(post("anything")));
  assert.equal(unset.status, 503, "unset CRON_SECRET → 503 fail closed");

  process.env.CRON_SECRET = "cron-secret-abc";

  // --- 401 on missing bearer ---
  const missing = await route.POST(asReq(post()));
  assert.equal(missing.status, 401, "missing bearer → 401");

  // --- 401 on wrong bearer (and a wrong-length one — constant-time compare) ---
  const wrong = await route.POST(asReq(post("cron-secret-WRONG")));
  assert.equal(wrong.status, 401, "wrong bearer → 401");
  const wrongLen = await route.POST(asReq(post("short")));
  assert.equal(wrongLen.status, 401, "wrong-length bearer → 401 (length not leaked as a crash)");

  // --- valid bearer but flag OFF → 200 {skipped:flag_off}, even with a valid secret ---
  delete process.env.SEQUENCES_ENABLED;
  const flagOff = await route.POST(asReq(post("cron-secret-abc")));
  assert.equal(flagOff.status, 200);
  assert.deepEqual(await flagOff.json(), { skipped: "flag_off" }, "flag off → guaranteed no-op even with valid bearer");

  // --- valid bearer + flag ON → runs runDueSequences (returns a run summary) ---
  process.env.SEQUENCES_ENABLED = "1";
  const ran = await route.POST(asReq(post("cron-secret-abc")));
  assert.equal(ran.status, 200);
  const summary = (await ran.json()) as Record<string, unknown>;
  assert.ok("checked" in summary && "drafted" in summary, "valid bearer + flag on invokes the runner (summary returned)");
  assert.equal("skipped" in summary, false, "an enabled run is not a skip");

  delete process.env.SEQUENCES_ENABLED;
  delete process.env.CRON_SECRET;
  console.log("cron sequences route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
