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

console.log("origin guard tests passed");
