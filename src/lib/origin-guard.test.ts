import assert from "node:assert/strict";
import {
  guardDirectWorkerApiRequest,
  guardDirectWorkerPageRequest,
  isPublicOriginBypassApiPath,
  isPublicOriginBypassPath,
  shouldBlockDirectWorkerOrigin,
} from "./origin-guard";

function headers(values: Record<string, string>) {
  return new Headers(values);
}

const secret = "test-secret";

assert.equal(
  shouldBlockDirectWorkerOrigin({
    hostname: "reese-photography-crm.solitary-flower-c3ab.workers.dev",
    headers: headers({}),
    secret,
  }),
  true,
  "direct workers.dev requests without the proxy secret should be blocked",
);

assert.equal(
  shouldBlockDirectWorkerOrigin({
    hostname: "reese-photography-crm.solitary-flower-c3ab.workers.dev",
    headers: headers({ "x-reese-origin-secret": secret }),
    secret,
  }),
  false,
  "direct workers.dev requests with the proxy secret should be allowed",
);

assert.equal(
  shouldBlockDirectWorkerOrigin({
    hostname: "schedule.bythereeses.com",
    headers: headers({}),
    secret,
  }),
  false,
  "custom public domains should not be blocked by the origin guard",
);

assert.equal(
  shouldBlockDirectWorkerOrigin({
    hostname: "reese-photography-crm.solitary-flower-c3ab.workers.dev",
    headers: headers({}),
    secret: "",
  }),
  false,
  "the guard should be inactive until ORIGIN_PROXY_SECRET is configured",
);

process.env.ORIGIN_PROXY_SECRET = secret;

assert.equal(
  isPublicOriginBypassPath("/book/wedding-photography-discovery-call"),
  true,
  "public scheduler pages should bypass the page origin guard",
);

assert.equal(
  isPublicOriginBypassPath("/proposal/token-123"),
  true,
  "public proposal pages should bypass the page origin guard",
);

assert.equal(
  isPublicOriginBypassPath("/questionnaires/questionnaire-123/preview"),
  true,
  "public questionnaire preview pages should bypass the page origin guard",
);

assert.equal(
  isPublicOriginBypassPath("/projects/project-123"),
  false,
  "admin project pages should not bypass the page origin guard",
);

assert.equal(
  isPublicOriginBypassApiPath("/api/proposal/token-123/accept"),
  true,
  "public proposal acceptance API should bypass the proxy-level origin guard",
);

assert.equal(
  isPublicOriginBypassApiPath("/api/questionnaires/questionnaire-123/responses"),
  true,
  "public questionnaire response API should bypass the proxy-level origin guard",
);

assert.equal(
  isPublicOriginBypassApiPath("/api/scheduler/bookings"),
  true,
  "public scheduler booking API should bypass the proxy-level origin guard",
);

assert.equal(
  isPublicOriginBypassApiPath("/api/stripe/webhook"),
  true,
  "Stripe webhook API should bypass the proxy-level origin guard and rely on Stripe signatures",
);

// Phase 8c: the sequence-runner cron reaches the origin directly, bearer-authed
// (identical trust shape to /api/cron/scheduler-reminders). Pin the bypass so a
// future edit that drops it (silently login-walling every run) fails loudly. The
// unsubscribe endpoint is DELIBERATELY not here (it belongs on the proxy path).
assert.equal(
  isPublicOriginBypassApiPath("/api/cron/sequences"),
  true,
  "the sequence-runner cron endpoint must bypass the origin guard (bearer secret is the trust boundary)",
);
assert.equal(
  isPublicOriginBypassApiPath("/api/email/unsubscribe"),
  false,
  "the client-facing unsubscribe endpoint must NOT bypass the origin guard (it belongs on the proxy path)",
);

// Phase 21: the systems-monitor cron + optional out-of-Worker heartbeat reach the origin
// directly, bearer-authed on CRON_SECRET (read-only + non-canonical heartbeat writes only).
// Pin the bypass so a future edit that drops it (silently login-walling every run) fails loudly.
assert.equal(
  isPublicOriginBypassApiPath("/api/cron/systems-monitor"),
  true,
  "the systems-monitor cron endpoint must bypass the origin guard (bearer secret is the trust boundary)",
);
assert.equal(
  isPublicOriginBypassApiPath("/api/cron/heartbeat"),
  true,
  "the out-of-Worker heartbeat endpoint must bypass the origin guard (bearer secret is the trust boundary)",
);

assert.equal(
  isPublicOriginBypassApiPath("/api/scheduler/meeting-types"),
  false,
  "private scheduler admin API should not bypass the proxy-level origin guard",
);

assert.equal(
  guardDirectWorkerPageRequest(
    new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/projects/project-123"),
  )?.status,
  404,
  "direct workers.dev admin page requests should be blocked when the secret is configured",
);

assert.equal(
  guardDirectWorkerPageRequest(
    new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/book/wedding-photography-discovery-call"),
  ),
  null,
  "public scheduler pages should remain reachable on the direct worker origin",
);

assert.equal(
  guardDirectWorkerApiRequest(
    new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/projects", {
      method: "POST",
    }),
  )?.status,
  404,
  "private API mutations should be blocked on direct workers.dev without the shared secret",
);

assert.equal(
  guardDirectWorkerApiRequest(
    new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/projects", {
      method: "POST",
      headers: {
        "x-reese-origin-secret": secret,
      },
    }),
  ),
  null,
  "private API mutations with the shared secret should be allowed",
);

// --------------------------------------------------------------------------
// Phase 6.5 [B2] rate-limit-bypass negative test. The self-service request
// endpoint and the verify page are DELIBERATELY NOT in the origin bypass lists:
// a direct *.workers.dev request (skipping the proxy, and therefore skipping the
// only per-IP `requestLink` limiter) must 404, forcing all real traffic through
// the proxy. Adding them to the bypass lists would enable email-bombing.
// --------------------------------------------------------------------------
assert.equal(
  isPublicOriginBypassApiPath("/api/portal/request-link"),
  false,
  "the magic-link request endpoint must NOT bypass the origin guard (per-IP limiter lives at the proxy)",
);
assert.equal(
  isPublicOriginBypassPath("/portal/login/verify/tok"),
  false,
  "the magic-link verify page must NOT bypass the origin guard",
);
assert.equal(
  isPublicOriginBypassPath("/portal/login"),
  false,
  "the magic-link request page must NOT bypass the origin guard",
);
assert.equal(
  guardDirectWorkerApiRequest(
    new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/portal/request-link", {
      method: "POST",
    }),
  )?.status,
  404,
  "direct workers.dev POST to the request endpoint (no origin secret) must be 404'd",
);
assert.equal(
  guardDirectWorkerPageRequest(
    new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/portal/login/verify/tok"),
  )?.status,
  404,
  "direct workers.dev GET to the verify page (no origin secret) must be 404'd",
);
// /p/ stays origin-bypass-public (a browser can legitimately hit the worker
// origin directly for those) — the asymmetry with the request endpoint is
// intentional.
assert.equal(
  isPublicOriginBypassPath("/p/some-token"),
  true,
  "direct /p/ token links stay origin-bypass-public (unchanged)",
);

// --------------------------------------------------------------------------
// Phase 9b — the admin refund-INITIATION routes (the only code that can call Stripe's
// mutating refund endpoint) must NEVER be origin-bypass-public: they are first-class admin
// mutations behind the Pages-proxy admin wall + origin secret. A direct *.workers.dev POST
// (no origin secret) must 404. Adding these to a bypass list would let an unauthenticated
// caller drain money up to the service ceiling — pin the classifier + the guard.
// --------------------------------------------------------------------------
assert.equal(
  isPublicOriginBypassApiPath("/api/invoices/inv-1/payments/pay-1/refund/execute"),
  false,
  "the refund EXECUTE route must NOT bypass the origin guard (money-movement is admin-only)",
);
assert.equal(
  isPublicOriginBypassApiPath("/api/invoices/inv-1/payments/pay-1/refund/prepare"),
  false,
  "the refund PREPARE route must NOT bypass the origin guard",
);
assert.equal(
  guardDirectWorkerApiRequest(
    new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/invoices/inv-1/payments/pay-1/refund/execute", {
      method: "POST",
    }),
  )?.status,
  404,
  "direct workers.dev POST to refund/execute (no origin secret) must be 404'd",
);
assert.equal(
  guardDirectWorkerApiRequest(
    new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/invoices/inv-1/payments/pay-1/refund/prepare", {
      method: "POST",
    }),
  )?.status,
  404,
  "direct workers.dev POST to refund/prepare (no origin secret) must be 404'd",
);

// --------------------------------------------------------------------------
// Phase 24 (CR-6, rev 2 MAJOR 1) — the Resend bounce/complaint webhook is PROXY-ONLY, the exact
// Twilio posture: it calls guardDirectWorkerApiRequest itself (in-route), and is deliberately NOT
// added to the origin-guard bypass list (that would be dead code — guardDirectWorkerApiRequest
// never consults PUBLIC_API_PREFIXES at all). Pin both halves so a future edit can't silently
// re-add the dead bypass entry, or drop the in-route guard call.
// --------------------------------------------------------------------------
assert.equal(
  isPublicOriginBypassApiPath("/api/resend/webhook"),
  false,
  "the Resend bounce/complaint webhook must NOT bypass the origin guard (PROXY-ONLY, SVIX signature is the trust boundary)",
);
assert.equal(
  guardDirectWorkerApiRequest(
    new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/resend/webhook", {
      method: "POST",
    }),
  )?.status,
  404,
  "direct workers.dev POST to the Resend webhook (no origin secret) must be 404'd",
);

console.log("origin guard tests passed");
