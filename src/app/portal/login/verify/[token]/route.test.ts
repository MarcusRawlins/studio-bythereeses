import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-verify-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.NEXT_PUBLIC_APP_URL = "https://studio.test";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// redirect() throws a NEXT_REDIRECT error whose digest encodes the target.
async function captureRedirect(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return digest;
    throw error;
  }
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { GET, POST } = await import("./route");
  const database = rawDb();
  const now = "2026-07-05T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Avery', 'Stone', 'avery@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('pp-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);

  const liveToken = randomBytes(32).toString("base64url");
  database.prepare(`
    INSERT INTO portal_access_tokens (id, project_id, client_id, token_hash, label, kind, request_batch_id, expires_at, created_at)
    VALUES ('mr-live', 'project-1', 'client-1', ?, 'Self-service magic link', 'magic_request', 'batch-1', '2027-01-01T00:00:00.000Z', ?)
  `).run(hashToken(liveToken), now);

  process.env.PORTAL_MAGIC_LINK_ENABLED = "1";

  // ------------------------------------------------------------------
  // GET renders the continue interstitial and does NOT consume [N2].
  // ------------------------------------------------------------------
  const getResponse = await GET(new Request("https://studio.test/portal/login/verify/x"), {
    params: Promise.resolve({ token: liveToken }),
  });
  assert.equal(getResponse.status, 200, "GET on a live token renders the interstitial");
  const html = await getResponse.text();
  assert.match(html, /Continue to your portal/, "the interstitial shows a Continue button");
  assert.match(html, /method="POST"/, "the interstitial POSTs to consume");
  assert.equal(
    (database.prepare("SELECT consumed_at FROM portal_access_tokens WHERE id = 'mr-live'").get() as { consumed_at: string | null }).consumed_at,
    null,
    "GET must NOT consume the token (survives mail-scanner prefetch)",
  );

  // GET on an unknown token → error page redirect.
  const getExpired = await captureRedirect(() =>
    GET(new Request("https://studio.test/portal/login/verify/x"), { params: Promise.resolve({ token: "nope" }) }),
  );
  assert.ok(getExpired?.includes("/portal/login?error=expired"), "GET on a dead token redirects to the expired page");

  // ------------------------------------------------------------------
  // POST consumes (atomic single-use). Success sets cookies, which throws in a
  // scopeless test — assert the DB effect (claim + session mint) instead.
  // ------------------------------------------------------------------
  await POST(new Request("https://studio.test/portal/login/verify/x", { method: "POST" }), {
    params: Promise.resolve({ token: liveToken }),
  }).catch(() => undefined);
  assert.equal(
    (database.prepare("SELECT consumed_at FROM portal_access_tokens WHERE id = 'mr-live'").get() as { consumed_at: string | null }).consumed_at !== null,
    true,
    "POST consumes the token",
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS n FROM portal_access_tokens WHERE label = 'Client portal session (magic link)'").get() as { n: number }).n,
    1,
    "POST mints the 30-day session token",
  );

  // POST reuse → clean expired redirect, no differentiation.
  const postReuse = await captureRedirect(() =>
    POST(new Request("https://studio.test/portal/login/verify/x", { method: "POST" }), {
      params: Promise.resolve({ token: liveToken }),
    }),
  );
  assert.ok(postReuse?.includes("/portal/login?error=expired"), "reusing a consumed token redirects to the expired page");

  // ------------------------------------------------------------------
  // Flag OFF: an otherwise-live magic link is instantly non-redeemable — GET and
  // POST both redirect to the expired page WITHOUT touching D1 (no consume).
  // ------------------------------------------------------------------
  const offToken = randomBytes(32).toString("base64url");
  database.prepare(`
    INSERT INTO portal_access_tokens (id, project_id, client_id, token_hash, label, kind, request_batch_id, expires_at, created_at)
    VALUES ('mr-off', 'project-1', 'client-1', ?, 'Self-service magic link', 'magic_request', 'batch-off', '2027-01-01T00:00:00.000Z', ?)
  `).run(hashToken(offToken), now);
  delete process.env.PORTAL_MAGIC_LINK_ENABLED;

  const offGet = await captureRedirect(() =>
    GET(new Request("https://studio.test/portal/login/verify/x"), { params: Promise.resolve({ token: offToken }) }),
  );
  assert.ok(offGet?.includes("/portal/login?error=expired"), "flag off → GET redirects to the expired page (no interstitial)");

  const offPost = await captureRedirect(() =>
    POST(new Request("https://studio.test/portal/login/verify/x", { method: "POST" }), {
      params: Promise.resolve({ token: offToken }),
    }),
  );
  assert.ok(offPost?.includes("/portal/login?error=expired"), "flag off → POST redirects to the expired page");
  assert.equal(
    (database.prepare("SELECT consumed_at FROM portal_access_tokens WHERE id = 'mr-off'").get() as { consumed_at: string | null }).consumed_at,
    null,
    "flag off → the live token is never consumed",
  );

  console.log("portal verify route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
