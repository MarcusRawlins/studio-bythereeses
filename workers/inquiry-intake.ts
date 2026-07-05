// Phase 8a — Cloudflare Email Routing intake Worker (reese-inquiry-intake).
//
// Mirrors the split-worker pattern of workers/scheduler-reminders.ts. Bound to
// Email Routing via the dashboard (custom address inquiries@bythereeses.com →
// Send to a Worker → reese-inquiry-intake). Does MINIMAL work: size gate,
// header capture, cap the raw body, POST to the CRM endpoint. ALL parsing,
// sanitization, dedupe, and DB writes happen CRM-side (single write path).
//
// NO SILENT DROPS (B3): every exit path forwards the message to a verified human
// fallback destination. A bare `return`, `setReject`, or an unforwarded error
// would silently lose a real client's inquiry. `setReject` is used nowhere.

export interface Env {
  INTAKE_ENDPOINT: string; // https://studio.bythereeses.com/api/inbound/inquiry-email
  INBOUND_INTAKE_SECRET: string; // dedicated secret, NOT the agent token
  INTAKE_ENABLED: string; // "true" | "false" (flag; default off)
  INTAKE_FALLBACK: string; // VERIFIED Email Routing destination address (N8)
}

// Hard cap on the raw MIME streamed to the endpoint (~2 MB). Kept in sync with
// MAX_RAW_BYTES / MAX_INBOUND_JSON_BYTES in src/lib/inbound-inquiry.ts.
const MAX_RAW_BYTES = 2_000_000;

// Minimal structural type for the Email Routing message (avoids a hard dep on
// @cloudflare/workers-types in this standalone Worker entry).
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
    // Every exit path forwards to a human — NEVER a bare `return` (which discards
    // the message with no delivery = silent drop) and NEVER `setReject`. (B3)
    try {
      if (env.INTAKE_ENABLED !== "true") {
        await message.forward(env.INTAKE_FALLBACK); // flag OFF → forward, do NOT drop (B3a)
        return;
      }
      if (message.rawSize > MAX_RAW_BYTES) {
        await message.forward(env.INTAKE_FALLBACK); // oversize is a lead → forward, not setReject (B3d)
        return;
      }

      // Read (do NOT trust) authentication results + envelope. messageId is
      // attacker-chosen and may contain CR/LF — kept in the JSON body only, never
      // an HTTP header (a CR/LF header would make fetch() throw). (N1)
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
          Authorization: `Bearer ${env.INBOUND_INTAKE_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        // Do NOT follow redirects. If the proxy ever login-walls this path it
        // answers 303 → /admin/login, which serves a 200 login PAGE. Following
        // that would look like a 2xx "persisted" and silently discard the lead.
        // With manual redirect a 3xx stays a 3xx and is treated as not-persisted.
        redirect: "manual",
      });

      // "Persisted" is ONLY a real 2xx that was not a followed/opaque redirect.
      // Any redirect (res.redirected, an opaqueredirect response, or a 3xx
      // status) or any non-2xx forwards the lead to a human. This makes it
      // impossible for a future proxy/routing change to reintroduce a
      // 2xx-non-persist silent drop. (B3b + Fable B1)
      const isRedirect = res.redirected || res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
      if (isRedirect || !res.ok) {
        await message.forward(env.INTAKE_FALLBACK);
      }
    } catch {
      // Any throw or network error → forward to a human. Never let an exception
      // discard the message. (B3c)
      await message.forward(env.INTAKE_FALLBACK);
    }
  },
};

export default worker;
