import { NextResponse } from "next/server";

export const ORIGIN_SECRET_HEADER = "x-reese-origin-secret";

const PUBLIC_PAGE_PREFIXES = [
  "/book/",
  "/p/",
  "/proposal/",
] as const;

const PUBLIC_API_PREFIXES = [
  "/api/google/auth",
  "/api/google/callback",
  "/api/cron/scheduler-reminders",
  // Phase 8c: the sequence-runner cron reaches the app Worker origin DIRECTLY
  // over *.workers.dev, bearer-authed (fail-closed 503 unset / 401 wrong,
  // constant-time), so the Pages proxy's /api/cron/* login-wall (303 ->
  // /admin/login 200) can't silently drop it. NOT an unauthenticated mutation
  // endpoint — the bearer secret at the origin is the trust boundary (identical
  // shape to /api/cron/scheduler-reminders).
  "/api/cron/sequences",
  // Phase 21: the systems-monitor cron (and the optional out-of-Worker heartbeat endpoint)
  // reach the app Worker origin DIRECTLY over *.workers.dev, bearer-authed on CRON_SECRET
  // (fail-closed 503 unset / 401 wrong, constant-time), so the Pages proxy's /api/cron/*
  // login-wall (303 -> /admin/login 200) can't silently drop them. NOT unauthenticated
  // mutation endpoints — the bearer secret at the origin is the trust boundary, and both are
  // read-only + NON-CANONICAL heartbeat writes only (job_runs / health_alerts), never a
  // canonical mutation (identical trust shape to /api/cron/sequences).
  "/api/cron/systems-monitor",
  "/api/cron/heartbeat",
  // Phase 13: the autopay-charge cron (§5.2) reaches the app Worker origin DIRECTLY over
  // *.workers.dev, bearer-authed on CRON_SECRET (fallback SCHEDULER_LINK_SECRET) — fail-closed
  // 503 unset / timing-safe 401 wrong — so the Pages proxy's /api/cron/* login-wall (303 ->
  // /admin/login 200) can't silently drop every run. NOT an unauthenticated mutation endpoint:
  // the bearer secret at the origin is the trust boundary, and the engine no-ops entirely while
  // AUTOPAY_ENABLED is dark (identical trust shape to /api/cron/sequences).
  "/api/cron/autopay-charge",
  "/api/proposal/",
  "/api/scheduler/bookings",
  "/api/stripe/webhook",
  // Private R2 asset serving (Phase 6 §1b): the signed-URL signature or a
  // portal/proposal token is the credential, not the origin secret. The GET
  // route itself rejects any unsigned/unauthenticated request with a 404.
  "/api/assets/",
] as const;

function isWorkersDevHost(hostname: string) {
  return hostname === "workers.dev" || hostname.endsWith(".workers.dev");
}

export function isPublicOriginBypassPath(pathname: string) {
  if (PUBLIC_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return true;
  }

  return /^\/questionnaires\/[^/]+\/(preview|confirmed)$/.test(pathname);
}

export function isPublicOriginBypassApiPath(pathname: string) {
  if (PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return true;
  }

  return /^\/api\/questionnaires\/[^/]+\/responses$/.test(pathname);
}

export function shouldBlockDirectWorkerOrigin({
  hostname,
  headers,
  secret,
}: {
  hostname: string;
  headers: Headers;
  secret?: string | null;
}) {
  const configuredSecret = secret?.trim();
  if (!configuredSecret) return false;
  if (!isWorkersDevHost(hostname)) return false;

  return headers.get(ORIGIN_SECRET_HEADER) !== configuredSecret;
}

export function guardDirectWorkerPageRequest(request: Request) {
  const url = new URL(request.url);
  if (isPublicOriginBypassPath(url.pathname) || isPublicOriginBypassApiPath(url.pathname)) {
    return null;
  }

  if (!shouldBlockDirectWorkerOrigin({
    hostname: url.hostname,
    headers: request.headers,
    secret: process.env.ORIGIN_PROXY_SECRET,
  })) {
    return null;
  }

  return new NextResponse("Not Found", { status: 404 });
}

export function guardDirectWorkerApiRequest(request: Request) {
  const url = new URL(request.url);
  if (!shouldBlockDirectWorkerOrigin({
    hostname: url.hostname,
    headers: request.headers,
    secret: process.env.ORIGIN_PROXY_SECRET,
  })) {
    return null;
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
