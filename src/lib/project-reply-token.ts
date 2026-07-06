import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Phase 14 — stateless signed project-reply token (two-way per-project email).
//
// The direct analog of `src/lib/unsubscribe-token.ts`: a keyed HMAC derivation
// with NO per-row secret stored. The token rides in the `Reply-To` of every
// outbound project email; a client reply to `reply+<token>@<inbox domain>` is
// verified here (Node-runtime inbound endpoint) and, on success, authorizes
// appending ONE inbound message row to that ONE project's thread — nothing else.
//
// The tag BINDS `projectId` (via the HMAC input), so a token minted for project
// A can never verify against project B (cross-thread injection impossible) — the
// same binding property that stops unsubscribe-token A from suppressing email B.
//
// Fail-closed: when `REPLY_TOKEN_SECRET` is unset, `mintProjectReplyToken`
// returns `null` (the outbound sender then omits `reply_to` ENTIRELY — never an
// empty-tag bouncing address), and `verifyProjectReplyToken` returns `null` for
// all input. Runtime is Node (`node:crypto` createHmac + timingSafeEqual) — the
// WebCrypto constraint applies only to the edge middleware, and verification
// deliberately lives in the Node endpoint, not the Email Worker.
// ---------------------------------------------------------------------------

const REPLY_TOKEN_PURPOSE = "project_reply\n";
const DEFAULT_REPLY_INBOX_DOMAIN = "inbox.bythereeses.com";

function replyTokenSecret(): string | null {
  const configured = process.env.REPLY_TOKEN_SECRET?.trim();
  return configured || null;
}

/** The reply subdomain the token address lives on (never `hello@`/`inquiries@`). */
export function replyInboxDomain(): string {
  return process.env.REPLY_INBOX_DOMAIN?.trim() || DEFAULT_REPLY_INBOX_DOMAIN;
}

// A canonical lowercase v4-shaped UUID (matching crypto.randomUUID() output).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** The 16 raw bytes of a UUID, or null when the id is not a well-formed UUID. */
function bytesFromUuid(projectId: string): Buffer | null {
  const lower = projectId.trim().toLowerCase();
  if (!UUID_PATTERN.test(lower)) return null;
  const hex = lower.replace(/-/g, "");
  if (hex.length !== 32) return null;
  const bytes = Buffer.from(hex, "hex");
  return bytes.length === 16 ? bytes : null;
}

/** Reconstruct the canonical lowercase UUID string from 16 raw bytes. */
function uuidFromBytes(bytes: Buffer): string | null {
  if (bytes.length !== 16) return null;
  const hex = bytes.toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID_PATTERN.test(uuid) ? uuid : null;
}

/** The 128-bit HMAC tag over the DECODED, lowercase projectId, base64url-encoded. */
function computeTag(secret: string, projectId: string): string {
  const mac = createHmac("sha256", secret).update(`${REPLY_TOKEN_PURPOSE}${projectId}`, "utf8").digest();
  return base64url(mac.subarray(0, 16));
}

/**
 * Mint a reply token for `projectId`, or `null` when `REPLY_TOKEN_SECRET` is
 * unset (fail-closed mint → the caller omits `reply_to` entirely). The token is
 * `base64url(uuid16).base64url(HMAC128)` — two 22-char base64url parts, 45 chars.
 */
export function mintProjectReplyToken(projectId: string): string | null {
  const secret = replyTokenSecret();
  if (!secret) return null;
  const raw16 = bytesFromUuid(projectId);
  if (!raw16) return null;
  const canonicalId = projectId.trim().toLowerCase();
  const idPart = base64url(raw16);
  const tag = computeTag(secret, canonicalId);
  return `${idPart}.${tag}`;
}

/** The full reply address (`reply+<token>@<inbox domain>`), or `null` when the
 * secret is unset — the sender then omits `reply_to`, keeping two-way dark. */
export function projectReplyToAddress(projectId: string): string | null {
  const token = mintProjectReplyToken(projectId);
  if (!token) return null;
  return `reply+${token}@${replyInboxDomain()}`;
}

/**
 * Verify a `idPart.tag` token, returning the bound `projectId` only when the
 * secret is configured, the token is well-formed, and the tag matches in
 * constant time. Any failure → `null` (fail-closed).
 *
 * Steps (spec §2.2): base64url-DECODE idPart → 16 raw bytes → reconstruct the
 * LOWERCASE UUID; recompute the HMAC over the DECODED projectId bytes (NOT the
 * raw idPart string); timingSafeEqual against the supplied tag.
 */
export function verifyProjectReplyToken(token: string | null | undefined): { projectId: string } | null {
  const secret = replyTokenSecret();
  if (!secret) return null; // fail closed — never attach on an unconfigured secret
  if (typeof token !== "string" || !token) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [idPart, providedTag] = parts;
  // base64url of 16 bytes is exactly 22 chars; of a 16-byte tag also 22 chars.
  if (idPart.length !== 22 || providedTag.length !== 22) return null;
  if (!/^[A-Za-z0-9_-]{22}$/.test(idPart) || !/^[A-Za-z0-9_-]{22}$/.test(providedTag)) return null;

  let raw16: Buffer;
  try {
    raw16 = Buffer.from(idPart, "base64url");
  } catch {
    return null;
  }
  if (raw16.length !== 16) return null;

  const projectId = uuidFromBytes(raw16);
  if (!projectId) return null;

  const expectedTag = computeTag(secret, projectId);
  const provided = Buffer.from(providedTag);
  const expected = Buffer.from(expectedTag);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  return { projectId };
}
