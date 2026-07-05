import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-unsubscribe-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.UNSUBSCRIBE_SECRET = "unsub-secret-value";
process.env.UNSUBSCRIBE_BASE_URL = "https://studio.bythereeses.com";

function req(method: string, token: string | null) {
  const url = token === null
    ? "https://studio.bythereeses.com/api/email/unsubscribe"
    : `https://studio.bythereeses.com/api/email/unsubscribe?t=${encodeURIComponent(token)}`;
  return new Request(url, { method });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const { NextRequest } = await import("next/server");
  const { signUnsubscribeToken } = await import("@/lib/unsubscribe-token");
  const database = rawDb();
  const now = "2026-07-06T15:00:00.000Z";
  const asReq = (r: Request) => new NextRequest(r);

  const suppressionCount = (email: string) =>
    (database.prepare("SELECT COUNT(*) AS c FROM email_suppressions WHERE email = ?").get(email) as { c: number }).c;

  // Fixtures: a project + a queued sequence email draft for client A.
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_communications (id, project_id, client_id, direction, channel, status, subject, body, recipient_email, source_type, source_id, created_by, created_at, updated_at)
    VALUES ('draft-a', 'project-1', NULL, 'outbound', 'email', 'draft', 'Reminder', 'body', 'client-a@example.com', 'sequence_step', 'dunning:dunning-day-7', 'system', ?, ?)
  `).run(now, now);
  // A hand-written admin email draft that must NOT be voided.
  database.prepare(`
    INSERT INTO project_communications (id, project_id, client_id, direction, channel, status, subject, body, recipient_email, source_type, created_by, created_at, updated_at)
    VALUES ('draft-admin', 'project-1', NULL, 'outbound', 'email', 'draft', 'Personal', 'note', 'client-a@example.com', NULL, 'admin', ?, ?)
  `).run(now, now);

  const tokenA = signUnsubscribeToken("client-a@example.com", "sequences");

  // --- bad/absent token → 400 (fail closed), writes NOTHING ---
  const badGet = await route.GET(asReq(req("GET", "garbage")));
  assert.equal(badGet.status, 400, "GET bad token → 400");
  const absentPost = await route.POST(asReq(req("POST", null)));
  assert.equal(absentPost.status, 400, "POST absent token → 400");
  assert.equal(suppressionCount("client-a@example.com"), 0, "no suppression written on bad/absent token");

  // --- GET renders confirm page and writes NOTHING (mail-scanner prefetch guard) ---
  const get = await route.GET(asReq(req("GET", tokenA)));
  assert.equal(get.status, 200, "GET valid token → 200 confirm page");
  const html = await get.text();
  assert.ok(html.includes("Confirm unsubscribe"), "confirm page rendered");
  assert.ok(html.includes("method=\"post\""), "confirm page posts to unsubscribe");
  assert.equal(suppressionCount("client-a@example.com"), 0, "GET writes NOTHING — no suppression row");
  assert.equal(
    (database.prepare("SELECT status FROM project_communications WHERE id = 'draft-a'").get() as { status: string }).status,
    "draft",
    "GET does not void drafts",
  );

  // --- valid POST → suppression row + voids the sequence draft, neutral 200 ---
  const post = await route.POST(asReq(req("POST", tokenA)));
  assert.equal(post.status, 200, "valid POST → neutral 200");
  assert.equal(suppressionCount("client-a@example.com"), 1, "POST writes the suppression row (lowercased)");
  assert.equal(
    (database.prepare("SELECT status FROM project_communications WHERE id = 'draft-a'").get() as { status: string }).status,
    "archived",
    "POST voids the open sequence email draft for that recipient",
  );
  assert.equal(
    (database.prepare("SELECT status FROM project_communications WHERE id = 'draft-admin'").get() as { status: string }).status,
    "draft",
    "hand-written admin draft is NOT voided",
  );

  // --- replayed POST is idempotent (INSERT ON CONFLICT DO NOTHING, no UPDATE) ---
  const firstSuppressedAt = (database.prepare("SELECT suppressed_at AS v FROM email_suppressions WHERE email = 'client-a@example.com'").get() as { v: string }).v;
  const replay = await route.POST(asReq(req("POST", tokenA)));
  assert.equal(replay.status, 200, "replayed POST → 200");
  assert.equal(suppressionCount("client-a@example.com"), 1, "replay does not add a second row");
  assert.equal(
    (database.prepare("SELECT suppressed_at AS v FROM email_suppressions WHERE email = 'client-a@example.com'").get() as { v: string }).v,
    firstSuppressedAt,
    "replay does not UPDATE the existing row (insert-not-update)",
  );

  // --- a token for email A cannot suppress email B ---
  const tokenB = signUnsubscribeToken("client-b@example.com", "sequences");
  const parts = tokenB.split(".");
  const forgedForA = Buffer.from("client-a@example.com|sequences", "utf8").toString("base64url");
  const forged = `${forgedForA}.${parts[1]}`; // B's signature over A's payload
  const forgeAttempt = await route.POST(asReq(req("POST", forged)));
  assert.equal(forgeAttempt.status, 400, "cross-email forge → 400, no write");
  assert.equal(suppressionCount("client-b@example.com"), 0, "forge did not suppress a different email");

  console.log("unsubscribe route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
