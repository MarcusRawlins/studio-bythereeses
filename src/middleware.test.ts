import assert from "node:assert/strict";
import { ORIGIN_SECRET_HEADER } from "@/lib/origin-guard";
import { config, middleware } from "./middleware";

process.env.ORIGIN_PROXY_SECRET = "origin-secret";

const blocked = middleware(
  new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/projects/project-123") as never,
);
assert.equal(blocked.status, 404);

const blockedPrivateApi = middleware(
  new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/projects", {
    method: "POST",
  }) as never,
);
assert.equal(blockedPrivateApi.status, 404);

const blockedPrivateDottedApi = middleware(
  new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/finance/ar-aging.csv") as never,
);
assert.equal(blockedPrivateDottedApi.status, 404);

const allowed = middleware(
  new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/projects/project-123", {
    headers: { [ORIGIN_SECRET_HEADER]: "origin-secret" },
  }) as never,
);
assert.equal(allowed.status, 200);

const allowedPublicApi = middleware(
  new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/proposal/token-123/accept", {
    method: "POST",
  }) as never,
);
assert.equal(allowedPublicApi.status, 200);

assert.deepEqual(config.matcher, [
  "/api/:path*",
  "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|.*\\..*).*)",
]);

console.log("middleware origin guard tests passed");
