import assert from "node:assert/strict";
import pagesProxyWorker from "./_worker.js";

const workerOrigin = "https://reese-photography-crm.solitary-flower-c3ab.workers.dev";
let forwardedRequest: Request | null = null;

globalThis.caches = {
  default: {
    match: async () => undefined,
    put: async () => undefined,
  },
} as never;

globalThis.fetch = (async (request: Request) => {
  forwardedRequest = request;
  return new Response("ok", {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      location: `${workerOrigin}/book/wedding-photography-discovery-call`,
      "x-reese-origin-secret": "should-not-leak",
    },
  });
}) as never;

async function main() {
  const response = await pagesProxyWorker.fetch(
    new Request("https://schedule.bythereeses.com/book/wedding-photography-discovery-call"),
    { ORIGIN_PROXY_SECRET: "origin-secret" },
  );

  assert.ok(forwardedRequest, "pages proxy should forward the request to the worker origin");
  assert.equal(
    forwardedRequest.headers.get("x-reese-origin-secret"),
    "origin-secret",
    "pages proxy should send the origin secret only upstream",
  );
  assert.equal(
    response.headers.get("x-reese-origin-secret"),
    null,
    "pages proxy should not leak the origin secret back to the browser",
  );
  assert.equal(
    response.headers.get("x-reese-proxy-target"),
    null,
    "pages proxy should not expose the private worker origin to browsers",
  );
  assert.equal(
    response.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains; preload",
    "pages proxy should attach HSTS to browser responses",
  );
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
    "pages proxy should prevent framing public and Studio responses",
  );
  assert.equal(
    response.headers.get("location"),
    "https://schedule.bythereeses.com/book/wedding-photography-discovery-call",
    "pages proxy should still rewrite worker-origin redirects to the public host",
  );

  forwardedRequest = null;
  const agentApiResponse = await pagesProxyWorker.fetch(
    new Request("https://studio.bythereeses.com/api/agent/finance/report?paymentStatus=needs_reconciliation", {
      headers: {
        authorization: "Bearer agent-token",
      },
    }),
    { ORIGIN_PROXY_SECRET: "origin-secret" },
  );

  assert.equal(agentApiResponse.status, 200);
  assert.ok(forwardedRequest, "studio agent API requests should be forwarded to the Worker bearer-token guard");
  assert.equal(
    forwardedRequest.url,
    `${workerOrigin}/api/agent/finance/report?paymentStatus=needs_reconciliation`,
    "studio agent API requests should keep their path and query when proxied",
  );
  assert.equal(
    forwardedRequest.headers.get("authorization"),
    "Bearer agent-token",
    "studio agent API requests should preserve the bearer token for the Worker route",
  );
  assert.equal(
    forwardedRequest.headers.get("x-reese-origin-secret"),
    "origin-secret",
    "studio agent API requests should still include the upstream origin secret",
  );

  forwardedRequest = null;
  const protectedPageResponse = await pagesProxyWorker.fetch(
    new Request("https://studio.bythereeses.com/projects"),
    { ORIGIN_PROXY_SECRET: "origin-secret" },
  );

  assert.equal(protectedPageResponse.status, 303);
  assert.equal(
    protectedPageResponse.headers.get("location"),
    "https://studio.bythereeses.com/admin/login?next=%2Fprojects",
    "studio browser admin pages should still require Google sign-in",
  );
  assert.equal(forwardedRequest, null, "studio protected browser pages should not reach the Worker without a session");

  const loginResponse = await pagesProxyWorker.fetch(
    new Request("https://studio.bythereeses.com/admin/login?next=%2Fprojects"),
    { ORIGIN_PROXY_SECRET: "origin-secret" },
  );
  const loginHtml = await loginResponse.text();
  assert.equal(loginResponse.status, 200);
  assert.match(loginHtml, /The Reeses Studio/);
  assert.doesNotMatch(loginHtml, /Alex\s*&\s*Tyler|alex-tyler-logo|alt="Alex & Tyler"/i);
  assert.equal(loginResponse.headers.get("x-frame-options"), "DENY");

  let limitedResponse: Response | null = null;
  for (let index = 0; index < 61; index += 1) {
    limitedResponse = await pagesProxyWorker.fetch(
      new Request(`https://studio.bythereeses.com/proposal/test-token-${index}`, {
        headers: { "cf-connecting-ip": "203.0.113.10" },
      }),
      { ORIGIN_PROXY_SECRET: "origin-secret" },
    );
  }
  assert.equal(limitedResponse?.status, 429, "tokenized public links should be rate limited by client IP");
  assert.equal(limitedResponse?.headers.get("retry-after") !== null, true);
  assert.equal(limitedResponse?.headers.get("x-content-type-options"), "nosniff");

  // --------------------------------------------------------------------------
  // Phase 19 — lead-form framing carve-out (I6/MAJOR-3), cache-control (MAJOR-2),
  // and the leadForm 429 degrade-in-frame (MINOR-8). Drift pin: a future edit
  // cannot silently widen (or narrow) which paths are frameable.
  // --------------------------------------------------------------------------
  const relaxedFrameAncestors = /frame-ancestors 'self' https:\/\/bythereeses\.com https:\/\/www\.bythereeses\.com/;
  for (const embedPath of ["/embed/lead", "/embed/lead/thanks"]) {
    const embedRes = await pagesProxyWorker.fetch(
      new Request(`https://schedule.bythereeses.com${embedPath}?t=tok.sig`),
      { ORIGIN_PROXY_SECRET: "origin-secret" },
    );
    assert.match(embedRes.headers.get("content-security-policy") ?? "", relaxedFrameAncestors, `${embedPath} relaxes frame-ancestors to Tyler's domains`);
    assert.equal(embedRes.headers.get("x-frame-options"), null, `${embedPath} drops x-frame-options`);
    assert.equal(embedRes.headers.get("cache-control"), "private, no-store", `${embedPath} is no-store (MAJOR-2 — a cached page would freeze the nonce)`);
  }

  // The submit RESPONSE (the framed 303/error re-render) carries the SAME relaxed frame-ancestors
  // (MAJOR-3) — else a non-relaxed 3xx would render as a blank frame.
  const submitRes = await pagesProxyWorker.fetch(
    new Request("https://schedule.bythereeses.com/api/lead-form/submit", {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.7" },
    }),
    { ORIGIN_PROXY_SECRET: "origin-secret" },
  );
  assert.match(submitRes.headers.get("content-security-policy") ?? "", relaxedFrameAncestors, "submit response relaxes frame-ancestors (MAJOR-3)");
  assert.equal(submitRes.headers.get("x-frame-options"), null, "submit response drops x-frame-options");

  // A leadForm 429 (cap 10/600s) inside the frame degrades visibly, not as a blocked frame (MINOR-8).
  let submit429: Response | null = null;
  for (let i = 0; i < 11; i += 1) {
    submit429 = await pagesProxyWorker.fetch(
      new Request("https://schedule.bythereeses.com/api/lead-form/submit", {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.7" },
      }),
      { ORIGIN_PROXY_SECRET: "origin-secret" },
    );
  }
  assert.equal(submit429?.status, 429, "leadForm cap trips a 429");
  assert.match(submit429?.headers.get("content-security-policy") ?? "", relaxedFrameAncestors, "the leadForm 429 relaxes frame-ancestors (MINOR-8)");
  assert.equal(submit429?.headers.get("x-frame-options"), null, "the leadForm 429 drops x-frame-options");

  // A NON-lead path keeps the locked-down framing (no widening).
  const bookFrameRes = await pagesProxyWorker.fetch(
    new Request("https://schedule.bythereeses.com/book/wedding-photography-discovery-call"),
    { ORIGIN_PROXY_SECRET: "origin-secret" },
  );
  assert.match(bookFrameRes.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, "non-lead path keeps frame-ancestors 'none'");
  assert.equal(bookFrameRes.headers.get("x-frame-options"), "DENY", "non-lead path keeps x-frame-options DENY");

  console.log("pages proxy security tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
