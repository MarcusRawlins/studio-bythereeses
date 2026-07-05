import assert from "node:assert/strict";

import {
  CSP_BASELINE_DIRECTIVES,
  CSP_HEADER_ENFORCE,
  CSP_HEADER_REPORT_ONLY,
  buildCsp,
  cspHeaderName,
  cspMode,
} from "./csp";

// ---------------------------------------------------------------------------
// buildCsp with a nonce → nonce'd script-src + baseline hardening directives.
// ---------------------------------------------------------------------------
const withNonce = buildCsp("abc123");
assert.match(withNonce, /script-src 'self' 'nonce-abc123' 'strict-dynamic'/, "script-src carries the nonce + strict-dynamic");
assert.ok(withNonce.includes("base-uri 'self'"), "base-uri hardening present");
assert.ok(withNonce.includes("object-src 'none'"), "object-src hardening present");
assert.ok(withNonce.includes("frame-ancestors 'none'"), "frame-ancestors hardening present");
assert.ok(withNonce.includes("upgrade-insecure-requests"), "upgrade-insecure-requests hardening present");
assert.ok(withNonce.endsWith(CSP_BASELINE_DIRECTIVES), "nonce'd CSP ends with the exact baseline directives");

// ---------------------------------------------------------------------------
// buildCsp(null) → the cache-safe baseline: NO script-src (so Next's inline
// bootstrap stays allowed) and byte-identical to today's static proxy CSP.
// ---------------------------------------------------------------------------
const baseline = buildCsp(null);
assert.equal(baseline, CSP_BASELINE_DIRECTIVES, "null nonce yields exactly the baseline directives");
assert.ok(!baseline.includes("script-src"), "baseline has NO script-src (inline bootstrap allowed)");
assert.equal(
  baseline,
  "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
  "baseline matches today's static proxy CSP exactly (zero behavior change)",
);

// An empty-string nonce is treated as null (cache-safe), never as a literal
// `'nonce-'` that would be un-matchable and break all scripts.
assert.equal(buildCsp(""), CSP_BASELINE_DIRECTIVES, "empty nonce falls back to the baseline");

// ---------------------------------------------------------------------------
// cspMode: three-state, default off; only the exact opt-in values enable it.
// ---------------------------------------------------------------------------
assert.equal(cspMode({}), "off", "unset → off");
assert.equal(cspMode({ CSP_MODE: "" }), "off", "empty → off");
assert.equal(cspMode({ CSP_MODE: "1" }), "off", "arbitrary value → off (cannot be enabled by accident)");
assert.equal(cspMode({ CSP_MODE: "Report" }), "off", "case-sensitive: 'Report' → off");
assert.equal(cspMode({ CSP_MODE: "report" }), "report", "'report' → report");
assert.equal(cspMode({ CSP_MODE: "enforce" }), "enforce", "'enforce' → enforce");

// ---------------------------------------------------------------------------
// cspHeaderName: report → Report-Only, enforce → enforced CSP.
// ---------------------------------------------------------------------------
assert.equal(cspHeaderName("report"), CSP_HEADER_REPORT_ONLY, "report mode → Content-Security-Policy-Report-Only");
assert.equal(cspHeaderName("enforce"), CSP_HEADER_ENFORCE, "enforce mode → Content-Security-Policy");
assert.equal(cspHeaderName("off"), CSP_HEADER_ENFORCE, "off returns the enforce name for totality");
assert.equal(CSP_HEADER_ENFORCE, "content-security-policy");
assert.equal(CSP_HEADER_REPORT_ONLY, "content-security-policy-report-only");

console.log("csp buildCsp + mode + header-name tests passed");
