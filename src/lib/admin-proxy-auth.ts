// Phase 6 §2 (M4): defense-in-depth admin authorization.
//
// The Pages proxy validates the Google admin session and, for genuine admin
// surfaces, stamps a signed `x-reese-admin-proof` header on the request it
// forwards to the origin (see `pages-proxy/_worker.js`). This module lets the
// app independently verify that proof so admin authorization no longer rests on
// a single layer (the proxy). Verification is bound to method + host + path +
// timestamp so a captured proof cannot be replayed against a different route,
// host, or outside a short time window.
//
// [Fable-fix — crypto] This runs in `src/middleware.ts`, which is deployed on
// the EDGE runtime by OpenNext. It MUST NOT use `node:crypto`. All hashing here
// uses WebCrypto (`crypto.subtle`), mirroring the proxy's own `hmac()` helper.

export const ADMIN_PROOF_HEADER = "x-reese-admin-proof";

/** Default replay window: a proof is accepted within ±300s of its timestamp. */
export const DEFAULT_MAX_SKEW_SECONDS = 300;

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

/**
 * Length-checked, constant-time string comparison over UTF-8 bytes. Returns
 * false immediately on a length mismatch (lengths are not secret), otherwise
 * accumulates the XOR of every byte so the loop's timing does not depend on
 * where the first differing byte sits.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i += 1) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

/** The shared admin-proof secret, or undefined when unset (verification fails closed). */
function adminProofSecret(): string | undefined {
  const configured = process.env.ADMIN_PROOF_SECRET?.trim();
  return configured || undefined;
}

export type VerifyAdminProxyProofOptions = {
  /** Current time in unix SECONDS. Defaults to `Date.now()/1000`. */
  now?: number;
  /** Accepted timestamp window in seconds (two-sided). Defaults to 300. */
  maxSkewSeconds?: number;
};

/**
 * Verifies the `x-reese-admin-proof` header set by the trusted proxy. Returns
 * `true` only when ALL of the following hold:
 *   - `ADMIN_PROOF_SECRET` is configured (else fails closed, never throws);
 *   - the header is present and shaped `v1.{tsSeconds}.{sigBase64url}`;
 *   - `tsSeconds` is within `maxSkewSeconds` of now (two-sided);
 *   - the HMAC over `method\nhost\npath\ntsSeconds` (host = `x-forwarded-host`)
 *     matches the supplied signature in constant time.
 *
 * Any malformed input results in `false` — the caller decides what a false
 * result means (block vs. fall through), and it must NEVER crash the middleware.
 */
export async function verifyAdminProxyProof(
  request: Request,
  opts?: VerifyAdminProxyProofOptions,
): Promise<boolean> {
  try {
    const secret = adminProofSecret();
    if (!secret) return false;

    const header = request.headers.get(ADMIN_PROOF_HEADER);
    if (!header) return false;

    const parts = header.split(".");
    if (parts.length !== 3) return false;
    const [version, tsRaw, providedSig] = parts;
    if (version !== "v1" || !tsRaw || !providedSig) return false;

    const tsSeconds = Number(tsRaw);
    if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return false;

    const now = opts?.now ?? Math.floor(Date.now() / 1000);
    const maxSkew = opts?.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
    if (Math.abs(now - tsSeconds) > maxSkew) return false;

    const url = new URL(request.url);
    const host = request.headers.get("x-forwarded-host") || url.host;
    const value = `${request.method}\n${host}\n${url.pathname}\n${tsSeconds}`;
    const expected = await hmacSha256Base64Url(secret, value);
    return constantTimeEqual(providedSig, expected);
  } catch {
    // Any unexpected error (malformed URL, crypto failure) fails closed without
    // throwing so middleware can never 500 on a bad/absent proof.
    return false;
  }
}

/**
 * Three-state break-glass flag driving admin-proof handling:
 *   - "enforce" (`ADMIN_PROOF_ENFORCE === "1"`): fail a required proof -> 404.
 *   - "log" (`ADMIN_PROOF_ENFORCE === "log"`): observation window — evaluate the
 *     proof for required paths and `console.warn` on failure, but NEVER block.
 *   - "off" (unset / anything else): zero-overhead default — the proof is not
 *     evaluated at all (fail-open, no behavior change).
 * Instant rollback from any state is `wrangler secret delete ADMIN_PROOF_ENFORCE`.
 */
export type AdminProofMode = "off" | "log" | "enforce";

export function adminProofMode(
  env?: { ADMIN_PROOF_ENFORCE?: string },
): AdminProofMode {
  const flag = (env ?? process.env).ADMIN_PROOF_ENFORCE;
  if (flag === "1") return "enforce";
  if (flag === "log") return "log";
  return "off";
}

/** True when the break-glass enforcement flag is explicitly on (`ADMIN_PROOF_ENFORCE === "1"`). */
export function adminProofEnforced(
  env?: { ADMIN_PROOF_ENFORCE?: string },
): boolean {
  return adminProofMode(env) === "enforce";
}

// --------------------------------------------------------------------------
// Surface classification
//
// `adminProofRequired(pathname)` decides whether a request path is a genuine
// admin surface (proof required under enforcement) or a public/token/agent/
// webhook surface (never requires a proof). It is NOT the naive negation of the
// proxy's public-path lists:
//   - [Fable-fix, BLOCKING] `/portal` (+ `/portal/proposals/…`) is the CLIENT
//     portal and MUST stay public — a naive negation would 404 the whole portal
//     under enforcement.
//   - Trailing slashes are normalized before matching so this classifier can
//     never disagree with the proxy's `/?`-tolerant questionnaire regexes.
// A drift test (see `admin-surface-classification.test.ts`) pins this against
// the proxy's own public-path predicates so the two cannot silently diverge.
// --------------------------------------------------------------------------

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "") || "/";
  }
  return pathname;
}

function isStaticAssetPath(path: string): boolean {
  return (
    path === "/favicon.ico" ||
    path === "/icon.png" ||
    path === "/apple-icon.png" ||
    path.startsWith("/_next/static/") ||
    path.startsWith("/_next/image") ||
    path.startsWith("/brand/") ||
    path.startsWith("/fonts/")
  );
}

export function adminProofRequired(pathname: string): boolean {
  const path = normalizePath(pathname);

  // Static assets (favicon/brand/fonts/_next) — never an admin surface.
  if (isStaticAssetPath(path)) return false;

  // Proxy-terminated admin auth surfaces (no origin session exists yet).
  if (path === "/admin/login" || path === "/admin/logout" || path === "/admin/auth/google") {
    return false;
  }

  // Trusted agent APIs — authenticated by the shared bearer token, not the proxy proof.
  if (path === "/api/mcp" || path.startsWith("/api/agent/")) return false;

  // Provider webhooks / OAuth / cron — authenticated by their own signatures or origin bypass.
  if (path === "/api/stripe/webhook") return false;
  if (path.startsWith("/api/google/")) return false;
  if (path.startsWith("/api/cron/")) return false;

  // Client portal (public, client-reachable). BLOCKING: keep `/portal` public.
  if (path === "/portal" || path.startsWith("/portal/proposals/")) return false;
  if (path.startsWith("/p/")) return false;

  // Proposal token surfaces (token in the URL is the credential).
  if (path.startsWith("/proposal/") || path.startsWith("/api/proposal/")) return false;

  // Public booking pages.
  if (path.startsWith("/book/")) return false;

  // Private asset serving — signed URL / portal / proposal token is the credential;
  // the route itself enforces it, and the proxy never stamps a proof here.
  if (path.startsWith("/api/assets/")) return false;

  // Public questionnaire routes (preview / confirmed / response submission).
  if (/^\/questionnaires\/[^/]+\/(preview|confirmed)$/.test(path)) return false;
  if (/^\/api\/questionnaires\/[^/]+\/responses$/.test(path)) return false;

  // Scheduler: the public booking API is open, but the admin-only forms
  // (`meeting-types`, `settings`) are the DELIBERATE hardening exception — they
  // are proxy-public on the schedule host yet require an admin proof at the
  // origin. Assert this side effect in the drift test.
  if (
    path === "/api/scheduler/meeting-types" ||
    path.startsWith("/api/scheduler/meeting-types/") ||
    path === "/api/scheduler/settings" ||
    path.startsWith("/api/scheduler/settings/")
  ) {
    return true;
  }
  if (path.startsWith("/api/scheduler/")) return false;

  // Everything else reaching the origin is a genuine admin page/API.
  return true;
}
