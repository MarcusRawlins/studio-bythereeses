import assert from "node:assert/strict";

import { adminProofRequired } from "./admin-proxy-auth";
// Import the REAL proxy public-path predicates so this test fails the moment the
// app classifier and the proxy drift apart (Fable-fix, required drift test).
import {
  isPortalPublicPath,
  isSchedulePublicPath,
  isStudioPublicPath,
} from "../../pages-proxy/_worker.js";

// --------------------------------------------------------------------------
// Studio-host public surfaces: the classifier must NOT require an admin proof,
// and the proxy's own isStudioPublicPath must agree they are public.
// --------------------------------------------------------------------------
const studioPublic = [
  "/portal", // BLOCKING: the client portal must never be 404'd under enforcement
  "/portal/login", // Phase 6.5 self-service request page
  "/portal/login/verify/some-token", // Phase 6.5 magic-link verify (render + consume)
  "/portal/proposals/abc", // Phase-6 fix (a): the whole /portal subtree is public
  "/api/portal/request-link", // Phase 6.5 self-service request endpoint (POST)
  "/api/inbound/inquiry-email", // Phase 8a inbound intake (self-authed by INBOUND_INTAKE_SECRET bearer)
  "/p/some-token",
  "/proposal/some-token",
  "/api/proposal/some-token/accept",
  "/api/agent/projects",
  "/api/mcp",
  "/api/assets/contracts/project-1/proposal-1/asset.pdf",
  "/admin/login",
  "/api/google/callback",
  "/favicon.ico",
  "/_next/static/chunk.js",
  "/brand/logo.svg",
];
for (const path of studioPublic) {
  assert.equal(adminProofRequired(path), false, `${path} must be public (no admin proof)`);
  assert.equal(isStudioPublicPath(path), true, `${path} must be proxy-public on the studio host`);
}
// The proxy's portal predicate now covers the whole /portal subtree (Phase-6 fix
// (a) + Phase 6.5). Pin it so it stays in lockstep with adminProofRequired.
assert.equal(isPortalPublicPath("/portal"), true, "/portal is a proxy portal-public path");
assert.equal(isPortalPublicPath("/portal/login"), true, "/portal/login is a proxy portal-public path");
assert.equal(isPortalPublicPath("/portal/login/verify/tok"), true, "the verify route is proxy portal-public");
assert.equal(isPortalPublicPath("/portal/proposals/abc"), true, "/portal/proposals/* is proxy portal-public");

// The client portal proposal detail and the magic-link surfaces are kept public
// by the classifier (client-reachable) — assert the classifier decisions
// directly so the /portal subtree is never proof-gated.
assert.equal(adminProofRequired("/portal/proposals/abc"), false, "/portal/proposals/* must stay public");
assert.equal(adminProofRequired("/portal/login/verify/tok"), false, "/portal/login/verify/* must stay public");

// --------------------------------------------------------------------------
// Schedule-host public surfaces: classifier public, proxy isSchedulePublicPath agrees.
// --------------------------------------------------------------------------
const schedulePublic = [
  "/book/wedding-photography-discovery-call",
  "/api/scheduler/bookings",
  "/questionnaires/q-1/preview",
  "/questionnaires/q-1/confirmed",
  "/api/questionnaires/q-1/responses",
];
for (const path of schedulePublic) {
  assert.equal(adminProofRequired(path), false, `${path} must be public (no admin proof)`);
  assert.equal(isSchedulePublicPath(path), true, `${path} must be proxy-public on the schedule host`);
}

// --------------------------------------------------------------------------
// Other credential-bearing / webhook surfaces the classifier keeps public.
// --------------------------------------------------------------------------
for (const path of [
  "/api/stripe/webhook",
  "/api/google/auth",
  "/api/cron/scheduler-reminders",
]) {
  assert.equal(adminProofRequired(path), false, `${path} must be public (no admin proof)`);
}

// --------------------------------------------------------------------------
// Genuine admin surfaces: classifier requires a proof, proxy is NOT public.
// --------------------------------------------------------------------------
const adminSurfaces = [
  "/",
  "/finance",
  "/projects",
  "/projects/project-123",
  "/clients",
  "/api/settings",
  "/api/clients/client-1",
  "/api/finance/ar-aging.csv",
];
for (const path of adminSurfaces) {
  assert.equal(adminProofRequired(path), true, `${path} must require an admin proof`);
  assert.equal(isStudioPublicPath(path), false, `${path} must NOT be proxy-public on the studio host`);
}

// --------------------------------------------------------------------------
// DELIBERATE side effect: the admin-only scheduler forms are proxy-public on the
// SCHEDULE host (/api/scheduler/*) yet MUST be admin-proof-required at the
// origin. This intentional divergence is a hardening win — pin it so a future
// edit that relaxes it fails loudly.
// --------------------------------------------------------------------------
for (const path of ["/api/scheduler/meeting-types", "/api/scheduler/settings"]) {
  assert.equal(adminProofRequired(path), true, `${path} is admin-only -> proof required (deliberate)`);
  assert.equal(
    isSchedulePublicPath(path),
    true,
    `${path} is proxy-public on the schedule host (deliberate, asserted divergence)`,
  );
}

// --------------------------------------------------------------------------
// Trailing-slash normalization: the classifier decision must be identical with
// or without a trailing slash (reconciles the proxy's `/?`-tolerant regexes).
// --------------------------------------------------------------------------
assert.equal(adminProofRequired("/portal/"), false, "/portal/ normalizes to public");
assert.equal(adminProofRequired("/finance/"), true, "/finance/ normalizes to admin");
assert.equal(
  adminProofRequired("/questionnaires/q-1/preview/"),
  false,
  "trailing-slash questionnaire preview stays public after normalization",
);
assert.equal(
  adminProofRequired("/api/questionnaires/q-1/responses/"),
  false,
  "trailing-slash questionnaire responses stays public after normalization",
);

console.log("admin surface classification drift tests passed");
