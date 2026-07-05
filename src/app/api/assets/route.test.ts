import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-assets-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

const CLOUDFLARE_CONTEXT_SYMBOL = Symbol.for("__cloudflare-context__");
const DEV_SIGNING_SECRET = "local-development-r2-url-signing-secret";

class FakeR2Bucket {
  objects = new Map<string, { body: Uint8Array; httpMetadata?: { contentType?: string } }>();

  async put(key: string, body: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { body, httpMetadata: options?.httpMetadata });
    return { key };
  }

  async get(key: string) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return { key, httpMetadata: entry.httpMetadata, body: entry.body };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

function setCloudflareContext(env: Record<string, unknown>) {
  (globalThis as unknown as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT_SYMBOL] = { env, cf: {}, ctx: {} };
}

function futureIso(days = 1) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function main() {
  const bucket = new FakeR2Bucket();
  setCloudflareContext({ CRM_ASSETS: bucket });

  const { rawDb } = await import("@/db/client");
  const { putAsset, signAssetUrl } = await import("@/lib/assets");
  const { GET } = await import("./[...key]/route");

  const database = rawDb();
  const now = "2026-07-05T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Other Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO proposals (id, project_id, title, status, created_at, updated_at)
    VALUES
      ('proposal-1', 'project-1', 'P1', 'sent', ?, ?),
      ('proposal-2', 'project-2', 'P2', 'sent', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoices (id, project_id, proposal_id, invoice_number, status, created_at, updated_at)
    VALUES ('invoice-1', 'project-1', 'proposal-1', 'INV-0001', 'sent', ?, ?)
  `).run(now, now);

  // Portal session token for project-1 (valid, not revoked, future expiry).
  // token_hash must be canonical sha256 hex (enforced by a DB trigger).
  const portalTokenHash = createHash("sha256").update("raw-portal-token-xyz").digest("hex");
  database.prepare(`
    INSERT INTO portal_access_tokens (id, project_id, client_id, token_hash, label, expires_at, created_at)
    VALUES ('portal-token-1', 'project-1', 'client-1', ?, 'Portal', ?, ?)
  `).run(portalTokenHash, futureIso(), now);

  // Proposal access token for proposal-1 (raw token -> sha256 hex hash).
  const rawProposalToken = "raw-proposal-token-abc";
  const proposalTokenHash = createHash("sha256").update(rawProposalToken).digest("hex");
  database.prepare(`
    INSERT INTO proposal_access_tokens (id, proposal_id, project_id, client_id, token_hash, label, expires_at, created_at)
    VALUES ('proposal-token-1', 'proposal-1', 'project-1', 'client-1', ?, 'Proposal', ?, ?)
  `).run(proposalTokenHash, futureIso(), now);

  const contractBytes = new TextEncoder().encode("%PDF-1.4 contract project-1");
  const contract1 = await putAsset({
    kind: "contract_pdf", projectId: "project-1", proposalId: "proposal-1",
    body: contractBytes, contentType: "application/pdf", createdBy: "admin",
  });
  const invoice1 = await putAsset({
    kind: "invoice_pdf", projectId: "project-1", invoiceId: "invoice-1",
    body: new TextEncoder().encode("%PDF-1.4 invoice project-1"), contentType: "application/pdf", createdBy: "admin",
  });
  const gallery1 = await putAsset({
    kind: "gallery_file", projectId: "project-1",
    body: new TextEncoder().encode("gallery bytes"), contentType: "image/jpeg", filename: "shot.jpg", createdBy: "admin",
  });
  const contract2 = await putAsset({
    kind: "contract_pdf", projectId: "project-2", proposalId: "proposal-2",
    body: new TextEncoder().encode("%PDF-1.4 contract project-2"), contentType: "application/pdf", createdBy: "admin",
  });

  async function get(pathAndQuery: string, init?: RequestInit) {
    const url = new URL(`https://studio.test${pathAndQuery}`);
    const keyPart = url.pathname.slice("/api/assets/".length);
    const segments = keyPart.split("/").map((s) => decodeURIComponent(s));
    const request = new Request(url.toString(), init);
    return GET(request, { params: Promise.resolve({ key: segments }) });
  }

  const silence = () => {};
  const originalError = console.error;

  // 1. No credential -> 404.
  assert.equal((await get(`/api/assets/${contract1.key}`)).status, 404, "unsigned request must 404");

  // 2. Unknown key -> 404.
  assert.equal((await get(`/api/assets/contracts/project-1/proposal-1/does-not-exist.pdf`)).status, 404, "unknown key must 404");

  // 3. Valid signed URL -> 200 with stored content-type, private no-store, inline.
  const signedContract = await signAssetUrl(contract1.assetId, { ttlSeconds: 900, scope: "admin" });
  const okResponse = await get(signedContract);
  assert.equal(okResponse.status, 200, "valid signed URL must 200");
  assert.equal(okResponse.headers.get("content-type"), "application/pdf");
  assert.equal(okResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(okResponse.headers.get("content-disposition"), "inline");
  assert.equal(okResponse.headers.get("x-content-type-options"), "nosniff", "served asset must carry nosniff");
  assert.equal(new TextDecoder().decode(new Uint8Array(await okResponse.arrayBuffer())), "%PDF-1.4 contract project-1");

  // download=1 flips content-disposition to attachment.
  const attach = await get(`${signedContract}&download=1`);
  assert.equal(attach.status, 200);
  assert.match(attach.headers.get("content-disposition") ?? "", /^attachment;/);

  // 4. Soft-deleted asset -> 404 even with an otherwise-valid signed URL (row lookup first).
  const signedGallery = await signAssetUrl(gallery1.assetId, { ttlSeconds: 900, scope: "portal", scopeRef: "project-1" });
  const bucketBefore = bucket.objects.size;
  const { deleteAsset } = await import("@/lib/assets");
  await deleteAsset(gallery1.assetId);
  assert.equal((await get(signedGallery)).status, 404, "soft-deleted asset must 404 via a pre-minted signed URL");
  assert.equal(bucket.objects.size, bucketBefore - 1, "gallery object was removed by deleteAsset");

  // 5. Expired signed URL (past exp, otherwise-valid signature) -> 404.
  const expiredExp = Math.floor(Date.now() / 1000) - 60;
  const expiredSig = createHmac("sha256", process.env.R2_URL_SIGNING_SECRET || DEV_SIGNING_SECRET)
    .update(`${contract1.key}\n${expiredExp}\nadmin\n`).digest("base64url");
  assert.equal(
    (await get(`/api/assets/${contract1.key}?exp=${expiredExp}&sc=admin&ref=&sig=${expiredSig}`)).status,
    404,
    "expired signed URL must 404",
  );

  // 6. Tampered signature -> 404.
  const tampered = new URL(`https://studio.test${signedContract}`);
  const sig = tampered.searchParams.get("sig") ?? "";
  tampered.searchParams.set("sig", sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A"));
  assert.equal((await get(tampered.pathname + tampered.search)).status, 404, "tampered signature must 404");

  // 7. Portal session cookie.
  const portalCookie = "portal_token_id=portal-token-1; portal_project_id=project-1";
  // 7a. Same-project invoice_pdf via portal cookie -> 200.
  const portalOk = await get(`/api/assets/${invoice1.key}`, { headers: { cookie: portalCookie } });
  assert.equal(portalOk.status, 200, "portal cookie may read same-project invoice_pdf");
  // 7b. Foreign-project contract via the same portal cookie -> 404 (project mismatch).
  console.error = silence;
  const foreignPortal = await get(`/api/assets/${contract2.key}`, { headers: { cookie: portalCookie } });
  console.error = originalError;
  assert.equal(foreignPortal.status, 404, "portal token must not read a foreign project's asset");
  // 7c. Revoked/expired portal token cookie -> 404.
  database.prepare(`UPDATE portal_access_tokens SET revoked_at = ? WHERE id = 'portal-token-1'`).run(now);
  assert.equal(
    (await get(`/api/assets/${invoice1.key}`, { headers: { cookie: portalCookie } })).status,
    404,
    "revoked portal token must 404",
  );
  database.prepare(`UPDATE portal_access_tokens SET revoked_at = NULL WHERE id = 'portal-token-1'`).run();
  // 7d. A cookie pointing at a magic_request-kind token must NOT authorize an
  // asset read (N4, extended): only kind:"session" tokens serve assets, even
  // when the row is live and scoped to the right project.
  const magicHash = createHash("sha256").update("raw-magic-request-token").digest("hex");
  database.prepare(`
    INSERT INTO portal_access_tokens (id, project_id, client_id, token_hash, label, kind, request_batch_id, expires_at, created_at)
    VALUES ('portal-magic-1', 'project-1', 'client-1', ?, 'Self-service magic link', 'magic_request', 'batch-1', ?, ?)
  `).run(magicHash, futureIso(), now);
  const magicCookie = "portal_token_id=portal-magic-1; portal_project_id=project-1";
  assert.equal(
    (await get(`/api/assets/${invoice1.key}`, { headers: { cookie: magicCookie } })).status,
    404,
    "a magic_request token cookie must not authorize an asset read",
  );

  // 8. Proposal token (?token=), contract_pdf scoped to its proposal only.
  // 8a. Its own contract -> 200, with NO write side effects (N2): the asset GET
  // must not stamp viewedAt/lastUsedAt or flip the proposal status to "viewed".
  const proposalBefore = (database.prepare(`SELECT status FROM proposals WHERE id = 'proposal-1'`).get()) as { status: string };
  const tokenBefore = (database.prepare(`SELECT viewed_at, last_used_at FROM proposal_access_tokens WHERE id = 'proposal-token-1'`).get()) as { viewed_at: string | null; last_used_at: string | null };
  const proposalOk = await get(`/api/assets/${contract1.key}?token=${rawProposalToken}`);
  assert.equal(proposalOk.status, 200, "proposal token may read its own contract_pdf");
  assert.equal(proposalOk.headers.get("x-content-type-options"), "nosniff", "served asset must carry nosniff");
  const proposalAfter = (database.prepare(`SELECT status FROM proposals WHERE id = 'proposal-1'`).get()) as { status: string };
  const tokenAfter = (database.prepare(`SELECT viewed_at, last_used_at FROM proposal_access_tokens WHERE id = 'proposal-token-1'`).get()) as { viewed_at: string | null; last_used_at: string | null };
  assert.equal(proposalAfter.status, proposalBefore.status, "asset GET must not flip the proposal status");
  assert.equal(proposalAfter.status, "sent", "proposal status stays 'sent' (never flipped to 'viewed')");
  assert.deepEqual(tokenAfter, tokenBefore, "asset GET must not stamp the proposal token (viewedAt/lastUsedAt)");
  assert.equal(tokenAfter.viewed_at, null, "proposal token viewedAt stays null after an asset GET");
  assert.equal(tokenAfter.last_used_at, null, "proposal token lastUsedAt stays null after an asset GET");
  // 8b. Another proposal's contract -> 404.
  console.error = silence;
  const foreignProposal = await get(`/api/assets/${contract2.key}?token=${rawProposalToken}`);
  console.error = originalError;
  assert.equal(foreignProposal.status, 404, "proposal token must not read a foreign proposal's contract");
  // 8c. An invoice_pdf (not contract_pdf) -> 404 even with a valid proposal token.
  assert.equal(
    (await get(`/api/assets/${invoice1.key}?token=${rawProposalToken}`)).status,
    404,
    "proposal token is limited to contract_pdf",
  );

  // 9. [N1] Signed-URL scope/scopeRef cross-check against the resolved asset row.
  // A valid signature is not enough: a portal/proposal-scoped signature must be
  // bound to THIS asset's project/proposal, else uniform 404.
  // contract1 is project-1 / proposal-1.
  const portalSignedWrong = await signAssetUrl(contract1.assetId, { ttlSeconds: 900, scope: "portal", scopeRef: "project-2" });
  assert.equal((await get(portalSignedWrong)).status, 404, "portal-scope signed URL with a foreign projectId must 404");
  const portalSignedRight = await signAssetUrl(contract1.assetId, { ttlSeconds: 900, scope: "portal", scopeRef: "project-1" });
  assert.equal((await get(portalSignedRight)).status, 200, "portal-scope signed URL with the matching projectId must 200");

  const proposalSignedWrong = await signAssetUrl(contract1.assetId, { ttlSeconds: 900, scope: "proposal", scopeRef: "proposal-2" });
  assert.equal((await get(proposalSignedWrong)).status, 404, "proposal-scope signed URL with a foreign proposalId must 404");
  const proposalSignedRight = await signAssetUrl(contract1.assetId, { ttlSeconds: 900, scope: "proposal", scopeRef: "proposal-1" });
  assert.equal((await get(proposalSignedRight)).status, 200, "proposal-scope signed URL with the matching proposalId must 200");

  // A portal-scoped signature (even with a real projectId ref) must not read a
  // foreign project's asset — the ref must match THIS asset's row.
  const portalSignedForeign = await signAssetUrl(contract2.assetId, { ttlSeconds: 900, scope: "portal", scopeRef: "project-1" });
  assert.equal((await get(portalSignedForeign)).status, 404, "portal-scope signature must not read another project's asset");

  console.log("assets route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
