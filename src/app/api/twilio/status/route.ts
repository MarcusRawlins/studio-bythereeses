import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { handleStatusCallback, verifyTwilioSignature } from "@/lib/twilio-webhook";
import { NextResponse } from "next/server";

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
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "Twilio auth token is not configured." }, { status: 503 });
  }
  // B2: the status route verifies against its OWN configured URL constant — the
  // same string sms.ts sets as the outbound StatusCallback param and that is set
  // in the Twilio console. A mismatch is a designed-in 403.
  const url = process.env.TWILIO_PUBLIC_WEBHOOK_URL_STATUS;
  if (!url) {
    return NextResponse.json({ error: "Twilio status webhook URL is not configured." }, { status: 503 });
  }

  const provided = request.headers.get("x-twilio-signature");
  if (!provided) {
    return NextResponse.json({ error: "Missing signature." }, { status: 403 });
  }

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

  try {
    await handleStatusCallback({
      messageSid: form.get("MessageSid") ? String(form.get("MessageSid")) : null,
      messageStatus: form.get("MessageStatus") ? String(form.get("MessageStatus")) : null,
    });
  } catch (error) {
    console.error("Twilio status handling failed", error);
    return NextResponse.json({ error: "Failed to process status callback." }, { status: 500 });
  }

  return twiml(200);
}
