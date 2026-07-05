import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-request-link-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.NEXT_PUBLIC_APP_URL = "https://studio.test";
delete process.env.RESEND_API_KEY;

const ENDPOINT = "https://studio.test/api/portal/request-link";

function formRequest(email: string | null, accept?: string) {
  const body = new URLSearchParams();
  if (email !== null) body.set("email", email);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (accept) headers.accept = accept;
  return new Request(ENDPOINT, { method: "POST", body: body.toString(), headers });
}

async function snapshot(response: Response) {
  return {
    status: response.status,
    location: response.headers.get("location"),
    body: await response.clone().text(),
  };
}

function tick() {
  // Flush the queueMicrotask-scheduled deferred task (Node fallback path).
  return new Promise((resolve) => setTimeout(resolve, 50));
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-07-05T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Avery', 'Stone', 'match@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('pp-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);

  // ------------------------------------------------------------------
  // No enumeration: match / no-match / malformed all produce a byte-identical
  // response. (Timing is flat by construction — all match-work is deferred.)
  // ------------------------------------------------------------------
  process.env.PORTAL_MAGIC_LINK_ENABLED = "1";
  const matchResp = await snapshot(await POST(formRequest("match@example.com")));
  const noMatchResp = await snapshot(await POST(formRequest("nobody@example.com")));
  const malformedResp = await snapshot(await POST(formRequest("not-an-email")));
  const missingResp = await snapshot(await POST(formRequest(null)));

  assert.deepEqual(matchResp, noMatchResp, "match and no-match responses are byte-identical");
  assert.deepEqual(matchResp, malformedResp, "malformed email response is byte-identical");
  assert.deepEqual(matchResp, missingResp, "missing email response is byte-identical");
  assert.equal(matchResp.status, 303, "form submit → 303 redirect");
  assert.equal(matchResp.location, "https://studio.test/portal/login?sent=1", "always the uniform sent=1 confirmation");

  // JSON content negotiation is uniform too.
  const jsonMatch = await snapshot(await POST(formRequest("match@example.com", "application/json")));
  const jsonNoMatch = await snapshot(await POST(formRequest("nobody@example.com", "application/json")));
  assert.deepEqual(jsonMatch, jsonNoMatch, "JSON match/no-match are byte-identical");
  assert.equal(jsonMatch.status, 200, "JSON caller → 200");
  assert.equal(jsonMatch.body, '{"ok":true}', "JSON caller → { ok: true }");

  // ------------------------------------------------------------------
  // Flag OFF: identical uniform response, and NO deferred work at all.
  // ------------------------------------------------------------------
  // Let any deferred tasks from the enabled POSTs above settle, then baseline.
  await tick();
  const baseline = (database.prepare("SELECT COUNT(*) AS n FROM portal_access_tokens WHERE kind = 'magic_request'").get() as { n: number }).n;
  delete process.env.PORTAL_MAGIC_LINK_ENABLED;
  const flagOff = await snapshot(await POST(formRequest("match@example.com")));
  assert.deepEqual(flagOff, matchResp, "flag-off response is byte-identical to the enabled response");
  await tick();
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS n FROM portal_access_tokens WHERE kind = 'magic_request'").get() as { n: number }).n,
    baseline,
    "flag off → the deferred task mints nothing (no new tokens)",
  );

  // ------------------------------------------------------------------
  // Deferred path DOES run when enabled: a match eventually mints, a no-match
  // never does. (Proves the task was scheduled, not awaited pre-response.)
  // ------------------------------------------------------------------
  process.env.PORTAL_MAGIC_LINK_ENABLED = "1";
  await POST(formRequest("match@example.com"));
  await POST(formRequest("nobody@example.com"));
  await tick();
  const mintedForMatch = (database.prepare("SELECT COUNT(*) AS n FROM portal_access_tokens WHERE client_id = 'client-1' AND kind = 'magic_request'").get() as { n: number }).n;
  assert.ok(mintedForMatch >= 1, "the deferred task mints a token for a matching email");

  console.log("portal request-link route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
