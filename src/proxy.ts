import { guardDirectWorkerPageRequest } from "@/lib/origin-guard";
import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const blocked = guardDirectWorkerPageRequest(request);
  return blocked ?? NextResponse.next();
}

export const config = {
  matcher: [
    "/api/:path*",
    "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|.*\\..*).*)",
  ],
};
