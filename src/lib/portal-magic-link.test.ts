import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-portal-magic-link-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.NEXT_PUBLIC_APP_URL = "https://studio.test";
delete process.env.RESEND_API_KEY; // sendPortalMagicLinkEmail returns false, no network
delete process.env.PORTAL_MAGIC_LINK_ENABLED;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const {
    resolveActiveProjectsForEmail,
    requestPortalMagicLink,
    consumePortalMagicLink,
    authenticatePortalToken,
  } = await import("./portal");
  const database = rawDb();
  const now = "2026-07-05T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-1', 'Avery', 'Stone', 'avery@example.com', ?, ?),
      ('client-2', 'Blake', 'Rivera', 'blake@example.com', ?, ?),
      ('client-off', 'Casey', 'Nguyen', 'casey@example.com', ?, ?),
      ('client-cap', 'Dana', 'Ortiz', 'dana@example.com', ?, ?)
  `).run(now, now, now, now, now, now, now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-a', 'Wedding A', 'wedding', 'planning', 'active', ?, ?),
      ('project-b', 'Engagement B', 'engagement', 'planning', 'active', '2026-07-06T12:00:00.000Z', '2026-07-06T12:00:00.000Z'),
      ('project-archived', 'Archived', 'wedding', 'planning', 'archived', ?, ?),
      ('project-off', 'Off Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-cap', 'Cap Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now, now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('pp-a', 'project-a', 'client-1', 'primary', 1, ?),
      ('pp-b', 'project-b', 'client-1', 'primary', 1, ?),
      ('pp-archived', 'project-archived', 'client-1', 'primary', 1, ?),
      ('pp-off', 'project-off', 'client-off', 'primary', 1, ?),
      ('pp-cap', 'project-cap', 'client-cap', 'primary', 1, ?)
  `).run(now, now, now, now, now);

  // ------------------------------------------------------------------
  // resolveActiveProjectsForEmail
  // ------------------------------------------------------------------
  const resolvedUpper = await resolveActiveProjectsForEmail("  AVERY@EXAMPLE.COM  ");
  assert.equal(resolvedUpper.length, 2, "canonicalizes email and returns both active projects");
  assert.deepEqual(
    new Set(resolvedUpper.map((r) => r.projectId)),
    new Set(["project-a", "project-b"]),
    "archived project is excluded (active-only filter)",
  );
  assert.equal((await resolveActiveProjectsForEmail("nobody@example.com")).length, 0, "no-match → []");
  assert.equal((await resolveActiveProjectsForEmail("   ")).length, 0, "blank email → []");

  // ------------------------------------------------------------------
  // requestPortalMagicLink — flag OFF is a no-op
  // ------------------------------------------------------------------
  delete process.env.PORTAL_MAGIC_LINK_ENABLED;
  await requestPortalMagicLink({ email: "casey@example.com" });
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS n FROM portal_access_tokens WHERE client_id = 'client-off'").get() as { n: number }).n,
    0,
    "flag off → no tokens minted",
  );

  // ------------------------------------------------------------------
  // requestPortalMagicLink — enabled mints one token per active project
  // ------------------------------------------------------------------
  process.env.PORTAL_MAGIC_LINK_ENABLED = "1";
  await requestPortalMagicLink({ email: "avery@example.com" });
  const minted = database
    .prepare("SELECT project_id, kind, request_batch_id, label FROM portal_access_tokens WHERE client_id = 'client-1' ORDER BY project_id")
    .all() as Array<{ project_id: string; kind: string; request_batch_id: string; label: string }>;
  assert.equal(minted.length, 2, "one magic_request token per active project");
  assert.ok(minted.every((r) => r.kind === "magic_request"), "all minted tokens are kind magic_request");
  assert.equal(new Set(minted.map((r) => r.request_batch_id)).size, 1, "the request's tokens share one batch id");
  assert.deepEqual(
    new Set(minted.map((r) => r.project_id)),
    new Set(["project-a", "project-b"]),
    "tokens only target active projects",
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'portal.magic_link.requested' AND client_id = 'client-1'").get() as { n: number }).n,
    2,
    "each minted token logs portal.magic_link.requested",
  );

  // no-match while enabled → still no tokens, no throw
  await requestPortalMagicLink({ email: "nobody@example.com" });
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS n FROM portal_access_tokens WHERE kind = 'magic_request'").get() as { n: number }).n,
    2,
    "a no-match request mints nothing",
  );

  // ------------------------------------------------------------------
  // Per-email cap counts request-batches (not raw tokens)
  // ------------------------------------------------------------------
  process.env.PORTAL_MAGIC_LINK_PER_EMAIL_MAX = "1";
  await requestPortalMagicLink({ email: "dana@example.com" }); // batch 1 (1 token)
  const afterFirst = (database.prepare("SELECT COUNT(*) AS n FROM portal_access_tokens WHERE client_id = 'client-cap'").get() as { n: number }).n;
  assert.equal(afterFirst, 1, "first request for the capped client mints its one project token");
  await requestPortalMagicLink({ email: "dana@example.com" }); // capped → noop
  const afterSecond = (database.prepare("SELECT COUNT(*) AS n FROM portal_access_tokens WHERE client_id = 'client-cap'").get() as { n: number }).n;
  assert.equal(afterSecond, 1, "second request past the per-email cap is a silent noop");
  delete process.env.PORTAL_MAGIC_LINK_PER_EMAIL_MAX;

  // ------------------------------------------------------------------
  // consumePortalMagicLink — unknown / expired / and single-use claim
  // ------------------------------------------------------------------
  assert.deepEqual(await consumePortalMagicLink("does-not-exist"), { ok: false, reason: "invalid" }, "unknown token → ok:false");
  // An unknown token must NOT write an activity row — the verify POST is
  // unauthenticated + only tokenAccess-rate-limited, so logging random tokens
  // would be an unauthenticated D1-write spam vector. Real-but-invalid tokens
  // (expired/consumed/revoked) below are still logged.
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'portal.magic_link.rejected'").get() as { n: number }).n,
    0,
    "an unknown-token consume writes no rejected activity row",
  );

  // Seed an expired magic_request token directly (known plaintext).
  const expiredToken = randomBytes(32).toString("base64url");
  database.prepare(`
    INSERT INTO portal_access_tokens (id, project_id, client_id, token_hash, label, kind, request_batch_id, expires_at, created_at)
    VALUES ('mr-expired', 'project-a', 'client-1', ?, 'Self-service magic link', 'magic_request', 'batch-expired', '2020-01-01T00:00:00.000Z', ?)
  `).run(hashToken(expiredToken), now);
  assert.deepEqual(await consumePortalMagicLink(expiredToken), { ok: false, reason: "invalid" }, "expired token → ok:false");
  assert.equal(
    (database.prepare("SELECT consumed_at FROM portal_access_tokens WHERE id = 'mr-expired'").get() as { consumed_at: string | null }).consumed_at,
    null,
    "an expired token is never claimed",
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'portal.magic_link.rejected' AND project_id = 'project-a'").get() as { n: number }).n,
    1,
    "a real-but-invalid (expired) token still logs a rejected row",
  );

  // A magic_request token must NOT be redeemable via authenticatePortalToken.
  const leakToken = randomBytes(32).toString("base64url");
  database.prepare(`
    INSERT INTO portal_access_tokens (id, project_id, client_id, token_hash, label, kind, request_batch_id, expires_at, created_at)
    VALUES ('mr-leak', 'project-a', 'client-1', ?, 'Self-service magic link', 'magic_request', 'batch-leak', '2027-01-01T00:00:00.000Z', ?)
  `).run(hashToken(leakToken), now);
  assert.deepEqual(
    await authenticatePortalToken(leakToken),
    { ok: false, reason: "invalid" },
    "a magic_request token cannot be redeemed as a direct /p/ session",
  );
  assert.equal(
    (database.prepare("SELECT last_used_at FROM portal_access_tokens WHERE id = 'mr-leak'").get() as { last_used_at: string | null }).last_used_at,
    null,
    "authenticatePortalToken never touches a magic_request row",
  );

  // Single-use atomicity: two concurrent consumes of the same live token → the
  // atomic `consumed_at IS NULL` claim admits exactly one session mint. (The
  // winner then throws at cookie-setting because tests have no request scope;
  // the invariant we assert is the DB effect: exactly one session row.)
  const liveToken = randomBytes(32).toString("base64url");
  database.prepare(`
    INSERT INTO portal_access_tokens (id, project_id, client_id, token_hash, label, kind, request_batch_id, expires_at, created_at)
    VALUES ('mr-live', 'project-a', 'client-1', ?, 'Self-service magic link', 'magic_request', 'batch-live', '2027-01-01T00:00:00.000Z', ?)
  `).run(hashToken(liveToken), now);
  const results = await Promise.allSettled([
    consumePortalMagicLink(liveToken),
    consumePortalMagicLink(liveToken),
  ]);
  const fulfilledFalse = results.filter(
    (r) => r.status === "fulfilled" && (r.value as { ok: boolean }).ok === false,
  ).length;
  assert.equal(fulfilledFalse, 1, "exactly one consume observes the token already claimed → ok:false");
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS n FROM portal_access_tokens WHERE label = 'Client portal session (magic link)'").get() as { n: number }).n,
    1,
    "the atomic single-use claim mints exactly one session row",
  );
  const sessionRow = database
    .prepare("SELECT kind, project_id FROM portal_access_tokens WHERE label = 'Client portal session (magic link)'")
    .get() as { kind: string; project_id: string };
  assert.equal(sessionRow.kind, "session", "the minted session token is kind:session");
  assert.equal(sessionRow.project_id, "project-a", "the session is scoped to the request token's project");
  assert.equal(
    (database.prepare("SELECT consumed_at FROM portal_access_tokens WHERE id = 'mr-live'").get() as { consumed_at: string | null }).consumed_at !== null,
    true,
    "the request token is marked consumed",
  );
  // A subsequent consume of the now-consumed token → ok:false.
  assert.deepEqual(await consumePortalMagicLink(liveToken), { ok: false, reason: "invalid" }, "a consumed token cannot be reused");

  console.log("portal magic link tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
