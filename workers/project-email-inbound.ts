// Phase 14 — Cloudflare Email Routing Worker (reese-project-email-inbound).
//
// A near-copy of workers/inquiry-intake.ts. Bound to Email Routing via the
// dashboard (catch-all *@inbox.bythereeses.com → Send to a Worker →
// reese-project-email-inbound). Does MINIMAL work: size gate, header + ENVELOPE
// capture, cap the raw body, POST to the CRM endpoint. ALL token verification,
// parsing, sanitization, dedupe, and DB writes happen CRM-side (single write
// path). The reply token lives in the SMTP ENVELOPE recipient (message.to) — the
// CRM reads it there, NEVER from the spoofable To/Reply-To headers.
//
// NO SILENT DROPS (B3): every exit path forwards the message to a verified human
// fallback destination. `setReject` is used nowhere; a bare `return` /
// unforwarded error would silently lose a real client's reply. Machine callers
// MUST use redirect:"manual" and treat any redirect/opaqueredirect/3xx/non-2xx
// as not-persisted → forward (the 8a REJECT-class defense against a proxy
// login-wall 200 being misread as success).

export interface Env {
  INTAKE_ENDPOINT: string; // https://studio.bythereeses.com/api/inbound/project-email
  INBOUND_PROJECT_EMAIL_SECRET: string; // dedicated secret, NOT the agent token
  INTAKE_ENABLED: string; // "true" | "false" (flag; default off)
  INTAKE_FALLBACK: string; // VERIFIED Email Routing destination address
}

// Hard cap on the raw MIME streamed to the endpoint (~2 MB). Kept in sync with
// MAX_RAW_BYTES / MAX_INBOUND_JSON_BYTES in src/lib/inbound-inquiry.ts.
const MAX_RAW_BYTES = 2_000_000;

interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
  setReject(reason: string): void;
}

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      const slice = value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.length;
      if (total >= maxBytes) break;
    }
  } finally {
    reader.releaseLock();
  }
  let combined = "";
  const decoder = new TextDecoder();
  for (const chunk of chunks) combined += decoder.decode(chunk, { stream: true });
  combined += decoder.decode();
  return combined;
}

const worker = {
  async email(message: ForwardableEmailMessage, env: Env) {
    // Every exit path forwards to a human — NEVER a bare `return` and NEVER
    // `setReject`. (B3)
    try {
      if (env.INTAKE_ENABLED !== "true") {
        await message.forward(env.INTAKE_FALLBACK); // flag OFF → forward, do NOT drop
        return;
      }
      if (message.rawSize > MAX_RAW_BYTES) {
        await message.forward(env.INTAKE_FALLBACK); // oversize → forward, not setReject
        return;
      }

      // Capture the ENVELOPE recipient (message.to) so the CRM can read the reply
      // token from it — NEVER the To/Reply-To headers. messageId is attacker-
      // chosen and may contain CR/LF, so it rides in the JSON body only.
      const payload = {
        envelopeFrom: message.from,
        envelopeTo: message.to,
        headerFrom: message.headers.get("from"),
        subject: message.headers.get("subject"),
        messageId: message.headers.get("message-id"),
        inReplyTo: message.headers.get("in-reply-to"),
        references: message.headers.get("references"),
        authResults: message.headers.get("authentication-results") ?? "",
        rawSize: message.rawSize,
        raw: await readCapped(message.raw, MAX_RAW_BYTES),
        receivedAt: new Date().toISOString(),
      };

      const res = await fetch(env.INTAKE_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.INBOUND_PROJECT_EMAIL_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        // Do NOT follow redirects. A proxy login-wall answers 303 → /admin/login
        // (a 200 login PAGE); following it would look like success and silently
        // discard the reply. With manual redirect a 3xx stays a 3xx = not-persisted.
        redirect: "manual",
      });

      // "Persisted" is ONLY a real 2xx that was not a followed/opaque redirect.
      // Any redirect or non-2xx (incl. the 422 non-attach the endpoint returns
      // for an unmatched/invalid token, and the 503 flag-off/unconfigured)
      // forwards the message to a human.
      const isRedirect = res.redirected || res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
      if (isRedirect || !res.ok) {
        await message.forward(env.INTAKE_FALLBACK);
      }
    } catch {
      // Any throw or network error → forward to a human. Never discard.
      await message.forward(env.INTAKE_FALLBACK);
    }
  },
};

export default worker;
