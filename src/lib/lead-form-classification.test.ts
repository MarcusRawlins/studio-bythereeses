// Phase 19 — §9 test 10: proxy + middleware classification drift pins (I4/I7/BLOCKER-1).
import assert from "node:assert/strict";

import {
  isSchedulePublicPath,
  isStudioPublicPath,
  rateLimitKind,
} from "../../pages-proxy/_worker.js";
import { adminProofRequired } from "./admin-proxy-auth";
import {
  guardDirectWorkerPageRequest,
  isPublicOriginBypassApiPath,
  isPublicOriginBypassPath,
} from "./origin-guard";
import { config as middlewareConfig } from "../middleware";

const LEAD_PAGES = ["/embed/lead", "/embed/lead/thanks"];
const SUBMIT = "/api/lead-form/submit";

// ---- schedule-host gate: ADD all three (else the gate 303s them to the discovery-call page) ----
for (const p of [...LEAD_PAGES, SUBMIT]) {
  assert.equal(isSchedulePublicPath(p), true, `${p} must be schedule-public`);
  // Wrong host: NOT added to the admin studio-host gate.
  assert.equal(isStudioPublicPath(p), false, `${p} must NOT be studio-public (wrong host)`);
  // admin-proof exemptions (else the tail return-true would 404 all three under enforcement).
  assert.equal(adminProofRequired(p), false, `${p} must be admin-proof-exempt`);
  // Origin-guard bypass lists DELIBERATELY untouched (proxy-only; Phase 24 dead-code trap).
  assert.equal(isPublicOriginBypassPath(p), false, `${p} must NOT be an origin page bypass`);
  assert.equal(isPublicOriginBypassApiPath(p), false, `${p} must NOT be an origin api bypass`);
}

// The admin config editor is a GENUINE admin surface — NOT public, admin-proof required.
assert.equal(isSchedulePublicPath("/api/lead-form/settings"), false, "the config editor is NOT schedule-public");
assert.equal(isStudioPublicPath("/api/lead-form/settings"), false, "the config editor is NOT studio-public");
assert.equal(adminProofRequired("/api/lead-form/settings"), true, "the config editor requires an admin proof");

// ---- rate-limit kinds ----
assert.equal(rateLimitKind(new URL("https://schedule.bythereeses.com" + SUBMIT), { method: "POST" }), "leadForm", "submit POST → leadForm");
assert.equal(rateLimitKind(new URL("https://schedule.bythereeses.com/embed/lead"), { method: "GET" }), "leadFormPage", "embed GET → leadFormPage");
assert.equal(rateLimitKind(new URL("https://schedule.bythereeses.com/embed/lead/thanks"), { method: "GET" }), "leadFormPage", "thanks GET → leadFormPage");

// ---- BLOCKER-1: REQUEST-LEVEL middleware-matcher test (the predicate pins above are false coverage
// without this). The page matcher EXCLUDES any path containing a dot (`.*\..*`); the DOT-FREE embed
// paths must be MATCHED, and a dotted token-in-path must be EXCLUDED (documents why the token is a
// query param, not a path segment). ----
const pagePattern = middlewareConfig.matcher.find((m: string) => m.includes("_next/static"));
assert.ok(pagePattern, "middleware has the page matcher");
const matcherRe = new RegExp("^" + pagePattern + "$");
assert.ok(matcherRe.test("/embed/lead"), "/embed/lead IS matched by the middleware page matcher (dot-free)");
assert.ok(matcherRe.test("/embed/lead/thanks"), "/embed/lead/thanks IS matched (dot-free)");
assert.equal(
  matcherRe.test("/embed/lead/abc123.sig456.payload"),
  false,
  "a dotted token-in-path would be EXCLUDED from the matcher (why the token must be ?t=)",
);

// A direct-origin request to /embed/lead lacking x-reese-origin-secret is 404'd by
// guardDirectWorkerPageRequest — /embed/lead is deliberately NOT in the origin bypass, so the
// proxy-only per-IP rate limit + honeypot/timing gates cannot be bypassed via *.workers.dev (I7).
process.env.ORIGIN_PROXY_SECRET = "origin-secret";
assert.equal(
  guardDirectWorkerPageRequest(
    new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/embed/lead"),
  )?.status,
  404,
  "direct *.workers.dev GET to /embed/lead (no origin secret) is 404'd by the page guard",
);

console.log("lead-form classification drift pins passed");
