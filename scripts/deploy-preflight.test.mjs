import assert from "node:assert/strict";
import { evaluateDeployPreflight } from "./deploy-preflight.mjs";

const clean = evaluateDeployPreflight({
  env: { CLOUDFLARE_API_TOKEN: "token" },
  files: new Set(["src/proxy.ts", "wrangler.jsonc", "pages-proxy/_worker.js"]),
  productionSignals: {
    studioLoginHtml: "<title>The Reeses Studio</title><div>The Reeses Studio</div>",
    scheduleHtml: "<title>Wedding Photography Discovery Call</title><div>The Reeses Studio</div>",
  },
});

assert.deepEqual(clean.errors, []);
assert.deepEqual(clean.warnings, []);

const blocked = evaluateDeployPreflight({
  env: {},
  files: new Set(["src/middleware.ts", "wrangler.jsonc", "pages-proxy/_worker.js"]),
  productionSignals: {
    studioLoginHtml: "<img alt=\"Alex & Tyler\"><title>The Reeses Studio</title>",
    scheduleHtml: "<div>Alex</div><div>Tyler</div>",
  },
});

assert.deepEqual(blocked.errors, [
  "CLOUDFLARE_API_TOKEN is required for non-interactive Wrangler deploys.",
  "src/proxy.ts is required so the origin guard deploys as Next.js Edge proxy.",
  "src/middleware.ts is present; Next.js 16 rejects having both middleware and proxy files.",
]);
assert.deepEqual(blocked.warnings, [
  "studio.bythereeses.com still appears to contain stale Alex/Tyler branding.",
  "schedule.bythereeses.com still appears to contain stale Alex/Tyler branding.",
]);

console.log("deploy preflight tests passed");
