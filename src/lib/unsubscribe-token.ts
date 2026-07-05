import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Phase 8c — stateless signed unsubscribe token (RFC 8058 one-click).
//
// The token is an HMAC-SHA256 over `email|purpose`, keyed by a dedicated
// UNSUBSCRIBE_SECRET. No DB token row — it self-verifies (matches the
// "sign against a secret, verify constant-time" Active-Learning pattern).
//
// The signature BINDS the email, so a token issued for email A can never
// suppress email B. `purpose` scopes the token to a class of mail
// (`sequences`), so unsubscribing from sequences never suppresses transactional
// booking mail. Verification is FAIL-CLOSED: unset secret, malformed token, or
// signature mismatch all return null (the route answers 400). timingSafeEqual is
// available because both the email helper and the unsubscribe route run on the
// Node runtime (not the edge middleware).
// ---------------------------------------------------------------------------

function unsubscribeSecret(): string | null {
  const configured = process.env.UNSUBSCRIBE_SECRET?.trim();
  return configured || null;
}

function encodePayload(email: string, purpose: string): string {
  return Buffer.from(`${email}|${purpose}`, "utf8").toString("base64url");
}

/** Sign a token for `email` scoped to `purpose`. When the secret is unset the
 * signature is empty, so the produced token can never verify (fail-closed). */
export function signUnsubscribeToken(email: string, purpose: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  const secret = unsubscribeSecret();
  const payloadB64 = encodePayload(normalizedEmail, purpose);
  const signature = secret
    ? createHmac("sha256", secret).update(`${normalizedEmail}|${purpose}`, "utf8").digest("base64url")
    : "";
  return `${payloadB64}.${signature}`;
}

/** Verify a token, returning the bound email only when the secret is configured,
 * the token is well-formed, `purpose` matches, and the signature is valid
 * (constant-time). Any failure → null (the caller fails closed with a 400). */
export function verifyUnsubscribeToken(token: string | null | undefined, expectedPurpose: string): { email: string } | null {
  const secret = unsubscribeSecret();
  if (!secret) return null; // fail closed — never suppress on an unconfigured secret
  if (typeof token !== "string" || !token) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, providedSig] = parts;
  if (!payloadB64 || !providedSig) return null;

  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const segments = payload.split("|");
  if (segments.length !== 2) return null;
  const [email, purpose] = segments;
  if (!email || purpose !== expectedPurpose) return null;

  const expectedSig = createHmac("sha256", secret).update(`${email}|${purpose}`, "utf8").digest("base64url");
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  return { email: email.toLowerCase() };
}

/** The public base URL the unsubscribe link points at (the proxy-fronted studio
 * host — the client-facing surface). Never the workers.dev origin. */
export function unsubscribeBaseUrl(): string {
  return (
    process.env.UNSUBSCRIBE_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_STUDIO_URL?.trim() ||
    "https://studio.bythereeses.com"
  );
}
