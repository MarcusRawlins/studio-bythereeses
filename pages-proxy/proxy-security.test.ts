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

  console.log("pages proxy security tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
