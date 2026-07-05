import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { handleInboundSms, verifyTwilioSignature } from "@/lib/twilio-webhook";
import { NextResponse } from "next/server";

// Pin the Node runtime so node:crypto (HMAC-SHA1 + timingSafeEqual) is available,
// reusing the proven scheduler-reminders pattern.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function twiml(status = 200) {
  return new NextResponse(EMPTY_TWIML, {
    status,
    headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  // Belt-and-suspenders: reject a direct *.workers.dev POST (which would bypass
  // the proxy's rate limiter). No-op when ORIGIN_PROXY_SECRET is unset (dev/tests).
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  // Fail closed on BOTH the token AND the per-route configured URL (B2): the
  // inbound Messaging webhook and the status callback are DIFFERENT URLs, so each
  // route verifies against its OWN constant. Non-2xx so an unverified body is
  // never treated as accepted.
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "Twilio auth token is not configured." }, { status: 503 });
  }
  const url = process.env.TWILIO_PUBLIC_WEBHOOK_URL_INBOUND;
  if (!url) {
    return NextResponse.json({ error: "Twilio inbound webhook URL is not configured." }, { status: 503 });
  }

  const provided = request.headers.get("x-twilio-signature");
  if (!provided) {
    return NextResponse.json({ error: "Missing signature." }, { status: 403 });
  }

  // Parse the form ONCE for signature computation. The signed URL is the stored
  // constant, NOT reconstructed from Host/X-Forwarded-Host (attacker-influenceable).
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form body." }, { status: 400 });
  }
  const params: Array<[string, string]> = [];
  for (const [key, value] of form.entries()) {
    params.push([key, typeof value === "string" ? value : ""]);
  }

  if (!verifyTwilioSignature({ url, params, signature: provided, authToken: token })) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
  }

  // Signature passed — only NOW act on business meaning. Every branch returns 2xx
  // only after the intended DB effect is durably written.
  try {
    await handleInboundSms({
      from: String(form.get("From") ?? ""),
      body: String(form.get("Body") ?? ""),
      messageSid: form.get("MessageSid") ? String(form.get("MessageSid")) : null,
    });
  } catch (error) {
    console.error("Twilio inbound handling failed", error);
    // A failure to persist must be non-2xx so Twilio retries (no silent loss).
    return NextResponse.json({ error: "Failed to process inbound message." }, { status: 500 });
  }

  return twiml(200);
}
