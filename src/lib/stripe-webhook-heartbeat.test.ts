import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 21 §8 test 2c (signature-reject does not poison the CRITICAL counter) + test 8 (a
// verified-event processing throw records a FAILURE and STILL returns the same non-2xx —
// monitoring never masks a failure into a 2xx).
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-stripe-heartbeat-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
delete process.env.RESEND_API_KEY;

function signedHeaders(rawBody: string) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET!).update(`${ts}.${rawBody}`).digest("hex");
  return { "stripe-signature": `t=${ts},v1=${sig}` };
}

async function post(POST: (req: Request) => Promise<Response>, rawBody: string, headers: Record<string, string>) {
  const res = await POST(
    new Request("https://x.workers.dev/api/stripe/webhook", { method: "POST", headers, body: rawBody }),
  );
  return res;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { readJobRun } = await import("@/lib/job-runs");
  const { computeSystemHealth } = await import("@/lib/system-health");
  const { POST } = await import("@/app/api/stripe/webhook/route");
  const database = rawDb();

  // ---- test 2c: three PRE-verification rejects (bad/missing signature) ----
  for (let i = 0; i < 3; i += 1) {
    const res = await post(POST, JSON.stringify({ type: "checkout.session.completed" }), {
      "stripe-signature": "t=1,v1=deadbeef", // invalid
    });
    assert.equal(res.status, 400, "invalid signature → 400");
  }
  // The CRITICAL counter is UNTOUCHED — no `stripe-webhook` row (or 0 failures).
  const afterRejects = await readJobRun("stripe-webhook");
  assert.ok(!afterRejects || afterRejects.consecutiveFailures === 0, "pre-verify rejects do NOT increment stripe-webhook");
  // They land only under the separate non-alerting key.
  const rejected = await readJobRun("stripe-webhook-rejected");
  assert.ok(rejected && rejected.consecutiveFailures === 3, "rejects recorded under the non-alerting stripe-webhook-rejected key");
  // No CRITICAL money-drift signal from the rejects.
  let report = await computeSystemHealth();
  const stripeSig = report.signals.find((s) => s.key === "stripe-webhook")!;
  assert.notEqual(stripeSig.severity, "critical", "three scanner rejects must NOT produce a CRITICAL stripe signal");

  // ---- test 8: a VERIFIED event whose processing throws → records FAILURE, still returns 400 ----
  const verifiedThrowBody = JSON.stringify({ type: "checkout.session.completed" }); // no data.object → processing throws
  let res = await post(POST, verifiedThrowBody, signedHeaders(verifiedThrowBody));
  assert.equal(res.status, 400, "verified-event processing failure preserves the non-2xx (400) status");
  let sw = await readJobRun("stripe-webhook");
  assert.ok(sw && sw.consecutiveFailures === 1, "a verified processing throw increments stripe-webhook consecutive_failures");

  report = await computeSystemHealth();
  assert.equal(report.signals.find((s) => s.key === "stripe-webhook")!.severity, "warn", "1 real failure → WARN");

  // Two more verified-throw failures → escalates to CRITICAL (money state drift).
  await post(POST, verifiedThrowBody, signedHeaders(verifiedThrowBody));
  res = await post(POST, verifiedThrowBody, signedHeaders(verifiedThrowBody));
  assert.equal(res.status, 400, "still fail-loud 400");
  sw = await readJobRun("stripe-webhook");
  assert.ok(sw && sw.consecutiveFailures === 3, "three real failures");
  report = await computeSystemHealth();
  assert.equal(report.signals.find((s) => s.key === "stripe-webhook")!.severity, "critical", "3 real failures → CRITICAL");

  void database;
  console.log("stripe webhook heartbeat tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
