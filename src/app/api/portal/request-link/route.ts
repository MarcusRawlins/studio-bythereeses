import { requestPortalMagicLink } from "@/lib/portal";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";

export const runtime = "nodejs"; // needs node:crypto (hashToken) + D1
export const dynamic = "force-dynamic";

// Single code path for the response. Byte-identical + same-time for match /
// no-match / malformed / rate-limited-soft — the page never reveals whether the
// address matched. HTML form submit → 303 to /portal/login?sent=1; a JSON caller
// → { ok: true }.
function uniformResponse(request: Request) {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("application/json")) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.redirect(new URL("/portal/login?sent=1", request.url), 303);
}

// [N1] On Workers/OpenNext a bare unawaited promise is CANCELED the moment the
// Response returns, so the mint/send would silently never run. Register the
// deferred task with the platform `ctx.waitUntil`. Local/Node (no Cloudflare
// context) has no such cancellation — schedule via `queueMicrotask` so nothing
// is awaited before responding, preserving the timing-flat critical path.
function scheduleDeferred(task: () => Promise<void>) {
  try {
    const { ctx } = getCloudflareContext();
    ctx.waitUntil(task());
  } catch {
    queueMicrotask(() => {
      void task();
    });
  }
}

export async function POST(request: Request) {
  // Flag off → identical no-op response (no parse, no deferred work).
  if (process.env.PORTAL_MAGIC_LINK_ENABLED !== "1") {
    return uniformResponse(request);
  }

  // [B3] The ONLY pre-response work: parse formData + register the deferred task.
  // ALL match-correlated work (resolution, per-email cap, hash, mint, send) runs
  // on the deferred task AFTER the response is committed, so a matching and a
  // non-matching email are indistinguishable by response bytes or timing.
  const form = await request.formData().catch(() => null);
  const email = String(form?.get("email") ?? "");

  scheduleDeferred(() => requestPortalMagicLink({ email }));

  return uniformResponse(request);
}
