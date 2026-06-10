import assert from "node:assert/strict";
import { ORIGIN_SECRET_HEADER } from "@/lib/origin-guard";
import { config, proxy } from "./proxy";

process.env.ORIGIN_PROXY_SECRET = "origin-secret";

const blocked = proxy(
  new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/projects/project-123") as never,
);
assert.equal(blocked.status, 404);

const blockedPrivateApi = proxy(
  new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/projects", {
    method: "POST",
  }) as never,
);
assert.equal(blockedPrivateApi.status, 404);

const blockedPrivateDottedApi = proxy(
  new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/finance/ar-aging.csv") as never,
);
assert.equal(blockedPrivateDottedApi.status, 404);

const allowed = proxy(
  new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/projects/project-123", {
    headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" },
  }) as never,
);
assert.equal(allowed.status, 200);

const allowedPublicApi = proxy(
  new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/proposal/token-123/accept", {
    method: "POST",
  }) as never,
);
assert.equal(allowedPublicApi.status, 200);

assert.deepEqual(config.matcher, [
  "/api/:path*",
  "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|.*\\..*).*)",
]);

console.log("proxy origin guard tests passed");
