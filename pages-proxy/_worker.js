const WORKER_ORIGIN = "https://reese-photography-crm.solitary-flower-c3ab.workers.dev";
const GOOGLE_CLIENT_ID = "885050393633-f95p2g03pervoqbcqd5b5dnhstr9ni71.apps.googleusercontent.com";
const PUBLIC_BOOKING_CACHE_SECONDS = 60;
const ADMIN_EMAIL = "hello@bythereeses.com";
const ADMIN_SESSION_COOKIE = "reese_studio_session";
const ADMIN_STATE_COOKIE = "reese_studio_oauth_state";
const ADMIN_SESSION_DAYS = 30;

const textEncoder = new TextEncoder();
const rateLimitBuckets = new Map();

const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "content-security-policy": "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
};

const RATE_LIMITS = {
  adminAuth: { max: 20, windowSeconds: 300 },
  tokenAccess: { max: 60, windowSeconds: 60 },
  // Private R2 asset serving (Phase 6 §1b). A single portal page can embed many
  // signed/token asset URLs (PDFs + gallery images), so allow more headroom than
  // tokenAccess while still bounding abuse of the public serving path.
  assetAccess: { max: 120, windowSeconds: 60 },
  publicMutation: { max: 20, windowSeconds: 300 },
  agentApi: { max: 120, windowSeconds: 60 },
  // Phase 6.5: per-IP cap on the self-service magic-link request endpoint. This
  // is the ONLY per-IP limiter for that endpoint (the endpoint is deliberately
  // NOT origin-bypass-public), so keeping every request behind the proxy is what
  // prevents email-bombing.
  requestLink: { max: 5, windowSeconds: 900 },
  // Phase 8b: a DEDICATED, GENEROUS ceiling for the Twilio webhooks — NOT
  // publicMutation. The proxy limiter runs BEFORE signature verification, and all
  // Twilio traffic arrives from a small set of egress IPs (concentrating on one
  // bucket key), so the tight publicMutation cap (20/300s) would 429 a genuine
  // STOP or drop a status-callback fan-out — a dropped STOP is a COMPLIANCE loss.
  // The real trust boundary is the X-Twilio-Signature at the origin; this cap is
  // only an abuse ceiling, so err generous.
  twilioWebhook: { max: 600, windowSeconds: 60 },
};

function base64UrlEncode(input) {
  const bytes = input instanceof Uint8Array ? input : textEncoder.encode(String(input));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// Constant-time comparison of two equal-length base64url strings. The Worker
// runtime has no node:crypto.timingSafeEqual, so accumulate the XOR of every
// byte (mirrors admin-proxy-auth.ts constantTimeEqual / agent-api tokensMatch).
// Length is not secret (fixed-size SHA-256 HMAC), so an early length mismatch is
// fine.
function constantTimeEqual(a, b) {
  const ab = textEncoder.encode(a);
  const bb = textEncoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  return Object.fromEntries(header.split(";").map((cookie) => {
    const [name, ...rest] = cookie.trim().split("=");
    return [name, rest.join("=")];
  }).filter(([name]) => name));
}

async function createAdminSession(email, env) {
  const expiresAt = Date.now() + ADMIN_SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = base64UrlEncode(JSON.stringify({ email, expiresAt }));
  const signature = await hmac(env.ADMIN_SESSION_SECRET, payload);
  return `${payload}.${signature}`;
}

export async function verifyAdminSession(request, env) {
  if (!env.ADMIN_SESSION_SECRET) return false;
  const token = parseCookies(request)[ADMIN_SESSION_COOKIE];
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = await hmac(env.ADMIN_SESSION_SECRET, payload);
  if (!constantTimeEqual(signature, expected)) return false;

  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(payload));
    const session = JSON.parse(decoded);
    const allowedEmail = env.ADMIN_ALLOWED_EMAIL || ADMIN_EMAIL;
    return session.email === allowedEmail && Number(session.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

function clearCookie(name) {
  return cookie(name, "", { maxAge: 0 });
}

// L7: proposal surfaces carry a bearer token in the URL itself; force `no-referrer`
// there so the token can never leak via the Referer header on outbound navigations.
// Every other surface keeps the default strict-origin-when-cross-origin policy.
function referrerPolicyFor(pathname) {
  return pathname.startsWith("/proposal/")
    || pathname.startsWith("/api/proposal/")
    // Phase 6.5: the magic-link verify URL carries the single-use token in the
    // path, so force no-referrer here too (the origin route also sets it, but the
    // proxy re-derives referrer-policy on every response and would clobber it).
    || pathname.startsWith("/portal/login/verify/")
    ? "no-referrer"
    : SECURITY_HEADERS["referrer-policy"];
}

function redirectResponse(url, status = 303, pathname = url.pathname) {
  return new Response(null, {
    status,
    headers: {
      location: url.toString(),
      ...SECURITY_HEADERS,
      "referrer-policy": referrerPolicyFor(pathname),
    },
  });
}

function applySecurityHeaders(headers) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
}

// Phase 6 §4 (L8): preserve an app-provided CSP instead of unconditionally
// clobbering it. `applySecurityHeaders` always injects the STATIC baseline CSP
// (no `script-src`) as the fallback for non-HTML / error / cached responses that
// carry none. When the origin (Next middleware) emitted a per-request nonce'd
// policy, that header carries the nonce and MUST win:
//   - an enforced `content-security-policy` from the app REPLACES the baseline;
//   - a `content-security-policy-report-only` from the app is layered on top of
//     the still-enforced baseline (report mode = zero behavior change to the
//     page — the nonce'd policy only reports violations).
// `appCsp` / `appReportCsp` are read from the ORIGIN response BEFORE
// `applySecurityHeaders` runs. Booking pages never carry an app CSP (the
// middleware skips the nonce there), so cached HTML never freezes a nonce.
function applyAppCsp(headers, appCsp, appReportCsp) {
  if (appCsp) headers.set("content-security-policy", appCsp);
  if (appReportCsp) headers.set("content-security-policy-report-only", appReportCsp);
}

function isStudioHost(url) {
  return url.hostname !== "schedule.bythereeses.com";
}

function isPublicAssetPath(pathname) {
  return (
    pathname === "/favicon.ico" ||
    pathname === "/icon.png" ||
    pathname === "/apple-icon.png" ||
    pathname === "/manifest.webmanifest" || // Phase 15: PWA manifest (static, non-sensitive)
    pathname === "/sw.js" || // Phase 15: service worker (static; add now, file lands with the deferred SW drop)
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/brand/") ||
    pathname.startsWith("/fonts/")
  );
}

export function isPortalPublicPath(pathname) {
  // Phase 6.5 / Phase-6 fix (a): the ENTIRE /portal subtree is client-facing and
  // self-protected by the portal session cookie (or public by design), so it
  // must never be gated behind the admin Google session. This subsumes
  // /portal/login, /portal/login/verify/*, and fixes the pre-existing
  // /portal/proposals/:id login-wall bounce to /admin/login.
  return pathname === "/portal" || pathname.startsWith("/portal/") || pathname.startsWith("/p/");
}

export { constantTimeEqual };

function isStudioTrustedAgentApiPath(pathname) {
  return pathname === "/api/mcp" || pathname.startsWith("/api/agent/");
}

export function isStudioPublicPath(pathname) {
  return (
    pathname === "/admin/login" ||
    pathname === "/admin/logout" ||
    pathname === "/admin/auth/google" ||
    pathname === "/api/google/callback" ||
    isStudioTrustedAgentApiPath(pathname) ||
    isPortalPublicPath(pathname) ||
    // Phase 6.5: the self-service magic-link request endpoint (POST). Client-
    // reachable, so it must not be gated behind the admin Google session.
    pathname === "/api/portal/request-link" ||
    // Phase 8a: the inbound inquiry-email intake endpoint. Self-authenticated by
    // the dedicated INBOUND_INTAKE_SECRET bearer (same rationale as /api/mcp), so
    // it must NOT be gated behind the admin Google session — otherwise the intake
    // Worker's unauthenticated POST is 303'd to /admin/login (a 200 login PAGE),
    // the Worker mistakes that for success, and the lead is silently lost. It is
    // NOT in the origin-guard bypass; it is reachable only through the proxy,
    // which stamps the origin secret.
    pathname === "/api/inbound/inquiry-email" ||
    // Phase 8b: Twilio inbound-message + delivery-status webhooks. Self-
    // authenticated by the X-Twilio-Signature (HMAC-SHA1 over the configured
    // URL), so they must NOT be gated behind the admin Google session —
    // otherwise Twilio's unauthenticated-to-the-proxy POST is 303'd to
    // /admin/login (a 200 login PAGE), Twilio reads 2xx as success, and the
    // STOP/status is silently lost. Like 8a, NOT in the origin-guard bypass;
    // reachable only through the proxy (which stamps the origin secret).
    pathname === "/api/twilio/inbound" ||
    pathname === "/api/twilio/status" ||
    // Phase 8c: the client-facing one-click email unsubscribe (RFC 8058). Real
    // browsers/mail-scanners hit the public studio host, so it must NOT be gated
    // behind the admin Google session — otherwise the unsubscribe GET/POST is
    // 303'd to /admin/login and silently dropped (a compliance failure). The
    // token in the URL is the credential; the route verifies it constant-time.
    // NOT in the origin-guard bypass — it belongs on the proxy path (POST is a
    // public unauthenticated mutation → publicMutation rate-limit kind).
    pathname === "/api/email/unsubscribe" ||
    pathname.startsWith("/proposal/") ||
    pathname.startsWith("/api/proposal/") ||
    // Private R2 asset serving (Phase 6 §1b): signed-URL / portal / proposal
    // token is the credential; the origin route enforces it. Never gate this
    // behind the admin Google session.
    pathname.startsWith("/api/assets/") ||
    isPublicAssetPath(pathname)
  );
}

export function isSchedulePublicPath(pathname) {
  return (
    pathname.startsWith("/book/") ||
    pathname.startsWith("/api/scheduler/") ||
    /^\/questionnaires\/[^/]+\/preview\/?$/.test(pathname) ||
    /^\/questionnaires\/[^/]+\/confirmed\/?$/.test(pathname) ||
    /^\/api\/questionnaires\/[^/]+\/responses\/?$/.test(pathname) ||
    // Keep already-issued proposal links working, but never expose Studio admin routes on the public schedule host.
    pathname.startsWith("/proposal/") ||
    pathname.startsWith("/api/proposal/") ||
    isPublicAssetPath(pathname)
  );
}

function clientAddress(request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

export function rateLimitKind(url, request) {
  const pathname = url.pathname;
  if (pathname === "/admin/auth/google" || pathname === "/api/google/callback") return "adminAuth";
  if (pathname === "/api/mcp" || pathname.startsWith("/api/agent/")) return "agentApi";
  if (pathname.startsWith("/api/assets/")) return "assetAccess";
  // Phase 6.5: the magic-link request endpoint gets its own per-IP cap. Match it
  // (POST) BEFORE the generic /portal → tokenAccess branch below; the verify GET
  // route (/portal/login/verify/*) stays under tokenAccess (token consumption).
  if (request.method !== "GET" && pathname === "/api/portal/request-link") return "requestLink";
  // Phase 8b: Twilio webhooks get their own generous kind (NOT publicMutation) so
  // a burst of STOPs / status callbacks is never 429'd. Match BEFORE the
  // publicMutation branch below.
  if (
    request.method !== "GET" &&
    (pathname === "/api/twilio/inbound" || pathname === "/api/twilio/status")
  ) {
    return "twilioWebhook";
  }
  if (
    pathname.startsWith("/proposal/") ||
    pathname.startsWith("/p/") ||
    pathname === "/portal" ||
    pathname.startsWith("/portal/") ||
    pathname.startsWith("/api/proposal/")
  ) {
    return "tokenAccess";
  }
  if (
    request.method !== "GET" &&
    (
      pathname.startsWith("/api/scheduler/bookings") ||
      /^\/api\/questionnaires\/[^/]+\/responses\/?$/.test(pathname) ||
      // Phase 8a: the inbound intake endpoint is now proxy-reachable — give it a
      // per-IP cap. Belt-and-suspenders alongside the CRM-side rate/volume guard.
      pathname === "/api/inbound/inquiry-email" ||
      // Phase 8c: the one-click unsubscribe POST is a public unauthenticated
      // mutation. Low volume → the standard publicMutation bucket (unlike Twilio,
      // which needed a dedicated generous kind).
      pathname === "/api/email/unsubscribe"
    )
  ) {
    return "publicMutation";
  }
  return null;
}

function rateLimitResponse(request, url) {
  const kind = rateLimitKind(url, request);
  if (!kind) return null;

  const limit = RATE_LIMITS[kind];
  const now = Date.now();
  const windowMs = limit.windowSeconds * 1000;
  const key = `${kind}:${clientAddress(request)}`;
  const current = rateLimitBuckets.get(key);
  const bucket = current && current.resetAt > now
    ? current
    : { count: 0, resetAt: now + windowMs };

  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);

  if (bucket.count <= limit.max) return null;

  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return new Response("Too many requests.", {
    status: 429,
    headers: {
      "retry-after": String(retryAfter),
      "cache-control": "private, no-store",
      ...SECURITY_HEADERS,
    },
  });
}

function loginPage(nextPath = "/") {
  const safeNext = nextPath.startsWith("/") && !nextPath.startsWith("//") ? nextPath : "/";
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>The Reeses Studio</title>
  <style>
    @font-face { font-family: TimesNow; src: url('/fonts/times-now-light.woff') format('woff'); font-display: swap; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8f6f3; color: #222; font-family: Arial, sans-serif; }
    main { width: min(460px, calc(100vw - 40px)); border: 1px solid #d5d0c8; background: #fffdfa; padding: 36px; box-shadow: 0 8px 20px rgb(0 0 0 / 0.05); }
    .brand { font-family: TimesNow, Georgia, serif; text-transform: uppercase; letter-spacing: .18em; font-size: 15px; margin: 0 0 28px; }
    h1 { font-family: TimesNow, Georgia, serif; text-transform: uppercase; letter-spacing: .08em; font-size: 42px; font-weight: 300; line-height: .95; margin: 0 0 12px; }
    p { color: #6f665b; line-height: 1.6; margin: 0 0 24px; }
    a { display: inline-flex; justify-content: center; width: 100%; box-sizing: border-box; border: 1px solid #222; background: #222; color: #f8f6f3; text-decoration: none; padding: 13px 16px; font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  </style>
</head>
<body>
  <main>
    <div class="brand">The Reeses Studio</div>
    <h1>Studio</h1>
    <p>This private workspace is only for The Reeses. Sign in with hello@bythereeses.com to continue.</p>
    <a href="/admin/auth/google?next=${encodeURIComponent(safeNext)}">Sign in with Google</a>
  </main>
</body>
</html>`;
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      ...SECURITY_HEADERS,
    },
  });
}

async function adminGoogleAuth(request) {
  const incomingUrl = new URL(request.url);
  const nextPath = incomingUrl.searchParams.get("next") || "/";
  const nonce = crypto.randomUUID();
  const statePayload = base64UrlEncode(JSON.stringify({ kind: "admin", nonce, nextPath }));
  const state = `admin.${statePayload}`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", "https://studio.bythereeses.com/api/google/callback");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("scope", "openid https://www.googleapis.com/auth/userinfo.email");
  url.searchParams.set("state", state);

  const response = redirectResponse(url, 307);
  response.headers.append("set-cookie", cookie(ADMIN_STATE_COOKIE, nonce, { maxAge: 600 }));
  response.headers.set("cache-control", "private, no-store");
  return response;
}

async function adminGoogleCallback(request, env) {
  const incomingUrl = new URL(request.url);
  const state = incomingUrl.searchParams.get("state") || "";
  if (!state.startsWith("admin.")) return null;
  const code = incomingUrl.searchParams.get("code");
  if (!code || !env.GOOGLE_CLIENT_SECRET || !env.ADMIN_SESSION_SECRET) {
    return new Response("Studio authentication is not fully configured.", { status: 500 });
  }

  const cookies = parseCookies(request);
  let stateData;
  try {
    stateData = JSON.parse(new TextDecoder().decode(base64UrlDecode(state.replace(/^admin\./, ""))));
  } catch {
    return new Response("Invalid sign-in state.", { status: 400 });
  }
  if (!stateData.nonce || cookies[ADMIN_STATE_COOKIE] !== stateData.nonce) {
    return new Response("Expired sign-in state. Please try again.", { status: 400 });
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: "https://studio.bythereeses.com/api/google/callback",
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    return new Response("Google sign-in failed.", { status: 401 });
  }

  const tokens = await tokenResponse.json();
  if (!tokens.access_token) {
    return new Response("Google sign-in did not return identity.", { status: 401 });
  }
  const identityResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
    },
  });
  if (!identityResponse.ok) {
    return new Response("Google sign-in identity verification failed.", { status: 401 });
  }
  const identity = await identityResponse.json();
  const email = String(identity.email || "").toLowerCase();
  const allowedEmail = env.ADMIN_ALLOWED_EMAIL || ADMIN_EMAIL;
  if (email !== allowedEmail) {
    return new Response("This Google account is not allowed to access The Reeses Studio.", { status: 403 });
  }

  const nextPath = typeof stateData.nextPath === "string" && stateData.nextPath.startsWith("/") && !stateData.nextPath.startsWith("//")
    ? stateData.nextPath
    : "/";
  const response = redirectResponse(new URL(nextPath, incomingUrl.origin), 303);
  response.headers.append("set-cookie", await cookie(ADMIN_SESSION_COOKIE, await createAdminSession(email, env), { maxAge: ADMIN_SESSION_DAYS * 24 * 60 * 60 }));
  response.headers.append("set-cookie", clearCookie(ADMIN_STATE_COOKIE));
  response.headers.set("cache-control", "private, no-store");
  return response;
}

function canCachePublicBookingPage(request, url) {
  if (request.method !== "GET") return false;
  if (url.hostname !== "schedule.bythereeses.com") return false;
  if (!url.pathname.startsWith("/book/")) return false;
  if (url.pathname.includes("/confirmed") || url.pathname.includes("/manage")) return false;
  if (url.searchParams.has("project") || url.searchParams.has("reschedule")) return false;
  return true;
}

const pagesProxyWorker = {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);
    const purpose = request.headers.get("purpose") ?? "";
    const secPurpose = request.headers.get("sec-purpose") ?? "";
    const isNextPrefetch = request.headers.has("next-router-prefetch");
    const isBrowserPrefetch = purpose.includes("prefetch") || secPurpose.includes("prefetch");

    if (isNextPrefetch || isBrowserPrefetch) {
      return new Response(null, {
        status: 204,
        headers: {
          "cache-control": "private, no-store",
          ...SECURITY_HEADERS,
        },
      });
    }

    const rateLimited = rateLimitResponse(request, incomingUrl);
    if (rateLimited) return rateLimited;

    // M4 (§2): set true once a Studio admin session is verified on a genuine
    // admin surface, so the shared header-build site below mints the signed
    // `x-reese-admin-proof` header for the origin to independently verify.
    let adminSurfaceVerified = false;

    if (incomingUrl.hostname === "schedule.bythereeses.com") {
      if (incomingUrl.pathname === "/") {
        return redirectResponse(new URL("/book/wedding-photography-discovery-call", incomingUrl.origin), 303);
      }
      if (!isSchedulePublicPath(incomingUrl.pathname)) {
        return redirectResponse(new URL("/book/wedding-photography-discovery-call", incomingUrl.origin), 303);
      }
    }

    if (incomingUrl.hostname === "studio.bythereeses.com" && incomingUrl.pathname.startsWith("/book/")) {
      return redirectResponse(new URL(incomingUrl.pathname + incomingUrl.search, "https://schedule.bythereeses.com"), 303);
    }

    if (isStudioHost(incomingUrl)) {
      const adminCallback = incomingUrl.pathname === "/api/google/callback"
        ? await adminGoogleCallback(request, env)
        : null;
      if (adminCallback) return adminCallback;

      if (incomingUrl.pathname === "/admin/login") {
        return loginPage(incomingUrl.searchParams.get("next") || "/");
      }
      if (incomingUrl.pathname === "/admin/logout") {
        const response = redirectResponse(new URL("/admin/login", incomingUrl.origin), 303);
        response.headers.append("set-cookie", clearCookie(ADMIN_SESSION_COOKIE));
        return response;
      }
      if (incomingUrl.pathname === "/admin/auth/google") {
        return adminGoogleAuth(request);
      }
      if (!isStudioPublicPath(incomingUrl.pathname)) {
        if (!(await verifyAdminSession(request, env))) {
          return redirectResponse(new URL(`/admin/login?next=${encodeURIComponent(incomingUrl.pathname + incomingUrl.search)}`, incomingUrl.origin), 303);
        }
        // Admin session verified on an admin surface — the origin may be given a
        // signed proof (built at the shared header-build site below).
        adminSurfaceVerified = true;
      }
    }

    if (incomingUrl.hostname === "studio.bythereeses.com" && incomingUrl.pathname === "/api/google/auth") {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
      url.searchParams.set("redirect_uri", "https://studio.bythereeses.com/api/google/callback");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("scope", [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/calendar.events",
      ].join(" "));

      return redirectResponse(url, 307);
    }

    const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, WORKER_ORIGIN);
    const shouldCachePublicBookingPage = canCachePublicBookingPage(request, incomingUrl);
    const cache = shouldCachePublicBookingPage ? caches.default : null;
    const cacheKey = shouldCachePublicBookingPage
      ? new Request(incomingUrl.toString(), { method: "GET" })
      : null;
    if (cache && cacheKey) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const cachedHeaders = new Headers(cached.headers);
        // [Fable-fix — cache-HIT path] Apply the SAME preserve-app-CSP-vs-inject-
        // fallback logic as the miss path. The cached body was finalized on the
        // miss (booking → baseline, never a nonce), so this re-preserves the
        // baseline; amending only the miss path would serve the wrong CSP here.
        const cachedAppCsp = cached.headers.get("content-security-policy");
        const cachedAppReportCsp = cached.headers.get("content-security-policy-report-only");
        cachedHeaders.set("x-reese-cache", "HIT");
        applySecurityHeaders(cachedHeaders);
        applyAppCsp(cachedHeaders, cachedAppCsp, cachedAppReportCsp);
        return new Response(cached.body, {
          status: cached.status,
          statusText: cached.statusText,
          headers: cachedHeaders,
        });
      }
    }

    const headers = new Headers(request.headers);
    // Strip any client-supplied trust headers so they can never be spoofed
    // through the proxy (for BOTH hosts). The proxy re-sets the legitimate
    // values below. Deleting x-reese-origin-secret unconditionally also closes
    // the latent gap where an inbound value passed through when
    // ORIGIN_PROXY_SECRET was unset.
    headers.delete("x-reese-admin-proof");
    headers.delete("x-reese-origin-secret");
    headers.set("x-forwarded-host", incomingUrl.host);
    headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));
    headers.set("x-reese-pages-proxy", "1");
    if (env.ORIGIN_PROXY_SECRET) {
      headers.set("x-reese-origin-secret", env.ORIGIN_PROXY_SECRET);
    }
    // M4 (§2): mint the signed admin proof after a verified admin session on an
    // admin surface. Bound to method + host (the forwarded x-forwarded-host) +
    // path + timestamp so it cannot be replayed against another route/host or
    // outside the verifier's skew window.
    if (adminSurfaceVerified && env.ADMIN_PROOF_SECRET) {
      const tsSeconds = Math.floor(Date.now() / 1000);
      const host = headers.get("x-forwarded-host") || incomingUrl.host;
      const sig = await hmac(env.ADMIN_PROOF_SECRET, `${request.method}\n${host}\n${incomingUrl.pathname}\n${tsSeconds}`);
      headers.set("x-reese-admin-proof", `v1.${tsSeconds}.${sig}`);
    }
    headers.delete("host");
    headers.delete("content-length");

    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

    const proxiedRequest = new Request(targetUrl, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });

    const response = await fetch(proxiedRequest);
    const responseHeaders = new Headers(response.headers);
    const location = responseHeaders.get("location");

    // [Fable-fix] Capture any app-provided CSP BEFORE the static baseline is
    // applied. The Next middleware emits a per-request nonce'd policy for
    // eligible Studio/token document routes; the proxy must preserve it rather
    // than clobber it (the header carries the nonce). Booking pages carry none,
    // so their cached HTML stays baseline/no-nonce.
    const appCsp = response.headers.get("content-security-policy");
    const appReportCsp = response.headers.get("content-security-policy-report-only");

    responseHeaders.delete("content-security-policy");
    responseHeaders.delete("x-reese-origin-secret");
    responseHeaders.set("x-reese-cache", shouldCachePublicBookingPage ? "MISS" : "BYPASS");
    applySecurityHeaders(responseHeaders);
    applyAppCsp(responseHeaders, appCsp, appReportCsp);
    responseHeaders.set("referrer-policy", referrerPolicyFor(incomingUrl.pathname));
    if (location?.startsWith(WORKER_ORIGIN)) {
      responseHeaders.set("location", location.replace(WORKER_ORIGIN, incomingUrl.origin));
    }
    if (shouldCachePublicBookingPage && response.status === 200 && responseHeaders.get("content-type")?.includes("text/html")) {
      responseHeaders.set("cache-control", `public, max-age=${PUBLIC_BOOKING_CACHE_SECONDS}`);
    }

    const outgoing = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
    if (cache && cacheKey && response.status === 200 && responseHeaders.get("content-type")?.includes("text/html")) {
      const cacheHeaders = new Headers(outgoing.headers);
      cacheHeaders.set("cache-control", `public, max-age=${PUBLIC_BOOKING_CACHE_SECONDS}`);
      cacheHeaders.set("x-reese-cache", "MISS");
      await cache.put(cacheKey, new Response(outgoing.clone().body, {
        status: outgoing.status,
        statusText: outgoing.statusText,
        headers: cacheHeaders,
      }));
    }

    return outgoing;
  },
};

export default pagesProxyWorker;
