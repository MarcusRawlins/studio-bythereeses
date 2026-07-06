import assert from "node:assert/strict";

import { adminProofRequired } from "./admin-proxy-auth";
// Import the REAL proxy public-path predicates so this test fails the moment the
// app classifier and the proxy drift apart (Fable-fix, required drift test).
import {
  isPortalPublicPath,
  isSchedulePublicPath,
  isStudioPublicPath,
} from "../../pages-proxy/_worker.js";
// Origin-guard bypass predicates — pinned NEGATIVE so the Phase 15 allowlist
// additions provably do NOT widen the sensitive direct-origin bypass surface.
import {
  isPublicOriginBypassApiPath,
  isPublicOriginBypassPath,
} from "./origin-guard";

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
  "/api/inbound/project-email", // Phase 14 inbound project-email (self-authed by INBOUND_PROJECT_EMAIL_SECRET bearer)
  "/api/twilio/inbound", // Phase 8b Twilio inbound webhook (self-authed by X-Twilio-Signature)
  "/api/twilio/status", // Phase 8b Twilio status callback (self-authed by X-Twilio-Signature)
  "/api/email/unsubscribe", // Phase 8c one-click email unsubscribe (self-authed by signed token in URL)
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
  "/manifest.webmanifest", // Phase 15: PWA manifest (static, non-sensitive)
  "/sw.js", // Phase 15: service worker path (static; 404s until the deferred SW ships)
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

// Phase 8b: pin both Twilio webhook paths — admin-proof-exempt AND proxy-public —
// so a future edit that drops either classification (silently losing every STOP/
// status callback) fails loudly.
assert.equal(adminProofRequired("/api/twilio/inbound"), false, "/api/twilio/inbound must be admin-proof-exempt");
assert.equal(adminProofRequired("/api/twilio/status"), false, "/api/twilio/status must be admin-proof-exempt");
assert.equal(isStudioPublicPath("/api/twilio/inbound"), true, "/api/twilio/inbound must be proxy-public");
assert.equal(isStudioPublicPath("/api/twilio/status"), true, "/api/twilio/status must be proxy-public");

// Phase 8c: pin the one-click unsubscribe — admin-proof-exempt AND proxy-public —
// so a future edit that drops either (silently login-walling a client's
// unsubscribe, a compliance failure) fails loudly.
assert.equal(adminProofRequired("/api/email/unsubscribe"), false, "/api/email/unsubscribe must be admin-proof-exempt");
assert.equal(isStudioPublicPath("/api/email/unsubscribe"), true, "/api/email/unsubscribe must be proxy-public");

// Phase 14: pin the inbound project-email endpoint — admin-proof-exempt AND
// proxy-public AND NOT origin-bypassed — so a future edit that drops the first
// two (silently login-walling the inbound Worker → losing every client reply to
// the fallback) or widens the third (a direct-*.workers.dev bypass) fails loudly.
assert.equal(adminProofRequired("/api/inbound/project-email"), false, "/api/inbound/project-email must be admin-proof-exempt");
assert.equal(isStudioPublicPath("/api/inbound/project-email"), true, "/api/inbound/project-email must be proxy-public");
assert.equal(isPublicOriginBypassApiPath("/api/inbound/project-email"), false, "/api/inbound/project-email must NOT be origin-bypassed");
// Phase 14: the outbound admin send-email route is a GENUINE admin surface — NOT
// public, NOT origin-bypassed, admin-proof required (identical trust model to
// send-sms). Pin it so it can never drift into an agent/machine-reachable path.
assert.equal(adminProofRequired("/api/projects/project-1/communications/send-email"), true, "send-email must require an admin proof");
assert.equal(isStudioPublicPath("/api/projects/project-1/communications/send-email"), false, "send-email must NOT be proxy-public");
assert.equal(isPublicOriginBypassApiPath("/api/projects/project-1/communications/send-email"), false, "send-email must NOT be origin-bypassed");

// Phase 15 (PWA): the manifest + sw path are static, non-sensitive assets that
// must load UNAUTHENTICATED (a login-walled manifest = broken install), added in
// lockstep to the proxy `isPublicAssetPath` and the app `isStaticAssetPath`.
// `isPublicAssetPath` is not exported from the proxy, so pin via the exported
// composite `isStudioPublicPath` (which folds it in) instead.
for (const path of ["/manifest.webmanifest", "/sw.js"]) {
  assert.equal(adminProofRequired(path), false, `${path} must be admin-proof-exempt (static asset)`);
  assert.equal(isStudioPublicPath(path), true, `${path} must be proxy-public on the studio host`);
}
// CRITICAL non-widening: the Phase 15 additions must NOT touch origin-guard.
// The direct-*.workers.dev bypass lists stay unchanged, so both new paths are
// NOT bypass-exempt (they are middleware-excluded static assets served by ASSETS,
// they need no origin bypass, and adding one would widen the sensitive surface).
for (const path of ["/manifest.webmanifest", "/sw.js"]) {
  assert.equal(
    isPublicOriginBypassPath(path),
    false,
    `${path} must NOT be an origin-guard page bypass (no direct-origin widening)`,
  );
  assert.equal(
    isPublicOriginBypassApiPath(path),
    false,
    `${path} must NOT be an origin-guard api bypass (no direct-origin widening)`,
  );
}

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
  "/api/cron/sequences",
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
