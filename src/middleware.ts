import { guardDirectWorkerPageRequest } from "@/lib/origin-guard";
import { NextResponse, type NextRequest } from "next/server";

// Next.js 16 proxy.ts currently runs on Node.js and OpenNext Cloudflare
// cannot deploy Node middleware. Keep the edge middleware convention until
// Next/OpenNext support edge proxy for this target.
export function middleware(request: NextRequest) {
  const blocked = guardDirectWorkerPageRequest(request);
  return blocked ?? NextResponse.next();
}

export const config = {
  matcher: [
    "/api/:path*",
    "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|.*\\..*).*)",
  ],
};
