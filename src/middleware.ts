import { adminProofMode, adminProofRequired, verifyAdminProxyProof } from "@/lib/admin-proxy-auth";
import { guardDirectWorkerPageRequest } from "@/lib/origin-guard";
import { NextResponse, type NextRequest } from "next/server";

// Next.js 16 proxy.ts currently runs on Node.js and OpenNext Cloudflare
// cannot deploy Node middleware. Keep the edge middleware convention until
// Next/OpenNext support edge proxy for this target. Everything imported here
// (origin-guard, admin-proxy-auth) is edge-safe — admin-proxy-auth uses
// WebCrypto (crypto.subtle), never node:crypto.
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

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/:path*",
    "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|.*\\..*).*)",
  ],
};
