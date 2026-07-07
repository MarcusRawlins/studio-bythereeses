// Phase 19 — embed token + timing nonce unit tests.
import assert from "node:assert/strict";

process.env.SCHEDULER_LINK_SECRET = "test-lead-form-links-secret";

import {
  createLeadFormEmbedToken,
  verifyLeadFormEmbedToken,
  mintFormNonce,
  verifyFormNonce,
  MIN_FILL_MS,
  MAX_AGE_MS,
} from "./lead-form-links";

// ---- MAX_AGE_MS is 8h (MAJOR-4) ----
assert.equal(MAX_AGE_MS, 1000 * 60 * 60 * 8, "MAX_AGE_MS is 8h");

// ================= Embed token =================
const token = createLeadFormEmbedToken(0);
assert.ok(token.includes("."), "token is payload.signature (contains a dot — must ride in ?t=, not the path)");
assert.ok(verifyLeadFormEmbedToken(token, { rev: 0 }), "valid token verifies at matching rev");

// Revocation (MEDIUM-7): rev mismatch → rejected.
assert.equal(verifyLeadFormEmbedToken(token, { rev: 1 }), null, "token.rev !== config.rev → rejected");

// A rev-1 token verifies only at rev 1.
const tokenRev1 = createLeadFormEmbedToken(1);
assert.ok(verifyLeadFormEmbedToken(tokenRev1, { rev: 1 }), "rev-1 token verifies at rev 1");
assert.equal(verifyLeadFormEmbedToken(tokenRev1, { rev: 0 }), null, "rev-1 token rejected at rev 0");

// Missing / tampered token → null.
assert.equal(verifyLeadFormEmbedToken(null, { rev: 0 }), null, "missing token → null");
assert.equal(verifyLeadFormEmbedToken("", { rev: 0 }), null, "empty token → null");
assert.equal(verifyLeadFormEmbedToken("garbage", { rev: 0 }), null, "malformed token → null");
const [payload] = token.split(".");
assert.equal(verifyLeadFormEmbedToken(`${payload}.tampered`, { rev: 0 }), null, "tampered signature → null");

// The token carries NO PII — only { v, formId, rev }.
const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
assert.deepEqual(Object.keys(decoded).sort(), ["formId", "rev", "v"], "token payload has no PII fields");

// ================= Timing nonce =================
const minted = mintFormNonce(1_000_000);
assert.ok(minted.id, "nonce carries an id");
assert.ok(minted.token.includes("."), "nonce token is payload.signature");

// Two mints yield DIFFERENT ids (MEDIUM-1: crypto.randomUUID, never a counter/timestamp) — proves
// two simultaneous loads never collide on the webform:<id> dedup.
const a = mintFormNonce(1_000_000);
const b = mintFormNonce(1_000_000);
assert.notEqual(a.id, b.id, "two nonces minted at the SAME instant have different ids (MEDIUM-1)");

// Too fast (< MIN_FILL_MS) → bot signal.
const fast = verifyFormNonce(minted.token, 1_000_000 + MIN_FILL_MS - 1);
assert.equal(fast.status, "too_fast", "sub-MIN_FILL_MS → too_fast");

// Within window → ok, id round-trips.
const ok = verifyFormNonce(minted.token, 1_000_000 + MIN_FILL_MS + 5_000);
assert.equal(ok.status, "ok", "within window → ok");
assert.equal(ok.status === "ok" && ok.id, minted.id, "verified nonce returns the minted id");

// Older than MAX_AGE_MS → stale (NOT a silent drop; the route 303s back to a re-rendered form).
const stale = verifyFormNonce(minted.token, 1_000_000 + MAX_AGE_MS + 1);
assert.equal(stale.status, "stale", "> MAX_AGE_MS → stale");

// Missing / tampered nonce → invalid.
assert.equal(verifyFormNonce(null).status, "invalid", "missing nonce → invalid");
assert.equal(verifyFormNonce("garbage").status, "invalid", "malformed nonce → invalid");
const [noncePayload] = minted.token.split(".");
assert.equal(verifyFormNonce(`${noncePayload}.tampered`).status, "invalid", "tampered nonce signature → invalid");

console.log("lead-form links (token + nonce) tests passed");
