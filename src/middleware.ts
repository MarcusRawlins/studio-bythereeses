import { adminProofMode, adminProofRequired, verifyAdminProxyProof } from "@/lib/admin-proxy-auth";
import { buildCsp, cspHeaderName, cspMode } from "@/lib/csp";
import { guardDirectWorkerPageRequest } from "@/lib/origin-guard";
import { NextResponse, type NextRequest } from "next/server";

// Next.js 16 proxy.ts currently runs on Node.js and OpenNext Cloudflare
// cannot deploy Node middleware. Keep the edge middleware convention until
// Next/OpenNext support edge proxy for this target. Everything imported here
// (origin-guard, admin-proxy-auth, csp) is edge-safe — admin-proxy-auth uses
// WebCrypto (crypto.subtle), never node:crypto, and the CSP nonce uses the
// global WebCrypto `crypto.randomUUID` + `btoa`.

const SCHEDULE_HOST = "schedule.bythereeses.com";

// Mirror of the proxy's `canCachePublicBookingPage` (host check intentionally
// omitted here — see `isCspNonceEligible`). Identifies the /book/* GET pages the
// proxy caches for 60s so we NEVER bake a per-request nonce into their HTML.
function isCacheableBookingRequest(request: NextRequest, url: URL): boolean {
  if (request.method !== "GET") return false;
  if (!url.pathname.startsWith("/book/")) return false;
  if (url.pathname.includes("/confirmed") || url.pathname.includes("/manage")) return false;
  if (url.searchParams.has("project") || url.searchParams.has("reschedule")) return false;
  return true;
}

function isPrefetch(request: NextRequest): boolean {
  if (request.headers.has("next-router-prefetch")) return true;
  const purpose = request.headers.get("purpose") ?? "";
  const secPurpose = request.headers.get("sec-purpose") ?? "";
  return purpose.includes("prefetch") || secPurpose.includes("prefetch");
}

// Phase 6 §4 (L8): a request is nonce-eligible only when it is a NON-cacheable
// Studio (or token) HTML document route. Excluded:
//   - `/api/*` — JSON responses, no framework/inline scripts to nonce.
//   - prefetches — Next's own guidance skips them; they never render scripts.
//   - the public schedule host — entirely booking; [Fable-fix] keyed off
//     `x-forwarded-host` (set by the proxy), NOT `url.hostname`, because the app
//     only ever sees the internal workers.dev origin URL.
//   - any cacheable /book/* page — belt-and-suspenders for dev/preview where no
//     proxy sets `x-forwarded-host`.
// A frozen per-request nonce in cached HTML would mismatch the per-request CSP
// header and block every script, so those surfaces get NO nonce (baseline CSP).
function isCspNonceEligible(request: NextRequest, url: URL): boolean {
  if (url.pathname.startsWith("/api/")) return false;
  if (isPrefetch(request)) return false;
  if (request.headers.get("x-forwarded-host") === SCHEDULE_HOST) return false;
  if (isCacheableBookingRequest(request, url)) return false;
  return true;
}

// Phase 6 §4 (L8): attach a per-request nonce'd CSP for eligible document routes.
// DEFAULT-OFF and fully throw-safe: CSP_MODE=off (or any failure) returns a plain
// `NextResponse.next()` with no new header, so today's behavior is preserved
// byte-for-byte and the live site cannot break without a deliberate flag flip.
function withCsp(request: NextRequest): NextResponse {
  const mode = cspMode();
  if (mode === "off") return NextResponse.next();

  const url = new URL(request.url);
  if (!isCspNonceEligible(request, url)) return NextResponse.next();

  let nonce: string;
  try {
    nonce = btoa(crypto.randomUUID());
  } catch {
    // Never let nonce generation break a request — fall back to no-op.
    return NextResponse.next();
  }

  const csp = buildCsp(nonce);

  // Next extracts the nonce from the `content-security-policy` REQUEST header and
  // injects it into its framework/inline scripts. This request header carries the
  // enforce-named CSP in BOTH report and enforce modes, so scripts are nonced
  // either way; only the RESPONSE header name differs (Report-Only vs enforce).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(cspHeaderName(mode), csp);
  return response;
}

export async function middleware(request: NextRequest) {
  const blocked = guardDirectWorkerPageRequest(request);
  if (blocked) return blocked;

  // Phase 6 §2 (M4): defense-in-depth admin authorization, three-state flag.
  //   - "off" (default, unset/other): strict no-op — the proof is never
  //     evaluated (fail-open, zero overhead, zero behavior change).
  //   - "log": observation window — evaluate the proof for admin surfaces and
  //     warn on failure, but NEVER block (proves coverage before enforcing).
  //   - "enforce": a required-but-missing/invalid proof yields a 404.
  const mode = adminProofMode();
  if (mode !== "off") {
    const { pathname } = new URL(request.url);
    if (adminProofRequired(pathname)) {
      // Fully throw-safe: verifyAdminProxyProof already fails closed without
      // throwing, but wrap the evaluation so a verifier bug can neither 500 nor
      // block a request in the observation window.
      let proofValid = false;
      try {
        proofValid = await verifyAdminProxyProof(request);
      } catch {
        proofValid = false;
      }

      if (!proofValid) {
        if (mode === "enforce") {
          return new NextResponse("Not Found", { status: 404 });
        }
        // mode === "log": single structured line, visible via `wrangler tail`.
        console.warn(`[admin-proof] missing/invalid proof for ${request.method} ${pathname}`);
      }
    }
  }

  // Phase 6 §4 (L8): CSP nonce. Default-off; report mode can never affect the
  // page (Report-Only); enforce is Tyler's deliberate step after a report window
  // + preview hydration validation.
  return withCsp(request);
}

export const config = {
  matcher: [
    "/api/:path*",
    "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|.*\\..*).*)",
  ],
};
