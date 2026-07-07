// Phase 19 — signed embed token + per-render timing nonce for the embeddable lead form.
//
// This module MIRRORS `questionnaire-links.ts` (same HMAC-SHA256-over-base64url-payload shape,
// same constant-time verify, same `SCHEDULER_LINK_SECRET || AUTH_SECRET` secret that throws in
// production if unset). Two independent artifacts live here:
//
//   1. The EMBED TOKEN (`?t=<token>`). Binds only the form identity + a revocation counter
//      ({ v, formId, rev }). It carries NO PII and NO secret (I8). It is PUBLIC and reusable by
//      design (it sits in Tyler's marketing-page source) — it raises bot cost, it is NOT a spam
//      gate (see spec §4). It rides in a QUERY PARAM so the page path stays DOT-FREE and is
//      actually matched by the Next middleware page matcher (BLOCKER-1, spec §2). `rev` is checked
//      against `LeadFormConfig.rev` so an abused embed URL is revoked by a Settings edit (bump rev)
//      rather than a nuclear secret rotation (MEDIUM-7).
//
//   2. The TIMING NONCE (`formNonce`). Minted per GET render over { issuedAtMs, id }, where `id`
//      MUST be a `crypto.randomUUID()` (MEDIUM-1) — the `id` becomes the synthetic message_id
//      (`webform:${id}`) so a replay of one render dedups to a single row, and two simultaneous
//      loads never collide on the dedup. On POST the nonce gates timing: sub-MIN_FILL_MS is a bot
//      signal; older than MAX_AGE_MS (8h) is a slow-human STALE, never a silent drop (MAJOR-4).

import { createHmac, timingSafeEqual } from "node:crypto";

// The current embed-token version. Bumping this invalidates every outstanding token wholesale
// (distinct from `rev`, which is the per-config, admin-tunable revocation counter).
export const LEAD_FORM_TOKEN_VERSION = 1 as const;
export const DEFAULT_LEAD_FORM_ID = "default";

// Bots submit instantly; a genuine human takes more than a few seconds to read + fill.
export const MIN_FILL_MS = 3_000;
// A STALE nonce is NOT a bot signal (a couple composing a long inquiry is expected). 8h covers
// realistic compose times; replay is already neutralized by the `webform:${id}` dedup, so a long
// window costs nothing (spec §4.2 / MAJOR-4).
export const MAX_AGE_MS = 1000 * 60 * 60 * 8;

function leadFormLinkSecret() {
  const configured = process.env.SCHEDULER_LINK_SECRET || process.env.AUTH_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SCHEDULER_LINK_SECRET (or AUTH_SECRET) must be set in production.");
  }
  return "local-development-questionnaire-link-secret";
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

// HMAC domain-separation contexts (diff-review MINOR-2). The embed token and the timing nonce share
// the same secret and the same `${payload}.${sig}` shape (as do questionnaire/scheduler links on the
// same `SCHEDULER_LINK_SECRET`). Today the payload SHAPES are disjoint so no cross-protocol
// acceptance exists — but prefixing the HMAC input with a per-artifact context makes that structural:
// a signature minted as an embed token can never verify as a nonce (or vice versa, or as some future
// signer whose payload happens to share fields), because the signed bytes differ. The context is
// mixed into the HMAC input only; it is NOT part of the transmitted `${payload}.${sig}` string.
const EMBED_TOKEN_CONTEXT = "lead-form-embed-v1";
const FORM_NONCE_CONTEXT = "lead-form-nonce-v1";

function signPayload(payload: string, context: string) {
  return createHmac("sha256", leadFormLinkSecret()).update(`${context}\n${payload}`).digest("base64url");
}

// Constant-time signature check over the `${payload}.${signature}` shape, scoped to a domain
// context (MINOR-2). Returns the decoded payload string on a valid signature, else null. Pure HMAC —
// NO DB read (MINOR-1: this must be callable before any config fetch so a bad token 403s cheaply).
function verifySignedPayload(token: string | null | undefined, context: string): string | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = signPayload(payload, context);
  const signatureBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Embed token
// ---------------------------------------------------------------------------
export type LeadFormEmbedToken = {
  v: typeof LEAD_FORM_TOKEN_VERSION;
  formId: string;
  rev: number;
};

export function createLeadFormEmbedToken(rev: number, formId: string = DEFAULT_LEAD_FORM_ID): string {
  const payload = base64UrlEncode(JSON.stringify({
    v: LEAD_FORM_TOKEN_VERSION,
    formId,
    rev,
  } satisfies LeadFormEmbedToken));
  return `${payload}.${signPayload(payload, EMBED_TOKEN_CONTEXT)}`;
}

// Verifies ONLY the signature, the version, and the formId — NO `rev` check, and CRUCIALLY no DB
// read (diff-review MINOR-1). This restores the spec §4.1 "a bad token is rejected BEFORE any DB
// read" property: the submit route calls this first (pure HMAC), 403s a bad/tampered token, and only
// THEN fetches config to compare `rev`. Returns the decoded token (incl. its claimed `rev`) or null.
export function parseLeadFormEmbedToken(
  token: string | null | undefined,
  expected: { formId?: string } = {},
): LeadFormEmbedToken | null {
  const payload = verifySignedPayload(token, EMBED_TOKEN_CONTEXT);
  if (!payload) return null;
  try {
    const decoded = JSON.parse(base64UrlDecode(payload)) as LeadFormEmbedToken;
    if (decoded.v !== LEAD_FORM_TOKEN_VERSION) return null;
    if (decoded.formId !== (expected.formId ?? DEFAULT_LEAD_FORM_ID)) return null;
    if (typeof decoded.rev !== "number") return null;
    return decoded;
  } catch {
    return null;
  }
}

// Verifies the signature, the version, the formId, and — CRITICALLY — that the token's `rev`
// matches the live config `rev` (MEDIUM-7 revocation). Returns the decoded token or null. Layered on
// parseLeadFormEmbedToken so the signature/shape check and the rev-revocation check stay one code
// path; callers that already hold the config (the GET pages) use this, the submit route splits them.
export function verifyLeadFormEmbedToken(
  token: string | null | undefined,
  expected: { rev: number; formId?: string },
): LeadFormEmbedToken | null {
  const decoded = parseLeadFormEmbedToken(token, { formId: expected.formId });
  if (!decoded) return null;
  return decoded.rev === expected.rev ? decoded : null;
}

// ---------------------------------------------------------------------------
// Per-render timing nonce
// ---------------------------------------------------------------------------
export type FormNoncePayload = { issuedAtMs: number; id: string };

export type MintedFormNonce = { token: string; id: string; issuedAtMs: number };

export function mintFormNonce(now: number = Date.now()): MintedFormNonce {
  // `id` MUST be a crypto.randomUUID() (MEDIUM-1): two simultaneous GET renders must NEVER mint the
  // same id, or they collide on the `webform:${id}` INSERT-OR-IGNORE dedup and one lead is lost.
  const id = crypto.randomUUID();
  const payload = base64UrlEncode(JSON.stringify({ issuedAtMs: now, id } satisfies FormNoncePayload));
  return { token: `${payload}.${signPayload(payload, FORM_NONCE_CONTEXT)}`, id, issuedAtMs: now };
}

export type FormNonceVerdict =
  | { status: "ok"; id: string; issuedAtMs: number }
  // A genuine bot signal (submitted faster than a human could fill it).
  | { status: "too_fast" }
  // A slow human whose nonce aged out — NEVER a silent drop; 303 back to a re-rendered form.
  | { status: "stale" }
  // Missing / tampered / unparseable nonce.
  | { status: "invalid" };

export function verifyFormNonce(token: string | null | undefined, now: number = Date.now()): FormNonceVerdict {
  const payload = verifySignedPayload(token, FORM_NONCE_CONTEXT);
  if (!payload) return { status: "invalid" };
  let decoded: FormNoncePayload;
  try {
    decoded = JSON.parse(base64UrlDecode(payload)) as FormNoncePayload;
  } catch {
    return { status: "invalid" };
  }
  if (typeof decoded.issuedAtMs !== "number" || !Number.isFinite(decoded.issuedAtMs) || typeof decoded.id !== "string" || !decoded.id) {
    return { status: "invalid" };
  }
  const age = now - decoded.issuedAtMs;
  if (age < MIN_FILL_MS) return { status: "too_fast" };
  if (age > MAX_AGE_MS) return { status: "stale" };
  return { status: "ok", id: decoded.id, issuedAtMs: decoded.issuedAtMs };
}
