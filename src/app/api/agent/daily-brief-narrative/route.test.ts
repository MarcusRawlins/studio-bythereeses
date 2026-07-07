import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 18 §9 test 9 — the narration endpoint's double guard (mirrors /api/agent/health), body
// validation, secret-value redaction (reused from sanitizeJobRunError, §3.3 finding A-3), and
// upsert-by-day semantics (two POSTs same day -> one row).
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-daily-brief-narrative-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "narrative-token";
process.env.STRIPE_SECRET_KEY = "sk_live_should_never_be_stored";

function narrationRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://studio.bythereeses.com/api/agent/daily-brief-narrative", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();

  // ---- direct workers.dev origin is blocked (mirrors /api/agent/health) ----
  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blockedOrigin = await route.POST(
    new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/agent/daily-brief-narrative", {
      method: "POST",
      headers: { authorization: "Bearer narrative-token" },
      body: JSON.stringify({ narrative: "hi" }),
    }),
  );
  assert.equal(blockedOrigin.status, 404, "a direct workers.dev origin request is blocked");

  // ---- missing/wrong bearer -> 401/503 ----
  delete process.env.STUDIO_AGENT_API_TOKEN;
  const tokenUnset = await route.POST(narrationRequest({ narrative: "hi" }, { "x-reese-origin-secret": "origin-secret" }));
  assert.equal(tokenUnset.status, 503, "unset agent token -> 503");
  process.env.STUDIO_AGENT_API_TOKEN = "narrative-token";

  const wrongBearer = await route.POST(
    narrationRequest({ narrative: "hi" }, { authorization: "Bearer wrong", "x-reese-origin-secret": "origin-secret" }),
  );
  assert.equal(wrongBearer.status, 401, "wrong bearer -> 401");

  const authHeaders = { authorization: "Bearer narrative-token", "x-reese-origin-secret": "origin-secret" };

  // ---- empty body -> 400 ----
  const emptyBody = await route.POST(narrationRequest({ narrative: "   " }, authHeaders));
  assert.equal(emptyBody.status, 400, "an empty/whitespace-only narrative -> 400");

  const missingField = await route.POST(narrationRequest({}, authHeaders));
  assert.equal(missingField.status, 400, "a missing narrative field -> 400");

  // ---- oversized + control-character narrative is capped and cleaned ----
  const controlLaced = `Line one.\x01\x02${"x".repeat(2000)}`;
  const oversized = await route.POST(narrationRequest({ narrative: controlLaced }, authHeaders));
  assert.equal(oversized.status, 200, "an oversized narrative is accepted (capped, not rejected)");
  const dayKeyRow = database.prepare("SELECT day_key AS dayKey, narrative FROM daily_brief_narrations").get() as { dayKey: string; narrative: string };
  assert.ok(dayKeyRow, "a row was written");
  assert.ok(dayKeyRow.narrative.length <= 1500, "the stored narrative is capped at 1500 chars");
  assert.ok(!/[\x01\x02]/.test(dayKeyRow.narrative), "control characters are stripped before storage");

  // ---- a narrative containing a live SECRET_ENV_NAMES value is redacted before storage ----
  database.exec("DELETE FROM daily_brief_narrations;");
  const secretValue = process.env.STRIPE_SECRET_KEY!;
  const leaking = `The stuck job's error was: ${secretValue} — please investigate.`;
  const leakRes = await route.POST(narrationRequest({ narrative: leaking }, authHeaders));
  assert.equal(leakRes.status, 200);
  const stored = database.prepare("SELECT narrative FROM daily_brief_narrations").get() as { narrative: string } | undefined;
  assert.ok(stored, "the narration row was written");
  assert.ok(!stored!.narrative.includes(secretValue), "the live secret value never reaches storage");
  assert.ok(stored!.narrative.includes("[redacted]"), "the secret value is replaced with [redacted]");

  // ---- diff-review MAJOR-1: a secret SPLIT by an interleaved control character (e.g. an ANSI
  // escape in pasted log output) must STILL be redacted. This only holds if the control-char strip
  // runs BEFORE the literal-value redaction — strip-then-redact collapses the split so the literal
  // secret matches. A redact-then-strip ordering would delete the control char and reassemble the
  // full secret verbatim in storage → straight into the digest email.
  database.exec("DELETE FROM daily_brief_narrations;");
  const mid = Math.floor(secretValue.length / 2);
  const splitSecret = `${secretValue.slice(0, mid)}\x01${secretValue.slice(mid)}`; // control char inside the secret
  const laced = `Pasted log: error was ${splitSecret} at exit.`;
  const lacedRes = await route.POST(narrationRequest({ narrative: laced }, authHeaders));
  assert.equal(lacedRes.status, 200);
  const lacedStored = database.prepare("SELECT narrative FROM daily_brief_narrations").get() as { narrative: string };
  assert.ok(
    !lacedStored.narrative.includes(secretValue),
    "a control-char-split secret does NOT reassemble into storage (strip runs before redact)",
  );
  assert.ok(lacedStored.narrative.includes("[redacted]"), "the reassembled-then-stripped secret is redacted");

  // ---- two POSTs same day -> one row (ON CONFLICT DO UPDATE), not two ----
  database.exec("DELETE FROM daily_brief_narrations;");
  const first = await route.POST(narrationRequest({ narrative: "First narration for today." }, authHeaders));
  assert.equal(first.status, 200);
  const second = await route.POST(narrationRequest({ narrative: "Second narration for today (correction)." }, authHeaders));
  assert.equal(second.status, 200);
  const rows = database.prepare("SELECT COUNT(*) AS c FROM daily_brief_narrations").get() as { c: number };
  assert.equal(rows.c, 1, "two POSTs the same day upsert to exactly one row");
  const finalRow = database.prepare("SELECT narrative FROM daily_brief_narrations").get() as { narrative: string };
  assert.equal(finalRow.narrative, "Second narration for today (correction).", "the second POST overwrites (last-write-wins)");

  console.log("daily brief narrative route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
