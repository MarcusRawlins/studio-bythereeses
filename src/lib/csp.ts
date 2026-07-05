// Phase 6 §4 (L8): Content-Security-Policy `script-src` via a Next.js per-request
// nonce. See docs/specs/phase-6-hardening-r2.md Section 4.
//
// SAFETY (mirrors the Task-6 admin-proof three-state pattern). A single Worker
// var `CSP_MODE` selects behavior; the DEFAULT is a true no-op:
//   - "off"  (unset / any other value): the middleware emits NO CSP header, so
//            the proxy keeps applying today's static baseline. ZERO behavior
//            change on deploy — impossible to break the live site without a
//            deliberate flag flip.
//   - "report": the middleware emits `Content-Security-Policy-Report-Only` with
//            the nonce'd `script-src`. The ENFORCED policy stays the baseline
//            (no `script-src`), so the page is NEVER affected — violations are
//            only reported. Safe observation window.
//   - "enforce": the middleware emits the nonce'd `Content-Security-Policy`.
//            Tyler's deliberate step, only after a report-only window + preview
//            hydration validation (every nonced route must render dynamically).
//
// `buildCsp(nonce)`:
//   - with a nonce → nonce'd `script-src` + the baseline hardening directives.
//     Used for non-cacheable Studio + token document routes that render
//     dynamically.
//   - with `null` → the baseline only, NO `script-src`. Used for cacheable /
//     booking HTML: a frozen per-request nonce baked into cached HTML would
//     mismatch the per-request CSP header and block every script, and Next's
//     App Router always emits an inline bootstrap (`self.__next_f.push(...)`)
//     which a nonce-free `script-src 'self'` would ALSO block. Omitting
//     `script-src` keeps that inline bootstrap allowed (today's behavior).

/**
 * Baseline hardening directives, kept byte-identical to today's static proxy CSP
 * (`pages-proxy/_worker.js` SECURITY_HEADERS) so `buildCsp(null)` is a true
 * no-op and the proxy can pass an app CSP through verbatim.
 */
export const CSP_BASELINE_DIRECTIVES =
  "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests";

/**
 * Build the CSP directive string.
 *
 * @param nonce a per-request nonce for the enforced/observed `script-src`, or
 *   `null` for the cache-safe baseline (no `script-src`).
 */
export function buildCsp(nonce: string | null): string {
  if (!nonce) return CSP_BASELINE_DIRECTIVES;
  return `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; ${CSP_BASELINE_DIRECTIVES}`;
}

export type CspMode = "off" | "report" | "enforce";

/**
 * Three-state `CSP_MODE` flag. Anything other than the two explicit opt-in
 * values is treated as "off" so an empty/typo'd value can never enable CSP.
 */
export function cspMode(env?: { CSP_MODE?: string }): CspMode {
  // Read from process.env inside the body (not as a default param) so the narrow
  // param type never has to absorb the weak `ProcessEnv` type under strict TS.
  const value = (env ?? process.env).CSP_MODE;
  if (value === "enforce") return "enforce";
  if (value === "report") return "report";
  return "off";
}

export const CSP_HEADER_ENFORCE = "content-security-policy";
export const CSP_HEADER_REPORT_ONLY = "content-security-policy-report-only";

/**
 * The RESPONSE header name the middleware sets for a given mode:
 *   - "report"  → `Content-Security-Policy-Report-Only` (observe, never block).
 *   - otherwise → `Content-Security-Policy` (enforced).
 * Callers short-circuit before emitting anything in "off" mode; the enforce name
 * is returned for totality.
 */
export function cspHeaderName(mode: CspMode): string {
  return mode === "report" ? CSP_HEADER_REPORT_ONLY : CSP_HEADER_ENFORCE;
}
