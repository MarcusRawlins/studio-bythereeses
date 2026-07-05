import type { R2Bucket, R2ObjectBody } from "@cloudflare/workers-types";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { eq } from "drizzle-orm";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { db } from "@/db/client";
import { assetObjects } from "@/db/schema";
import { logActivity } from "@/lib/activity";

// Storage-only primitives for private R2 assets (contract/invoice PDFs, project
// source files, and reserved gallery files). Serving (the authenticated proxy
// route + signed URLs) is a separate, later phase — this module only ever
// writes/reads/soft-deletes objects and their D1 metadata rows.

export type AssetKind = "contract_pdf" | "invoice_pdf" | "project_source_file" | "gallery_file";
export type AssetCreatedBy = "admin" | "agent" | "system";
export type AssetRow = typeof assetObjects.$inferSelect;

const ASSET_KINDS = new Set<AssetKind>(["contract_pdf", "invoice_pdf", "project_source_file", "gallery_file"]);

export type PutAssetInput = {
  kind: AssetKind;
  projectId: string;
  proposalId?: string | null;
  invoiceId?: string | null;
  body: ArrayBuffer | ReadableStream | Uint8Array;
  contentType: string;
  filename?: string | null;
  createdBy: AssetCreatedBy;
};

export type PutAssetResult = {
  assetId: string;
  key: string;
  sha256: string;
  sizeBytes: number;
};

/**
 * Reads the CRM_ASSETS R2 binding from the current Cloudflare context.
 * Throws if the binding is not configured — callers must not silently no-op
 * against a missing private-storage bucket.
 */
export function assetsBucket(): R2Bucket {
  const bucket = (getCloudflareContext().env as { CRM_ASSETS?: R2Bucket }).CRM_ASSETS;
  if (!bucket) {
    throw new Error("CRM_ASSETS R2 binding is not configured.");
  }
  return bucket;
}

function requireNonEmpty(value: string | null | undefined, message: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
}

// Ids (projectId/proposalId/invoiceId/assetId) are interpolated directly into
// R2 keys, so they must never contain path separators or traversal sequences.
// This allow-list matches uuid and nanoid shapes and forbids "/", "\", ".",
// and anything else that could escape the intended key prefix.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function requireSafeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} must match /^[A-Za-z0-9_-]{1,64}$/ (got: ${JSON.stringify(value)}).`);
  }
  return value;
}

/**
 * Slugifies a user-supplied filename into a safe, non-traversable path
 * segment: lowercase ascii letters/digits/dot/dash/underscore only, no path
 * separators, no leading/trailing dots or dashes, and collapsed repeat dots
 * (so "..", "../.." etc. can never survive into a storage key). The
 * canonical identity of a stored object is always the server-generated
 * assetId, so this value only needs to stay readable — it is never trusted
 * for lookups or uniqueness.
 */
export function slugifyFilename(filename?: string | null): string {
  const fallback = "file";
  if (!filename) return fallback;

  const slug = filename
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 128);

  return slug || fallback;
}

function buildAssetKey(params: {
  kind: AssetKind;
  projectId: string;
  proposalId: string | null;
  invoiceId: string | null;
  assetId: string;
  safeFilename: string;
}): string {
  const { kind, projectId, proposalId, invoiceId, assetId, safeFilename } = params;

  // Every id segment is validated before it can reach a key — the slugified
  // filename is the only user-controlled segment and is sanitized separately.
  const safeProjectId = requireSafeId(projectId, "projectId");
  const safeAssetId = requireSafeId(assetId, "assetId");

  switch (kind) {
    case "contract_pdf": {
      const proposal = requireSafeId(
        requireNonEmpty(proposalId, "contract_pdf assets require a proposalId."),
        "proposalId",
      );
      return `contracts/${safeProjectId}/${proposal}/${safeAssetId}.pdf`;
    }
    case "invoice_pdf": {
      const invoice = requireSafeId(
        requireNonEmpty(invoiceId, "invoice_pdf assets require an invoiceId."),
        "invoiceId",
      );
      return `invoices/${safeProjectId}/${invoice}/${safeAssetId}.pdf`;
    }
    case "project_source_file":
      return `sources/${safeProjectId}/${safeAssetId}/${safeAssetId}-${safeFilename}`;
    case "gallery_file":
      return `galleries/${safeProjectId}/${safeAssetId}/${safeFilename}`;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unsupported asset kind: ${String(exhaustive)}`);
    }
  }
}

async function toUint8Array(body: ArrayBuffer | ReadableStream | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function activityActorName(createdBy: AssetCreatedBy): string {
  if (createdBy === "admin") return "Tyler Reese";
  if (createdBy === "agent") return "The Reeses Studio Agent";
  return "System";
}

/**
 * Computes the deterministic storage key, inserts the asset_objects row, writes
 * the object body to R2, and logs an `asset.created` activity entry.
 *
 * Ordering guarantee — no orphaned R2 object on failure: the D1 insert runs
 * BEFORE the R2 `.put()`. `buildAssetKey` first validates every id segment (so
 * a traversal-y id throws before any write), and the insert enforces the
 * project/proposal/invoice foreign keys — so an invalid or mismatched id fails
 * before a single byte reaches the bucket. If the R2 put itself fails after the
 * row lands, the row is deleted and the error re-thrown, so we never leave
 * either an orphaned object (object without row) or a dangling row (row without
 * object). The bucket binding is resolved up front so a missing binding also
 * fails before the insert.
 */
export async function putAsset(input: PutAssetInput): Promise<PutAssetResult> {
  if (!ASSET_KINDS.has(input.kind)) {
    throw new Error(`Unsupported asset kind: ${String(input.kind)}`);
  }

  const projectId = requireNonEmpty(input.projectId, "projectId is required.");
  const contentType = requireNonEmpty(input.contentType, "contentType is required.");
  const proposalId = input.proposalId?.trim() || null;
  const invoiceId = input.invoiceId?.trim() || null;

  const assetId = crypto.randomUUID();
  const safeFilename = slugifyFilename(input.filename);
  const key = buildAssetKey({ kind: input.kind, projectId, proposalId, invoiceId, assetId, safeFilename });

  const bytes = await toUint8Array(input.body);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sizeBytes = bytes.byteLength;

  // Resolve the binding before any DB write so a missing binding fails cleanly.
  const bucket = assetsBucket();

  const createdAt = new Date().toISOString();
  await db.insert(assetObjects).values({
    id: assetId,
    key,
    kind: input.kind,
    projectId,
    proposalId,
    invoiceId,
    contentType,
    sizeBytes,
    sha256,
    createdAt,
    createdBy: input.createdBy,
  });

  try {
    await bucket.put(key, bytes, { httpMetadata: { contentType } });
  } catch (error) {
    // R2 write failed after the row landed — roll the row back so we never
    // leave a metadata row pointing at a missing object.
    await db.delete(assetObjects).where(eq(assetObjects.id, assetId));
    throw error;
  }

  await logActivity({
    projectId,
    action: "asset.created",
    actorType: input.createdBy,
    actorName: activityActorName(input.createdBy),
    metadata: { assetId, key, kind: input.kind, contentType, sizeBytes, proposalId, invoiceId },
  });

  return { assetId, key, sha256, sizeBytes };
}

/** Raw R2 read by full object key. No D1 lookup/authorization here — that belongs to the serving route (Task 5). */
export async function getAssetObject(key: string): Promise<R2ObjectBody | null> {
  const object = await assetsBucket().get(key);
  return object ?? null;
}

/** Fetches the asset_objects row (including soft-deleted rows) by id. */
export async function getAssetMeta(assetId: string): Promise<AssetRow | null> {
  const row = await db.query.assetObjects.findFirst({ where: eq(assetObjects.id, assetId) });
  return row ?? null;
}

/** Soft-deletes the asset_objects row and removes the object from R2. Idempotent. */
export async function deleteAsset(assetId: string): Promise<void> {
  const row = await getAssetMeta(assetId);
  if (!row) return;

  // Only stamp deletedAt the first time, but ALWAYS re-issue the R2 delete
  // (delete of a missing key is a no-op) so a prior soft-delete whose R2 delete
  // failed can't orphan the object in the bucket forever.
  if (!row.deletedAt) {
    await db
      .update(assetObjects)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(assetObjects.id, assetId));
  }

  await assetsBucket().delete(row.key);
}

// --------------------------------------------------------------------------
// Signed, time-limited asset URLs (serving path (b))
//
// Used for links embedded in Resend emails and inside generated PDFs, where no
// live portal/proposal session exists. The credential is the HMAC signature
// itself — the server-side code that mints the URL has already authorized the
// caller for `scope`/`scopeRef`, and the signature vouches for that decision.
// --------------------------------------------------------------------------

export type AssetUrlScope = "admin" | "portal" | "proposal";

/** The public GET serving route these signed URLs point at. */
export const ASSETS_PATH_PREFIX = "/api/assets/";

/** Hard maximum TTL for any signed asset URL: 7 days, regardless of caller input. */
export const ASSET_URL_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Resolves the HMAC secret for signed asset URLs. Fails CLOSED in production if
 * unset (throws) — mirroring the L5 `schedulerLinkSecret` pattern — so a
 * misconfigured deploy can never mint or accept unsigned-in-effect URLs. A
 * fixed dev fallback is used only outside production so local/test runs work.
 */
function r2UrlSigningSecret(): string {
  const configured = process.env.R2_URL_SIGNING_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("R2_URL_SIGNING_SECRET must be set in production.");
  }
  return "local-development-r2-url-signing-secret";
}

/** HMAC-SHA256 over `key\nexp\nscope\nscopeRef` -> base64url. */
function signAssetPayload(key: string, exp: number, scope: AssetUrlScope, scopeRef: string): string {
  const payload = `${key}\n${exp}\n${scope}\n${scopeRef}`;
  return createHmac("sha256", r2UrlSigningSecret()).update(payload).digest("base64url");
}

/**
 * Reconstructs the canonical R2 object key from a serving-route pathname
 * (`/api/assets/<key...>`). The key can contain slashes; each segment is
 * percent-decoded. Returns null for a pathname that is not an assets path or
 * that carries no key. Both `signAssetUrl` (which signs the exact key bytes)
 * and the serving route derive the key through this single function so their
 * HMAC inputs and DB lookups can never disagree.
 */
export function assetKeyFromPathname(pathname: string): string | null {
  if (!pathname.startsWith(ASSETS_PATH_PREFIX)) return null;
  const raw = pathname.slice(ASSETS_PATH_PREFIX.length);
  if (!raw) return null;
  try {
    return raw.split("/").map((segment) => decodeURIComponent(segment)).join("/");
  } catch {
    return null;
  }
}

export type SignAssetUrlOptions = {
  /** Requested lifetime in seconds. Floored to >= 1s and CAPPED at 7 days. */
  ttlSeconds: number;
  scope: AssetUrlScope;
  /** projectId or proposalId the caller was already authorized for. */
  scopeRef?: string | null;
};

/**
 * Mints a signed, time-limited relative URL for an existing (non-deleted)
 * asset: `/api/assets/{key}?exp={unix}&sc={scope}&ref={scopeRef}&sig={hmac}`.
 *
 * Throws if the asset is missing or soft-deleted (you cannot vend a link to an
 * object the serving route would 404 anyway). `ttlSeconds` is clamped to
 * [1, 7 days] so no caller — including a future email path passing a larger
 * value — can outlive the hard revocation window.
 */
export async function signAssetUrl(assetId: string, opts: SignAssetUrlOptions): Promise<string> {
  const meta = await getAssetMeta(assetId);
  if (!meta || meta.deletedAt) {
    throw new Error("Cannot sign a URL for a missing or deleted asset.");
  }

  const requestedTtl = Number.isFinite(opts.ttlSeconds) ? Math.floor(opts.ttlSeconds) : 0;
  const ttlSeconds = Math.min(Math.max(requestedTtl, 1), ASSET_URL_MAX_TTL_SECONDS);
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const scope = opts.scope;
  const scopeRef = opts.scopeRef?.trim() ?? "";
  const sig = signAssetPayload(meta.key, exp, scope, scopeRef);

  const encodedKey = meta.key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const params = new URLSearchParams({ exp: String(exp), sc: scope, ref: scopeRef, sig });
  return `${ASSETS_PATH_PREFIX}${encodedKey}?${params.toString()}`;
}

export type VerifyAssetUrlResult = {
  ok: boolean;
  key?: string;
  scope?: AssetUrlScope;
  scopeRef?: string;
};

/**
 * Verifies a signed asset URL: reconstructs the key from the pathname,
 * recomputes the HMAC over `key\nexp\nscope\nscopeRef`, and compares it to the
 * provided `sig` in constant time (mirrors `src/lib/agent-api.ts`). Rejects
 * (returns `{ ok: false }`) on a non-assets path, missing/garbage params, an
 * unknown scope, an expired `exp`, or any signature mismatch. The assetId is
 * intentionally NOT resolved here — the serving route performs the mandatory
 * key -> row lookup (row exists AND not soft-deleted) itself, so a valid
 * signature never bypasses that check.
 */
export function verifyAssetUrl(url: URL): VerifyAssetUrlResult {
  const key = assetKeyFromPathname(url.pathname);
  if (!key) return { ok: false };

  const expRaw = url.searchParams.get("exp");
  const scope = url.searchParams.get("sc");
  const scopeRef = url.searchParams.get("ref") ?? "";
  const sig = url.searchParams.get("sig");
  if (!expRaw || !scope || !sig) return { ok: false };
  if (scope !== "admin" && scope !== "portal" && scope !== "proposal") return { ok: false };

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= 0) return { ok: false };
  if (exp * 1000 < Date.now()) return { ok: false };

  const expected = signAssetPayload(key, exp, scope, scopeRef);
  const provided = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
    return { ok: false };
  }

  return { ok: true, key, scope, scopeRef };
}
