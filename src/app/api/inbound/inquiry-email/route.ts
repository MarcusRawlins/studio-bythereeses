import { ingestInboundInquiry, isInquiryIntakeEnabled, MAX_INBOUND_JSON_BYTES, type InboundEmailPayload } from "@/lib/inbound-inquiry";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";

// Fail-closed bearer auth on a DEDICATED secret (NOT the shared agent token).
// Mirrors the cron route's constant-time compare: 503 when unset, 401 when wrong.
function secretsMatch(provided: string | null, expected: string) {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const configuredSecret = process.env.INBOUND_INTAKE_SECRET;
  if (!configuredSecret) {
    // Fail closed (unconfigured). Non-2xx so the Worker forwards the lead to a
    // human (B3b) rather than treating it as accepted-and-discarded.
    return NextResponse.json({ error: "Inbound intake secret is not configured." }, { status: 503 });
  }

  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretsMatch(provided, configuredSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Server-side feature flag. Flag OFF ⇒ 503 (non-2xx), NEVER 202/200, so the
  // Worker's `!res.ok` branch forwards the message to the human fallback (B3b).
  if (!isInquiryIntakeEnabled()) {
    return NextResponse.json({ error: "Inbound intake is disabled." }, { status: 503 });
  }

  // Endpoint-level hard size cap (defense in depth if the Worker is bypassed).
  const rawBody = await request.text();
  if (rawBody.length > MAX_INBOUND_JSON_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  let payload: InboundEmailPayload;
  try {
    payload = JSON.parse(rawBody) as InboundEmailPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  // Persist-then-2xx: only return 2xx after the inbound_inquiries row is durably
  // written. Idempotency is derived CRM-side from payload.messageId (the JSON
  // body), NOT an HTTP Idempotency-Key header (which would throw on CR/LF).
  try {
    const result = await ingestInboundInquiry(payload);
    return NextResponse.json(result, { status: 200 });
  } catch {
    // A failure to persist must be a non-2xx so the Worker forwards to a human.
    return NextResponse.json({ error: "Failed to persist inquiry." }, { status: 500 });
  }
}
