import assert from "node:assert/strict";
import pagesProxyWorker, {
  constantTimeEqual,
  isPortalPublicPath,
  isStudioPublicPath,
  rateLimitKind,
  verifyAdminSession,
} from "./_worker.js";

const textEncoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacBase64Url(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

async function main() {
  // ------------------------------------------------------------------
  // Phase-6 fix (a): /portal subtree public-path broadening.
  // ------------------------------------------------------------------
  assert.equal(isPortalPublicPath("/portal/proposals/abc"), true, "/portal/proposals/* is portal-public");
  assert.equal(isPortalPublicPath("/portal/login"), true, "/portal/login is portal-public");
  assert.equal(isPortalPublicPath("/portal/login/verify/tok"), true, "the verify route is portal-public");
  assert.equal(isPortalPublicPath("/portal"), true, "/portal (exact) stays portal-public");
  assert.equal(isPortalPublicPath("/p/token"), true, "/p/ token links stay portal-public");
  assert.equal(isStudioPublicPath("/api/portal/request-link"), true, "the request endpoint is studio-public");
  assert.equal(isStudioPublicPath("/admin/settings"), false, "genuine admin surfaces are not studio-public");

  // ------------------------------------------------------------------
  // Phase 6.5 rate-limit kinds + guard ordering.
  // ------------------------------------------------------------------
  assert.equal(
    rateLimitKind(new URL("https://studio.bythereeses.com/api/portal/request-link"), { method: "POST" }),
    "requestLink",
    "POST /api/portal/request-link → requestLink",
  );
  assert.equal(
    rateLimitKind(new URL("https://studio.bythereeses.com/portal/login/verify/tok"), { method: "GET" }),
    "tokenAccess",
    "GET verify route → tokenAccess (token consumption)",
  );
  assert.equal(
    rateLimitKind(new URL("https://studio.bythereeses.com/portal"), { method: "GET" }),
    "tokenAccess",
    "GET /portal → tokenAccess (unchanged)",
  );

  // ------------------------------------------------------------------
  // Phase-6 fix (b): constant-time compare.
  // ------------------------------------------------------------------
  assert.equal(constantTimeEqual("abcdef", "abcdef"), true, "equal strings compare true");
  assert.equal(constantTimeEqual("abcdef", "abcdeg"), false, "single-byte difference compares false");
  assert.equal(constantTimeEqual("abcdef", "abcde"), false, "different length compares false");

  // verifyAdminSession must reject a tampered signature (uses constantTimeEqual now).
  const secret = "admin-session-secret";
  const env = { ADMIN_SESSION_SECRET: secret, ADMIN_ALLOWED_EMAIL: "hello@bythereeses.com" };
  const payload = base64UrlEncode(
    textEncoder.encode(JSON.stringify({ email: "hello@bythereeses.com", expiresAt: Date.now() + 60_000 })),
  );
  const goodSig = await hmacBase64Url(secret, payload);
  const goodRequest = new Request("https://studio.bythereeses.com/projects", {
    headers: { cookie: `reese_studio_session=${payload}.${goodSig}` },
  });
  assert.equal(await verifyAdminSession(goodRequest, env), true, "a well-formed admin session verifies");

  const tamperedSig = goodSig.slice(0, -1) + (goodSig.endsWith("A") ? "B" : "A");
  const tamperedRequest = new Request("https://studio.bythereeses.com/projects", {
    headers: { cookie: `reese_studio_session=${payload}.${tamperedSig}` },
  });
  assert.equal(await verifyAdminSession(tamperedRequest, env), false, "a tampered signature is rejected");

  // ------------------------------------------------------------------
  // Integration: /portal/proposals/:id no longer bounces to /admin/login, but
  // genuine admin routes still do.
  // ------------------------------------------------------------------
  globalThis.caches = { default: { match: async () => undefined, put: async () => undefined } } as never;
  let forwarded: Request | null = null;
  globalThis.fetch = (async (request: Request) => {
    forwarded = request;
    return new Response("ok", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }) as never;

  const portalProposal = await pagesProxyWorker.fetch(
    new Request("https://studio.bythereeses.com/portal/proposals/abc"),
    { ORIGIN_PROXY_SECRET: "origin-secret" },
  );
  assert.equal(portalProposal.status, 200, "/portal/proposals/:id passes through the proxy to the origin");
  assert.ok(forwarded, "/portal/proposals/:id reaches the worker origin (self-protected there)");
  assert.notEqual(
    portalProposal.headers.get("location"),
    "https://studio.bythereeses.com/admin/login?next=%2Fportal%2Fproposals%2Fabc",
    "/portal/proposals/:id must not bounce to /admin/login",
  );

  forwarded = null;
  const adminRoute = await pagesProxyWorker.fetch(
    new Request("https://studio.bythereeses.com/admin/anything"),
    { ORIGIN_PROXY_SECRET: "origin-secret", ADMIN_SESSION_SECRET: secret },
  );
  assert.equal(adminRoute.status, 303, "genuine admin routes still require sign-in");
  assert.equal(
    adminRoute.headers.get("location"),
    "https://studio.bythereeses.com/admin/login?next=%2Fadmin%2Fanything",
    "genuine admin routes still bounce to /admin/login",
  );
  assert.equal(forwarded, null, "an unauthenticated admin route never reaches the origin");

  console.log("pages proxy portal magic-link tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
