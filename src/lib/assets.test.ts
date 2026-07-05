import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-assets-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

const CLOUDFLARE_CONTEXT_SYMBOL = Symbol.for("__cloudflare-context__");

class FakeR2Bucket {
  objects = new Map<string, { body: Uint8Array; httpMetadata?: { contentType?: string } }>();

  async put(key: string, body: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { body, httpMetadata: options?.httpMetadata });
    return { key };
  }

  async get(key: string) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      key,
      httpMetadata: entry.httpMetadata,
      body: entry.body,
      async arrayBuffer() {
        return entry.body.buffer;
      },
    };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

function setCloudflareContext(env: Record<string, unknown>) {
  (globalThis as unknown as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT_SYMBOL] = { env, cf: {}, ctx: {} };
}

async function main() {
  const bucket = new FakeR2Bucket();
  setCloudflareContext({ CRM_ASSETS: bucket });

  const { rawDb } = await import("@/db/client");
  const {
    assetsBucket,
    slugifyFilename,
    putAsset,
    getAssetObject,
    getAssetMeta,
    deleteAsset,
  } = await import("./assets");

  const database = rawDb();
  const now = "2026-07-05T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposals (id, project_id, title, status, created_at, updated_at)
    VALUES ('proposal-1', 'project-1', 'Wedding Package', 'accepted', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (id, project_id, proposal_id, invoice_number, status, created_at, updated_at)
    VALUES ('invoice-1', 'project-1', 'proposal-1', 'INV-0001', 'sent', ?, ?)
  `).run(now, now);

  // --- assetsBucket() throws when unbound ---
  setCloudflareContext({});
  assert.throws(() => assetsBucket(), /CRM_ASSETS/);
  setCloudflareContext({ CRM_ASSETS: bucket });
  assert.equal(assetsBucket(), bucket);

  // --- slugifyFilename: determinism + traversal rejection ---
  assert.equal(slugifyFilename("Contract v2 (final).pdf"), slugifyFilename("Contract v2 (final).pdf"));
  const traversalSlug = slugifyFilename("../../../etc/passwd");
  assert.ok(!traversalSlug.includes(".."), `slug must not contain "..": ${traversalSlug}`);
  assert.ok(!traversalSlug.includes("/"), `slug must not contain "/": ${traversalSlug}`);
  assert.ok(!traversalSlug.includes("\\"), `slug must not contain "\\": ${traversalSlug}`);
  assert.equal(slugifyFilename("weird\\path/name.pdf").includes("/"), false);
  assert.equal(slugifyFilename(null), "file");
  assert.equal(slugifyFilename(""), "file");
  assert.equal(slugifyFilename("...."), "file");

  // --- putAsset: contract_pdf key scheme is deterministic ---
  const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake contract body");
  const contractResult = await putAsset({
    kind: "contract_pdf",
    projectId: "project-1",
    proposalId: "proposal-1",
    body: pdfBytes,
    contentType: "application/pdf",
    createdBy: "admin",
  });

  assert.equal(contractResult.key, `contracts/project-1/proposal-1/${contractResult.assetId}.pdf`);
  assert.equal(contractResult.sizeBytes, pdfBytes.byteLength);
  assert.equal(
    contractResult.sha256,
    createHash("sha256").update(pdfBytes).digest("hex"),
  );

  // Row written to D1 (via getAssetMeta) with the right FK + metadata.
  const contractMeta = await getAssetMeta(contractResult.assetId);
  assert.ok(contractMeta, "expected asset_objects row to exist");
  assert.equal(contractMeta?.key, contractResult.key);
  assert.equal(contractMeta?.kind, "contract_pdf");
  assert.equal(contractMeta?.projectId, "project-1");
  assert.equal(contractMeta?.proposalId, "proposal-1");
  assert.equal(contractMeta?.invoiceId, null);
  assert.equal(contractMeta?.contentType, "application/pdf");
  assert.equal(contractMeta?.createdBy, "admin");
  assert.equal(contractMeta?.deletedAt, null);

  // Object actually written to the fake R2 bucket.
  const storedObject = await getAssetObject(contractResult.key);
  assert.ok(storedObject, "expected object to be written to R2");
  assert.deepEqual(await storedObject?.arrayBuffer(), pdfBytes.buffer);

  // Activity log entry recorded.
  const activityRows = database
    .prepare("SELECT action, project_id, actor_type, metadata FROM activity_logs WHERE action = 'asset.created'")
    .all() as Array<{ action: string; project_id: string; actor_type: string; metadata: string }>;
  assert.equal(activityRows.length, 1);
  assert.equal(activityRows[0].project_id, "project-1");
  assert.equal(activityRows[0].actor_type, "admin");
  const activityMetadata = JSON.parse(activityRows[0].metadata) as { assetId: string; key: string };
  assert.equal(activityMetadata.assetId, contractResult.assetId);
  assert.equal(activityMetadata.key, contractResult.key);

  // --- putAsset: invoice_pdf key scheme ---
  const invoiceResult = await putAsset({
    kind: "invoice_pdf",
    projectId: "project-1",
    invoiceId: "invoice-1",
    body: new TextEncoder().encode("%PDF-1.4 fake invoice body"),
    contentType: "application/pdf",
    createdBy: "agent",
  });
  assert.equal(invoiceResult.key, `invoices/project-1/invoice-1/${invoiceResult.assetId}.pdf`);

  // --- putAsset: project_source_file rejects path traversal in the filename ---
  const sourceResult = await putAsset({
    kind: "project_source_file",
    projectId: "project-1",
    body: new TextEncoder().encode("raw source bytes"),
    contentType: "text/plain",
    filename: "../../../etc/passwd",
    createdBy: "system",
  });
  assert.equal(
    sourceResult.key,
    `sources/project-1/${sourceResult.assetId}/${sourceResult.assetId}-${slugifyFilename("../../../etc/passwd")}`,
  );
  assert.ok(!sourceResult.key.includes(".."), `key must not contain "..": ${sourceResult.key}`);
  assert.equal(sourceResult.key.split("/").filter((segment) => segment === "..").length, 0);
  // Every path segment must be either the fixed prefix, the projectId, the
  // assetId, or the slugified filename — never a raw user-controlled value.
  const sourceSegments = sourceResult.key.split("/");
  assert.equal(sourceSegments[0], "sources");
  assert.equal(sourceSegments[1], "project-1");
  assert.equal(sourceSegments[2], sourceResult.assetId);

  // --- putAsset: gallery_file key scheme ---
  const galleryResult = await putAsset({
    kind: "gallery_file",
    projectId: "project-1",
    body: new TextEncoder().encode("gallery bytes"),
    contentType: "image/jpeg",
    filename: "Beach Session #1.jpg",
    createdBy: "admin",
  });
  assert.equal(
    galleryResult.key,
    `galleries/project-1/${galleryResult.assetId}/${slugifyFilename("Beach Session #1.jpg")}`,
  );

  // --- putAsset: contract_pdf without a proposalId throws (no ambiguous key) ---
  await assert.rejects(
    () =>
      putAsset({
        kind: "contract_pdf",
        projectId: "project-1",
        body: new TextEncoder().encode("x"),
        contentType: "application/pdf",
        createdBy: "admin",
      }),
    /proposalId/,
  );

  // --- putAsset: a traversal-y id segment is REJECTED and writes NOTHING to R2 ---
  // projectId with path-escape characters must be refused before any object is
  // written, so it can never leave an orphaned, prefix-escaping R2 object.
  const bucketSizeBefore = bucket.objects.size;
  await assert.rejects(
    () =>
      putAsset({
        kind: "gallery_file",
        projectId: "proj-1/../../secrets",
        body: new TextEncoder().encode("evil"),
        contentType: "image/jpeg",
        filename: "a.jpg",
        createdBy: "admin",
      }),
    /projectId/,
  );
  assert.equal(bucket.objects.size, bucketSizeBefore, "no R2 object may be written for a traversal-y projectId");

  // A traversal-y proposalId is likewise refused (contract_pdf path).
  await assert.rejects(
    () =>
      putAsset({
        kind: "contract_pdf",
        projectId: "project-1",
        proposalId: "../../etc",
        body: new TextEncoder().encode("evil"),
        contentType: "application/pdf",
        createdBy: "admin",
      }),
    /proposalId/,
  );
  assert.equal(bucket.objects.size, bucketSizeBefore, "no R2 object may be written for a traversal-y proposalId");

  // A syntactically bad assetId is rejected by the same allow-list. putAsset
  // mints its own assetId, so we exercise the validation directly on
  // buildAssetKey's contract via the exported slug/key guard: an id containing
  // a slash must never build a key. We assert through putAsset by monkeypatching
  // crypto.randomUUID to return a traversal-y value for one call.
  const originalRandomUUID = crypto.randomUUID;
  (crypto as { randomUUID: () => string }).randomUUID = () => "bad/../id" as `${string}-${string}-${string}-${string}-${string}`;
  try {
    await assert.rejects(
      () =>
        putAsset({
          kind: "gallery_file",
          projectId: "project-1",
          body: new TextEncoder().encode("evil"),
          contentType: "image/jpeg",
          filename: "a.jpg",
          createdBy: "admin",
        }),
      /assetId/,
    );
  } finally {
    (crypto as { randomUUID: () => string }).randomUUID = originalRandomUUID;
  }
  assert.equal(bucket.objects.size, bucketSizeBefore, "no R2 object may be written for a bad assetId");

  // --- signAssetUrl / verifyAssetUrl round-trip ---
  const {
    signAssetUrl,
    verifyAssetUrl,
    assetKeyFromPathname,
    ASSET_URL_MAX_TTL_SECONDS,
  } = await import("./assets");

  const signed = await signAssetUrl(contractResult.assetId, {
    ttlSeconds: 900,
    scope: "portal",
    scopeRef: "project-1",
  });
  assert.ok(signed.startsWith(`/api/assets/${contractResult.key}?`), `unexpected signed path: ${signed}`);
  const signedUrl = new URL(`https://studio.test${signed}`);
  assert.equal(assetKeyFromPathname(signedUrl.pathname), contractResult.key);
  const roundTrip = verifyAssetUrl(signedUrl);
  assert.equal(roundTrip.ok, true);
  assert.equal(roundTrip.key, contractResult.key);
  assert.equal(roundTrip.scope, "portal");
  assert.equal(roundTrip.scopeRef, "project-1");

  // --- TTL cap: a caller asking for more than 7 days is clamped to 7 days ---
  const cappedSigned = await signAssetUrl(contractResult.assetId, {
    ttlSeconds: 30 * 24 * 60 * 60, // 30 days requested
    scope: "admin",
  });
  const cappedExp = Number(new URL(`https://studio.test${cappedSigned}`).searchParams.get("exp"));
  const nowSeconds = Math.floor(Date.now() / 1000);
  assert.ok(
    cappedExp - nowSeconds <= ASSET_URL_MAX_TTL_SECONDS + 5,
    `ttl must be capped at 7 days, got ${cappedExp - nowSeconds}s`,
  );
  assert.ok(cappedExp - nowSeconds > ASSET_URL_MAX_TTL_SECONDS - 60, "capped ttl should still be near 7 days");

  // --- tamper: flipping a byte of the signature fails verification ---
  const tampered = new URL(signedUrl.toString());
  const originalSig = tampered.searchParams.get("sig");
  const flipped = originalSig.slice(0, -1) + (originalSig.endsWith("A") ? "B" : "A");
  tampered.searchParams.set("sig", flipped);
  assert.equal(verifyAssetUrl(tampered).ok, false, "tampered signature must not verify");

  // --- tamper: changing scopeRef (covered by the HMAC) fails verification ---
  const scopeRefTampered = new URL(signedUrl.toString());
  scopeRefTampered.searchParams.set("ref", "project-2");
  assert.equal(verifyAssetUrl(scopeRefTampered).ok, false, "scopeRef is bound into the signature");

  // --- expiry: a past `exp` with an otherwise-valid signature is rejected ---
  const expiredExp = Math.floor(Date.now() / 1000) - 60;
  const expiredSig = createHmac(
    "sha256",
    process.env.R2_URL_SIGNING_SECRET || "local-development-r2-url-signing-secret",
  ).update(`${contractResult.key}\n${expiredExp}\nportal\nproject-1`).digest("base64url");
  const expiredUrl = new URL(
    `https://studio.test/api/assets/${contractResult.key}?exp=${expiredExp}&sc=portal&ref=project-1&sig=${expiredSig}`,
  );
  assert.equal(verifyAssetUrl(expiredUrl).ok, false, "expired signed URL must not verify");

  // --- wrong-secret: a URL signed under a different secret fails verification ---
  const previousSecret = process.env.R2_URL_SIGNING_SECRET;
  process.env.R2_URL_SIGNING_SECRET = "secret-A";
  const wrongSecretUrl = new URL(`https://studio.test${await signAssetUrl(contractResult.assetId, { ttlSeconds: 900, scope: "portal", scopeRef: "project-1" })}`);
  process.env.R2_URL_SIGNING_SECRET = "secret-B";
  assert.equal(verifyAssetUrl(wrongSecretUrl).ok, false, "URL signed with a different secret must not verify");
  if (previousSecret === undefined) delete process.env.R2_URL_SIGNING_SECRET;
  else process.env.R2_URL_SIGNING_SECRET = previousSecret;

  // --- non-assets path / missing params -> ok:false ---
  assert.equal(verifyAssetUrl(new URL("https://studio.test/not/assets?sig=x")).ok, false);
  assert.equal(verifyAssetUrl(new URL(`https://studio.test/api/assets/${contractResult.key}`)).ok, false);
  assert.equal(assetKeyFromPathname("/somewhere/else"), null);

  // --- fail CLOSED in production when the secret is unset ---
  const savedNodeEnv = process.env.NODE_ENV;
  const savedSecret = process.env.R2_URL_SIGNING_SECRET;
  process.env.NODE_ENV = "production";
  delete process.env.R2_URL_SIGNING_SECRET;
  await assert.rejects(
    () => signAssetUrl(contractResult.assetId, { ttlSeconds: 900, scope: "admin" }),
    /R2_URL_SIGNING_SECRET/,
  );
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedSecret === undefined) delete process.env.R2_URL_SIGNING_SECRET;
  else process.env.R2_URL_SIGNING_SECRET = savedSecret;

  // --- deleteAsset: soft-deletes the row and removes the R2 object ---
  await deleteAsset(contractResult.assetId);
  const afterDeleteMeta = await getAssetMeta(contractResult.assetId);
  assert.ok(afterDeleteMeta, "soft-deleted row must still exist in D1");
  assert.ok(afterDeleteMeta?.deletedAt, "deletedAt must be set after deleteAsset");
  const afterDeleteObject = await getAssetObject(contractResult.key);
  assert.equal(afterDeleteObject, null, "R2 object must be removed after deleteAsset");

  // deleteAsset is idempotent: calling again on an already-deleted asset is a no-op, no throw.
  await deleteAsset(contractResult.assetId);
  const secondDeleteMeta = await getAssetMeta(contractResult.assetId);
  assert.equal(secondDeleteMeta?.deletedAt, afterDeleteMeta?.deletedAt);

  // deleteAsset on an unknown assetId is a no-op, no throw.
  await deleteAsset("does-not-exist");

  // Untouched assets are unaffected by another asset's deletion.
  const invoiceMetaAfter = await getAssetMeta(invoiceResult.assetId);
  assert.equal(invoiceMetaAfter?.deletedAt, null);
  const invoiceObjectAfter = await getAssetObject(invoiceResult.key);
  assert.ok(invoiceObjectAfter, "unrelated asset object must remain in R2");

  // --- signAssetUrl refuses to vend a link for a soft-deleted asset ---
  await assert.rejects(
    () => signAssetUrl(contractResult.assetId, { ttlSeconds: 900, scope: "portal", scopeRef: "project-1" }),
    /missing or deleted/,
  );

  console.log("assets storage tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
