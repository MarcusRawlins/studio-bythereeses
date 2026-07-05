import assert from "node:assert/strict";
import { ORIGIN_SECRET_HEADER } from "@/lib/origin-guard";
import { ADMIN_PROOF_HEADER } from "@/lib/admin-proxy-auth";
import { CSP_HEADER_ENFORCE, CSP_HEADER_REPORT_ONLY } from "@/lib/csp";
import { config, middleware } from "./middleware";

process.env.ORIGIN_PROXY_SECRET = "origin-secret";
process.env.ADMIN_PROOF_SECRET = "test-admin-proof-secret";
// Fail-open by default: the enforcement flag is unset for the first block.
delete process.env.ADMIN_PROOF_ENFORCE;
// CSP defaults OFF for the whole admin-proof suite so those assertions see no
// new headers / behavior (the CSP block below sets CSP_MODE explicitly).
delete process.env.CSP_MODE;

const WORKER_ORIGIN = "https://reese-photography-crm.solitary-flower-c3ab.workers.dev";
const STUDIO_HOST = "studio.bythereeses.com";
const SCHEDULE_HOST = "schedule.bythereeses.com";
const encoder = new TextEncoder();

// The nonce Next reads is threaded via `NextResponse.next({ request })`, which
// encodes the overridden request headers onto the response as
// `x-middleware-request-*` (+ `x-middleware-override-headers`). Tests read those
// to confirm the request header Next parses carries the SAME nonce as the
// response CSP header (the documented Next 16 nonce contract).
function nonceInCsp(csp: string | null): string | null {
  if (!csp) return null;
  const match = csp.match(/'nonce-([^']+)'/);
  return match ? match[1] : null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function proofFor(method: string, host: string, path: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(process.env.ADMIN_PROOF_SECRET ?? ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`${method}\n${host}\n${path}\n${ts}`));
  return `v1.${ts}.${base64UrlEncode(new Uint8Array(sig))}`;
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`${WORKER_ORIGIN}${path}`, init);
}

async function withWarnSpy(run: () => Promise<void>): Promise<string[]> {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

async function main() {
// ---------------------------------------------------------------------------
// Existing origin-guard behavior (now async).
// ---------------------------------------------------------------------------
assert.equal((await middleware(req("/projects/project-123") as never)).status, 404);
assert.equal((await middleware(req("/api/projects", { method: "POST" }) as never)).status, 404);
assert.equal((await middleware(req("/api/finance/ar-aging.csv") as never)).status, 404);

const allowed = await middleware(
  req("/projects/project-123", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" } }) as never,
);
assert.equal(allowed.status, 200);

const allowedPublicApi = await middleware(
  req("/api/proposal/token-123/accept", { method: "POST" }) as never,
);
assert.equal(allowedPublicApi.status, 200);

// ---------------------------------------------------------------------------
// M4 fail-open: with ADMIN_PROOF_ENFORCE unset, an admin path with NO proof is
// NOT blocked (zero behavior change). The origin secret is supplied so the
// origin guard passes and we isolate the admin-proof decision.
// ---------------------------------------------------------------------------
const failOpen = await middleware(
  req("/finance", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" } }) as never,
);
assert.equal(failOpen.status, 200, "admin path must NOT be blocked when ADMIN_PROOF_ENFORCE is unset (fail-open)");

// ---------------------------------------------------------------------------
// M4 enforced: ADMIN_PROOF_ENFORCE=1.
// ---------------------------------------------------------------------------
process.env.ADMIN_PROOF_ENFORCE = "1";

// Admin path, no proof -> 404.
const enforcedNoProof = await middleware(
  req("/finance", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" } }) as never,
);
assert.equal(enforcedNoProof.status, 404, "admin path with no proof must 404 under enforcement");

// Admin path with a valid proof -> allowed. Host is bound to x-forwarded-host.
const now = Math.floor(Date.now() / 1000);
const validProof = await proofFor("GET", STUDIO_HOST, "/finance", now);
const enforcedWithProof = await middleware(
  req("/finance", {
    headers: {
      [ORIGIN_SECRET_HEADER]: "origin-secret",
      "x-forwarded-host": STUDIO_HOST,
      [ADMIN_PROOF_HEADER]: validProof,
    },
  }) as never,
);
assert.equal(enforcedWithProof.status, 200, "admin path with a valid proof must be allowed under enforcement");

// A stale/tampered proof still 404s under enforcement.
const staleProof = await proofFor("GET", STUDIO_HOST, "/finance", now - 10_000);
const enforcedStaleProof = await middleware(
  req("/finance", {
    headers: {
      [ORIGIN_SECRET_HEADER]: "origin-secret",
      "x-forwarded-host": STUDIO_HOST,
      [ADMIN_PROOF_HEADER]: staleProof,
    },
  }) as never,
);
assert.equal(enforcedStaleProof.status, 404, "admin path with an expired proof must 404 under enforcement");

// /portal is NEVER blocked, even under enforcement and with no proof.
const portalEnforced = await middleware(
  req("/portal", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" } }) as never,
);
assert.equal(portalEnforced.status, 200, "/portal must never be blocked, even under enforcement");

// A public token surface (proposal) is likewise never proof-gated.
const proposalEnforced = await middleware(
  req("/api/proposal/token-123/accept", { method: "POST" }) as never,
);
assert.equal(proposalEnforced.status, 200, "public proposal API must not be proof-gated under enforcement");

// ---------------------------------------------------------------------------
// M4 log-only observation window: ADMIN_PROOF_ENFORCE="log". Evaluates the proof
// for admin surfaces and warns on failure, but NEVER blocks.
// ---------------------------------------------------------------------------
process.env.ADMIN_PROOF_ENFORCE = "log";

// Admin path, no proof -> 200 (not blocked) AND exactly one structured warn.
const logNoProofWarnings = await withWarnSpy(async () => {
  const res = await middleware(
    req("/finance", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" } }) as never,
  );
  assert.equal(res.status, 200, "log mode must NOT block an admin path missing a proof");
});
assert.equal(logNoProofWarnings.length, 1, "log mode emits exactly one warn for a missing proof");
assert.match(
  logNoProofWarnings[0],
  /^\[admin-proof\] missing\/invalid proof for GET \/finance$/,
  "log warn line is structured and identifies the method + path",
);

// Admin path WITH a valid proof -> 200 and NO warn.
const logValidProof = await proofFor("GET", STUDIO_HOST, "/finance", Math.floor(Date.now() / 1000));
const logValidWarnings = await withWarnSpy(async () => {
  const res = await middleware(
    req("/finance", {
      headers: {
        [ORIGIN_SECRET_HEADER]: "origin-secret",
        "x-forwarded-host": STUDIO_HOST,
        [ADMIN_PROOF_HEADER]: logValidProof,
      },
    }) as never,
  );
  assert.equal(res.status, 200, "log mode allows a valid proof");
});
assert.equal(logValidWarnings.length, 0, "log mode does not warn when the proof is valid");

// /portal never warns or blocks in log mode.
const logPortalWarnings = await withWarnSpy(async () => {
  const res = await middleware(
    req("/portal", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" } }) as never,
  );
  assert.equal(res.status, 200, "/portal is never blocked in log mode");
});
assert.equal(logPortalWarnings.length, 0, "/portal never warns in log mode");

delete process.env.ADMIN_PROOF_ENFORCE;

// ---------------------------------------------------------------------------
// M4 off (default): with the flag unset the proof is never evaluated — even an
// admin path carrying a bogus proof is neither blocked nor warned (zero work).
// ---------------------------------------------------------------------------
const offWarnings = await withWarnSpy(async () => {
  const res = await middleware(
    req("/finance", {
      headers: { [ORIGIN_SECRET_HEADER]: "origin-secret", [ADMIN_PROOF_HEADER]: "v1.123.bogus" },
    }) as never,
  );
  assert.equal(res.status, 200, "off mode never blocks an admin path");
});
assert.equal(offWarnings.length, 0, "off mode never warns (proof not evaluated at all)");

// ===========================================================================
// Phase 6 §4 (L8): CSP nonce. Three-state CSP_MODE, default OFF. Admin proof is
// left OFF (flag deleted above) so these assertions isolate the CSP decision.
// ===========================================================================

// --- CSP_MODE unset (off): ZERO new behavior. A Studio document route gets a
// plain next() with NO CSP header and NO request-header override. ---
delete process.env.CSP_MODE;
const cspOff = await middleware(
  req("/finance", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret", "x-forwarded-host": STUDIO_HOST } }) as never,
);
assert.equal(cspOff.status, 200, "off: studio route still served");
assert.equal(cspOff.headers.get(CSP_HEADER_ENFORCE), null, "off: no enforced CSP header emitted");
assert.equal(cspOff.headers.get(CSP_HEADER_REPORT_ONLY), null, "off: no report-only CSP header emitted");
assert.equal(
  cspOff.headers.get("x-middleware-request-content-security-policy"),
  null,
  "off: no nonce threaded onto the request headers Next reads",
);

// --- CSP_MODE=report: a dynamic Studio route gets a nonce'd Report-Only header;
// the page is never enforced with the nonce (zero behavior change). ---
process.env.CSP_MODE = "report";
const cspReport = await middleware(
  req("/finance", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret", "x-forwarded-host": STUDIO_HOST } }) as never,
);
assert.equal(cspReport.status, 200, "report: studio route served");
const reportHeader = cspReport.headers.get(CSP_HEADER_REPORT_ONLY);
assert.ok(reportHeader, "report: Report-Only header present");
assert.equal(cspReport.headers.get(CSP_HEADER_ENFORCE), null, "report: NO enforced CSP (page unaffected)");
assert.match(reportHeader ?? "", /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/, "report: nonce'd script-src present");
assert.ok((reportHeader ?? "").includes("base-uri 'self'"), "report: baseline hardening merged in");
// The doc contract: the CSP the browser sees and the CSP request header Next
// parses carry the SAME nonce.
const reportNonce = nonceInCsp(reportHeader);
assert.ok(reportNonce, "report: a nonce is present in the response CSP");
assert.equal(
  cspReport.headers.get("x-middleware-request-x-nonce"),
  reportNonce,
  "report: x-nonce request header matches the response CSP nonce",
);
assert.equal(
  cspReport.headers.get("x-middleware-request-content-security-policy"),
  reportHeader,
  "report: the request CSP header Next reads equals the response CSP value",
);

// Two requests to the same route MUST carry DIFFERENT nonces (per-request).
const cspReport2 = await middleware(
  req("/finance", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret", "x-forwarded-host": STUDIO_HOST } }) as never,
);
assert.notEqual(
  nonceInCsp(cspReport2.headers.get(CSP_HEADER_REPORT_ONLY)),
  reportNonce,
  "report: each request gets a unique nonce",
);

// --- [Fable-fix] Keyed off x-forwarded-host: the public SCHEDULE host is never
// nonced (its /book/* HTML is proxy-cached; a frozen nonce would mismatch). ---
const cspBookingCacheable = await middleware(
  req("/book/wedding-photography-discovery-call", { headers: { "x-forwarded-host": SCHEDULE_HOST } }) as never,
);
assert.equal(cspBookingCacheable.status, 200, "report: booking page served");
assert.equal(cspBookingCacheable.headers.get(CSP_HEADER_REPORT_ONLY), null, "report: NO nonce on cacheable /book/*");
assert.equal(cspBookingCacheable.headers.get(CSP_HEADER_ENFORCE), null, "report: no CSP header emitted for /book/*");
assert.equal(
  cspBookingCacheable.headers.get("x-middleware-request-content-security-policy"),
  null,
  "report: no nonce threaded for /book/* (baseline CSP applies via the proxy)",
);

// Belt-and-suspenders: a /book/* GET with NO x-forwarded-host (dev/preview, no
// proxy) is still recognized as cacheable booking and gets no nonce.
const cspBookingDev = await middleware(req("/book/wedding-photography-discovery-call") as never);
assert.equal(cspBookingDev.headers.get(CSP_HEADER_REPORT_ONLY), null, "report: /book/* without x-forwarded-host still gets no nonce");

// --- API routes are not documents → never nonced, even under report. ---
const cspApi = await middleware(
  req("/api/settings", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret", "x-forwarded-host": STUDIO_HOST } }) as never,
);
assert.equal(cspApi.headers.get(CSP_HEADER_REPORT_ONLY), null, "report: /api/* is never nonced");
assert.equal(cspApi.headers.get(CSP_HEADER_ENFORCE), null, "report: /api/* emits no CSP header");

// --- Prefetch requests are skipped (Next guidance) even on a Studio route. ---
const cspPrefetch = await middleware(
  req("/finance", {
    headers: { [ORIGIN_SECRET_HEADER]: "origin-secret", "x-forwarded-host": STUDIO_HOST, "next-router-prefetch": "1" },
  }) as never,
);
assert.equal(cspPrefetch.headers.get(CSP_HEADER_REPORT_ONLY), null, "report: prefetch requests are not nonced");

// --- CSP_MODE=enforce: the nonce'd policy is enforced (Content-Security-Policy),
// no Report-Only header. ---
process.env.CSP_MODE = "enforce";
const cspEnforce = await middleware(
  req("/finance", { headers: { [ORIGIN_SECRET_HEADER]: "origin-secret", "x-forwarded-host": STUDIO_HOST } }) as never,
);
assert.equal(cspEnforce.status, 200, "enforce: studio route served");
const enforceHeader = cspEnforce.headers.get(CSP_HEADER_ENFORCE);
assert.ok(enforceHeader, "enforce: enforced CSP header present");
assert.equal(cspEnforce.headers.get(CSP_HEADER_REPORT_ONLY), null, "enforce: no Report-Only header");
assert.match(enforceHeader ?? "", /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/, "enforce: nonce'd script-src present");
const enforceNonce = nonceInCsp(enforceHeader);
assert.equal(
  cspEnforce.headers.get("x-middleware-request-x-nonce"),
  enforceNonce,
  "enforce: x-nonce request header matches the response CSP nonce",
);

// enforce also skips the schedule host / cacheable booking.
const cspEnforceBooking = await middleware(
  req("/book/wedding-photography-discovery-call", { headers: { "x-forwarded-host": SCHEDULE_HOST } }) as never,
);
assert.equal(cspEnforceBooking.headers.get(CSP_HEADER_ENFORCE), null, "enforce: cacheable /book/* still gets no nonce");

delete process.env.CSP_MODE;

assert.deepEqual(config.matcher, [
  "/api/:path*",
  "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|.*\\..*).*)",
]);

console.log("middleware origin guard + admin proof tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
