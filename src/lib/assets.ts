import type { R2Bucket, R2ObjectBody } from "@cloudflare/workers-types";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";

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
