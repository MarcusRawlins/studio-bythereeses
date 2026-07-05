import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { assetObjects, portalAccessTokens, proposalAccessTokens } from "@/db/schema";
import type { AssetRow } from "@/lib/assets";
import { assetKeyFromPathname, getAssetObject, verifyAssetUrl } from "@/lib/assets";
import { hashProposalToken } from "@/lib/sales";

// Private R2 object serving (Section 1, path (a)). GET only.
//
// Auth-decision order — the FIRST match authorizes; anything else is a 404 (never
// 403: no info leak, matching the repo's proposal-404 posture):
//   0. [Fable-fix, mandatory] Resolve the asset_objects row by key (row exists AND
//      deletedAt IS NULL) BEFORE any R2 read, so raw keys can't be probed and
//      soft-deletes are honored even before the object is physically removed.
//   a. Valid signed asset URL (verifyAssetUrl) — self-authorizing; the server-side
//      minter already vetted scope/scopeRef and the HMAC vouches for it. Also the
//      seam for admin access (scope='admin' URLs minted by admin code) until the
//      Task-6 admin-proxy-proof path lands.
//   b. Portal session (cookie) scoped to the object's project_id, for
//      contract_pdf/invoice_pdf/gallery_file.
//   c. Proposal token (?token=) scoped to the object's proposal_id, contract_pdf only.
export const dynamic = "force-dynamic";

const PORTAL_READABLE_KINDS = new Set<AssetRow["kind"]>(["contract_pdf", "invoice_pdf", "gallery_file"]);

function notFound() {
  // Uniform 404 for every failure mode (unknown key, soft-deleted, bad/expired
  // signature, token scope mismatch) so nothing distinguishes "exists but
  // forbidden" from "does not exist".
  return new NextResponse("Not Found", { status: 404 });
}

function parseCookieHeader(request: Request): Record<string, string> {
  const header = request.headers.get("cookie") ?? "";
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    out[name] = part.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Lean portal-session gate for the serving path. It replicates EXACTLY the
 * session check `requirePortalProject` performs (`src/lib/portal.ts:186-194`) —
 * token row exists, matches the projectId, is not revoked, and is not expired —
 * but sourced from the raw Cookie header rather than `next/headers`.
 *
 * Why not call `requirePortalProject` directly: it reads cookies via
 * `next/headers`, loads the ENTIRE portal project context (dozens of queries),
 * and logs a `portal.project_viewed` activity row on every call. Running that
 * per asset GET (a portal page can embed many images/PDFs) would be wasteful and
 * would spam the activity log. The portal session cookie stores the token
 * RECORD ID (not a secret), so verifying it is a scoped id lookup — no token
 * hashing is re-implemented here.
 */
async function portalSessionAuthorizes(request: Request, projectId: string): Promise<boolean> {
  const cookies = parseCookieHeader(request);
  const tokenId = cookies["portal_token_id"];
  const cookieProjectId = cookies["portal_project_id"];
  if (!tokenId || !cookieProjectId || cookieProjectId !== projectId) return false;

  const token = await db.query.portalAccessTokens.findFirst({
    where: and(
      eq(portalAccessTokens.id, tokenId),
      eq(portalAccessTokens.projectId, projectId),
      isNull(portalAccessTokens.revokedAt),
    ),
  });
  if (!token || new Date(token.expiresAt) < new Date()) return false;
  return true;
}

/**
 * Lean, SIDE-EFFECT-FREE proposal-token gate for the serving path. Mirrors
 * `portalSessionAuthorizes`: hash the raw token (reusing `hashProposalToken`
 * from `src/lib/sales.ts`), look up the proposal access token row, and enforce
 * not-revoked + not-expired + scoped to the object's proposal.
 *
 * Deliberately does NOT call `getProposalPackageByToken`: that helper WRITES on
 * every call (stamps viewedAt/lastUsedAt, flips proposal status
 * draft/ready/sent -> "viewed", logs a first-view activity). A client's
 * PDF-viewer prefetch of a contract asset must never mark the proposal "viewed"
 * before the human opens the real /proposal page — so asset GETs perform a pure
 * read-only authorization instead.
 */
async function proposalTokenAuthorizes(rawToken: string, proposalId: string): Promise<boolean> {
  const tokenRow = await db.query.proposalAccessTokens.findFirst({
    where: and(
      eq(proposalAccessTokens.tokenHash, hashProposalToken(rawToken)),
      isNull(proposalAccessTokens.revokedAt),
    ),
  });
  if (!tokenRow || new Date(tokenRow.expiresAt) < new Date()) return false;
  return tokenRow.proposalId === proposalId;
}

async function isAuthorized(request: Request, url: URL, asset: AssetRow): Promise<boolean> {
  // (a) Signed asset URL — includes the admin (scope='admin') path today.
  // TODO(Task 6 / M4): once `verifyAdminProxyProof` exists, admins presenting a
  // valid proxy proof may also be authorized here without a signed URL. Do not
  // hard-depend on it — admin access is served via scope='admin' signed URLs
  // until then.
  if (url.searchParams.has("sig") && verifyAssetUrl(url).ok) {
    return true;
  }

  // (c) Proposal token — contract_pdf scoped to the object's proposal_id only.
  const proposalToken = url.searchParams.get("token");
  if (
    proposalToken
    && asset.kind === "contract_pdf"
    && asset.proposalId
    && (await proposalTokenAuthorizes(proposalToken, asset.proposalId))
  ) {
    return true;
  }

  // (b) Portal session — project-scoped, contract/invoice/gallery kinds.
  if (PORTAL_READABLE_KINDS.has(asset.kind) && (await portalSessionAuthorizes(request, asset.projectId))) {
    return true;
  }

  return false;
}

export async function GET(request: Request, context: { params: Promise<{ key: string[] }> }) {
  const { key: keySegments } = await context.params;
  const url = new URL(request.url);

  // Derive the key from the pathname so it is byte-identical to the value the
  // signed-URL HMAC covers; fall back to the route params if needed.
  const key = assetKeyFromPathname(url.pathname)
    ?? (Array.isArray(keySegments) && keySegments.length ? keySegments.join("/") : null);
  if (!key) return notFound();

  // [Fable-fix] Row lookup (exists AND not soft-deleted) BEFORE any R2 read.
  const asset = await db.query.assetObjects.findFirst({
    where: and(eq(assetObjects.key, key), isNull(assetObjects.deletedAt)),
  });
  if (!asset) return notFound();

  if (!(await isAuthorized(request, url, asset))) return notFound();

  const object = await getAssetObject(key);
  if (!object) return notFound();

  const download = url.searchParams.get("download") === "1";
  const filename = key.split("/").pop() || "download";
  const headers = new Headers();
  headers.set("content-type", asset.contentType);
  headers.set("cache-control", "private, no-store");
  // Never let a browser MIME-sniff an owned asset (esp. inline gallery files)
  // into an executable/other type.
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-disposition",
    download ? `attachment; filename="${filename.replace(/["\\]/g, "")}"` : "inline",
  );

  return new NextResponse(object.body as unknown as ReadableStream<Uint8Array>, { status: 200, headers });
}
