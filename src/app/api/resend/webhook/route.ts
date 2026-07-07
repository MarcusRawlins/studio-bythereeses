import { recordJobRun } from "@/lib/job-runs";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import {
  handleResendWebhookEvent,
  MAX_RESEND_WEBHOOK_BYTES,
  verifyResendWebhookPayload,
} from "@/lib/resend-webhook";
import { NextResponse } from "next/server";

// Phase 24 (CR-6). Pin the Node runtime so node:crypto (HMAC-SHA256 + timingSafeEqual) is
// available, same as the Stripe/Twilio webhook routes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Spec §3.3 (rev 2, MAJOR 1 fix): this route is classified PROXY-ONLY, exactly like Twilio's
// inbound webhook — it CALLS guardDirectWorkerApiRequest itself and is deliberately NOT added to
// origin-guard's PUBLIC_API_PREFIXES (that bypass list is never consulted by
// guardDirectWorkerApiRequest, so adding it would be dead code — see origin-guard.ts:93-104 and
// the pinned negative test in origin-guard.test.ts). Resend must be pointed at the public studio
// host (through the pages-proxy), never at the *.workers.dev origin directly.
export async function POST(request: Request) {
  // Belt-and-suspenders: reject a direct *.workers.dev POST that bypassed the proxy's rate
  // limiter. No-op when ORIGIN_PROXY_SECRET is unset (dev/tests). Mirrors twilio/inbound/route.ts.
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const rawBody = await request.text();

  // Payload-size cap BEFORE signature verification (rev 2 MINOR 9, spec §10 test 19): this route
  // is reachable (through the proxy) by anyone until the signature is verified, so an unbounded
  // body must never be buffered/hashed. This is a pre-verification reject → the non-alerting
  // `resend-webhook-rejected` key (I5), never `resend-webhook`.
  if (Buffer.byteLength(rawBody, "utf8") > MAX_RESEND_WEBHOOK_BYTES) {
    await recordJobRun("resend-webhook-rejected", false, "Resend webhook payload exceeds the size cap.");
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");

  // (A) Fail-closed on unset secret → 503, recorded under a DISTINCT non-alerting key that the
  // `resend-webhook-signature` misconfiguration WARN never reads (diff-review MEDIUM 1). Recording
  // the unset-secret case under `resend-webhook-rejected` would let a config gap (or a scanner
  // hitting an unconfigured endpoint) masquerade as a "rotated/wrong secret" WARN — dark-griefing
  // the health panel. The genuinely-unconfigured state is surfaced by config-preflight, not here.
  // This IS the dark mechanism (spec §7) — no separate enable flag.
  if (!process.env.RESEND_WEBHOOK_SECRET?.trim()) {
    await recordJobRun("resend-webhook-unconfigured", false, "RESEND_WEBHOOK_SECRET unset");
    return NextResponse.json({ error: "Resend webhook is not configured." }, { status: 503 });
  }

  // (B) Verify BEFORE any processing (I1). A pre-verify throw → 401, recorded ONLY under the
  // non-alerting rejected key (I5) so a scanner spamming bad signatures cannot grief the
  // resend-webhook counter. Mirrors stripe/webhook/route.ts.
  let event: Record<string, unknown>;
  try {
    event = verifyResendWebhookPayload({ rawBody, svixId, svixTimestamp, svixSignature });
  } catch (error) {
    await recordJobRun(
      "resend-webhook-rejected",
      false,
      error instanceof Error ? error.message : "Resend webhook signature rejected.",
    );
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  // (C) Signature verified → act. A throw here is a REAL processing failure and DOES count
  // toward resend-webhook consecutive_failures. Return non-2xx so Resend/SVIX retries (no silent
  // loss of a bounce/complaint signal).
  try {
    const result = await handleResendWebhookEvent(event);
    await recordJobRun("resend-webhook", true);
    return NextResponse.json({ received: true, result }, { status: 200 });
  } catch (error) {
    console.error("Resend webhook processing failed", error);
    await recordJobRun(
      "resend-webhook",
      false,
      error instanceof Error ? error.message : "Resend webhook processing failed.",
    );
    return NextResponse.json({ error: "Resend webhook processing failed." }, { status: 500 });
  }
}

// Not signature-verifiable via GET; Resend only ever POSTs. Explicit 404 (not the Next.js default
// 405) so the route surface matches the other webhook endpoints.
export async function GET() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
