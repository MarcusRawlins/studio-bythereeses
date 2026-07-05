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
  publicMutation: { max: 20, windowSeconds: 300 },
  agentApi: { max: 120, windowSeconds: 60 },
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

async function verifyAdminSession(request, env) {
  if (!env.ADMIN_SESSION_SECRET) return false;
  const token = parseCookies(request)[ADMIN_SESSION_COOKIE];
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = await hmac(env.ADMIN_SESSION_SECRET, payload);
  if (signature !== expected) return false;

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
  return pathname.startsWith("/proposal/") || pathname.startsWith("/api/proposal/")
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

function isStudioHost(url) {
  return url.hostname !== "schedule.bythereeses.com";
}

function isPublicAssetPath(pathname) {
  return (
    pathname === "/favicon.ico" ||
    pathname === "/icon.png" ||
    pathname === "/apple-icon.png" ||
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/brand/") ||
    pathname.startsWith("/fonts/")
  );
}

function isPortalPublicPath(pathname) {
  return pathname === "/portal" || pathname.startsWith("/p/");
}

function isStudioTrustedAgentApiPath(pathname) {
  return pathname === "/api/mcp" || pathname.startsWith("/api/agent/");
}

function isStudioPublicPath(pathname) {
  return (
    pathname === "/admin/login" ||
    pathname === "/admin/logout" ||
    pathname === "/admin/auth/google" ||
    pathname === "/api/google/callback" ||
    isStudioTrustedAgentApiPath(pathname) ||
    isPortalPublicPath(pathname) ||
    pathname.startsWith("/proposal/") ||
    pathname.startsWith("/api/proposal/") ||
    isPublicAssetPath(pathname)
  );
}

function isSchedulePublicPath(pathname) {
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

function rateLimitKind(url, request) {
  const pathname = url.pathname;
  if (pathname === "/admin/auth/google" || pathname === "/api/google/callback") return "adminAuth";
  if (pathname === "/api/mcp" || pathname.startsWith("/api/agent/")) return "agentApi";
  if (
    pathname.startsWith("/proposal/") ||
    pathname.startsWith("/p/") ||
    pathname === "/portal" ||
    pathname.startsWith("/api/proposal/")
  ) {
    return "tokenAccess";
  }
  if (
    request.method !== "GET" &&
    (
      pathname.startsWith("/api/scheduler/bookings") ||
      /^\/api\/questionnaires\/[^/]+\/responses\/?$/.test(pathname)
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
      if (!isStudioPublicPath(incomingUrl.pathname) && !(await verifyAdminSession(request, env))) {
        return redirectResponse(new URL(`/admin/login?next=${encodeURIComponent(incomingUrl.pathname + incomingUrl.search)}`, incomingUrl.origin), 303);
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
        cachedHeaders.set("x-reese-cache", "HIT");
        applySecurityHeaders(cachedHeaders);
        return new Response(cached.body, {
          status: cached.status,
          statusText: cached.statusText,
          headers: cachedHeaders,
        });
      }
    }

    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", incomingUrl.host);
    headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));
    headers.set("x-reese-pages-proxy", "1");
    if (env.ORIGIN_PROXY_SECRET) {
      headers.set("x-reese-origin-secret", env.ORIGIN_PROXY_SECRET);
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

    responseHeaders.delete("content-security-policy");
    responseHeaders.delete("x-reese-origin-secret");
    responseHeaders.set("x-reese-cache", shouldCachePublicBookingPage ? "MISS" : "BYPASS");
    applySecurityHeaders(responseHeaders);
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
