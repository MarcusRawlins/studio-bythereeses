import { db } from "@/db/client";
import { clients, projectCommunications, smsSuppressions } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Phase 8b — Twilio SMS send helper.
//
// Mirrors the `sendResendEmail` shape in `src/lib/email.ts`, with three
// deliberate differences (spec §1):
//   (a) FAIL-CLOSED (throw) in production when TWILIO_* is unset — email.ts
//       returns false, but SMS is consent/legal-sensitive and must never appear
//       to succeed. Dev-only simulate fallback OUTSIDE prod.
//   (b) a CONSENT GATE (§2.2) enforced HERE (in the library, so it holds for
//       EVERY caller), before any Twilio call.
//   (c) E.164 normalization.
//
// This helper is the ONLY module that talks to api.twilio.com. Nothing else
// imports fetch("api.twilio.com"). It has NO agent/MCP surface — only the admin
// send action calls sendProjectSms.
// ---------------------------------------------------------------------------

export class SmsConfigError extends Error {
  constructor(message = "Twilio is not configured.") {
    super(message);
    this.name = "SmsConfigError";
  }
}

export class SmsConsentError extends Error {
  constructor(message = "Recipient has not opted in to SMS.") {
    super(message);
    this.name = "SmsConsentError";
  }
}

export type SmsSendResult =
  | { ok: true; sid: string; to: string; status: string }
  | { ok: false; reason: "flag_off" | "no_consent" | "bad_number" | "suppressed" };

/** The transport flag. OFF/unset ⇒ the send transport never fires (drafting and
 * STOP-handling stay live). Read in the body (not an `env = process.env` default
 * param) to avoid the TS2559 weak-type build failure (Active-Learning Log). */
export function smsEnabled(): boolean {
  return process.env.SMS_ENABLED === "1";
}

export const SMS_OPT_OUT_LANGUAGE = "Reply STOP to opt out.";

/** A message already carries opt-out language if it contains a CASE-SENSITIVE
 * standalone `STOP` token (or an explicit "Reply STOP"). Case-sensitive on
 * purpose: an incidental lowercase "stop" ("happy to stop by") must NOT be
 * treated as opt-out language, or the mandatory "Reply STOP to opt out" append
 * would be silently skipped (a TCPA gap). Idempotent so an established 10DLC
 * campaign whose carrier appends its own STOP is not double-tagged. */
function hasOptOutLanguage(body: string): boolean {
  return /\bSTOP\b/.test(body);
}

export function appendOptOutLanguage(body: string): string {
  return hasOptOutLanguage(body) ? body : `${body}\n\n${SMS_OPT_OUT_LANGUAGE}`;
}

// ---------------------------------------------------------------------------
// E.164 validation / normalization (§1.2). US-first; reject (return null) rather
// than guess. Reused by the outbound gate (destination) and the inbound webhook
// (matching a `From` number to clients). `clients.phone` is free-text today, so
// normalization at send time is mandatory.
// ---------------------------------------------------------------------------
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (hasPlus) {
    const e164 = `+${digits}`;
    return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
  }
  if (digits.length === 10) return `+1${digits}`; // US local
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Mask a destination number for logs/metadata (never log the full number or the
 * auth token). e.g. +15551234567 → "+1555…4567". */
export function maskNumber(e164: string): string {
  if (e164.length <= 8) return "***";
  return `${e164.slice(0, 5)}…${e164.slice(-4)}`;
}

/** Exported so the admin UI can reflect suppression state (read-only) next to an
 * SMS draft without duplicating the query — the send gate below remains the
 * authoritative check; this is a display-only convenience. */
export async function isNumberSuppressed(e164: string): Promise<boolean> {
  const row = await db.query.smsSuppressions.findFirst({ where: eq(smsSuppressions.phoneE164, e164) });
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Low-level transport. Reads env in the body. Fail-closed in prod when secrets
// unset; dev fallback (simulate, no network) only OUTSIDE prod.
//
// @internal — DO NOT CALL DIRECTLY. This is the raw transport and has NO consent
// or suppression gate. Every real send MUST go through `sendProjectSms`, which
// enforces opt-in + E.164 + suppression + flag before ever reaching here. Only
// exported so the fail-closed/dev-simulate contract can be unit-tested; no
// product code outside this module may import it.
// ---------------------------------------------------------------------------
export async function sendTwilioMessage(
  input: { to: string; body: string },
): Promise<{ sid: string; status: string } | { simulated: true }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const isProd = process.env.NODE_ENV === "production";

  if (!sid || !token || !from) {
    if (isProd) throw new SmsConfigError("Twilio is not configured."); // fail closed
    return { simulated: true }; // dev-only fallback (no network)
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = btoa(`${sid}:${token}`); // Basic ACCOUNT_SID:AUTH_TOKEN
  const params: Record<string, string> = {
    To: input.to,
    From: from,
    Body: input.body,
  };
  // StatusCallback MUST equal the exact string the status route verifies against
  // (TWILIO_PUBLIC_WEBHOOK_URL_STATUS), so the URL Twilio signs equals the URL we
  // verify (B2). Only set when configured.
  const statusCallback = process.env.TWILIO_PUBLIC_WEBHOOK_URL_STATUS;
  if (statusCallback) params.StatusCallback = statusCallback;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`Twilio send failed: ${res.status}`);
  const json = (await res.json()) as { sid: string; status: string };
  return { sid: json.sid, status: json.status };
}

// ---------------------------------------------------------------------------
// High-level, consent-gated, logging send. THIS is what the admin send action
// calls. It is NOT exported to any agent/MCP surface.
// ---------------------------------------------------------------------------
export async function sendProjectSms(input: {
  projectId: string;
  clientId: string | null | undefined;
  body: string;
  communicationId?: string | null;
  actorName?: string;
}): Promise<SmsSendResult> {
  // --- Consent gate (§2.2), the FIRST action, before any Twilio call ---

  // 1 + 2. Resolve the destination client and assert client-level opt-in.
  if (!input.clientId) throw new SmsConsentError("SMS recipient has no linked client.");
  const client = await db.query.clients.findFirst({ where: eq(clients.id, input.clientId) });
  if (!client) throw new SmsConsentError("SMS recipient client not found.");
  if (client.smsOptIn !== true) {
    // No opt-in, no send, ever — a code gate, not a checkbox. Throw (never fall
    // through to a swallowed no-op that looks like success).
    throw new SmsConsentError("Client has not opted in to SMS.");
  }

  // 3. Normalize to E.164 or refuse (a malformed number is no valid destination).
  const to = toE164(client.phone);
  if (!to) return { ok: false, reason: "bad_number" };

  // 4. Suppression check (B3) — suppression WINS over the client column.
  if (await isNumberSuppressed(to)) return { ok: false, reason: "suppressed" };

  // --- Transport flag (§5). Off ⇒ dark no-op, no Twilio, no false success. ---
  if (!smsEnabled()) return { ok: false, reason: "flag_off" };

  // 5. Opt-out language is appended HERE (helper-side) so no caller can send a
  // message that lacks it.
  const body = appendOptOutLanguage(input.body);

  // 6. Transport.
  const result = await sendTwilioMessage({ to, body });
  const simulated = "simulated" in result;
  const sid = simulated ? "simulated" : result.sid;
  const status = simulated ? "simulated" : result.status;

  const now = new Date().toISOString();
  const actorName = input.actorName || "Tyler";
  const recipientName = [client.firstName, client.lastName].filter(Boolean).join(" ") || null;

  if (input.communicationId) {
    // Patch the approved draft to sent.
    await db
      .update(projectCommunications)
      .set({
        status: "sent",
        sentAt: now,
        recipientName,
        body,
        providerMessageId: simulated ? null : sid,
        deliveryStatus: status,
        updatedAt: now,
      })
      .where(eq(projectCommunications.id, input.communicationId));
  } else {
    await db.insert(projectCommunications).values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      clientId: client.id,
      direction: "outbound",
      channel: "sms",
      status: "sent",
      subject: null,
      body,
      recipientName,
      recipientEmail: null,
      scheduledFor: null,
      sentAt: now,
      sourceType: null,
      sourceId: null,
      createdBy: "admin",
      providerMessageId: simulated ? null : sid,
      deliveryStatus: status,
      createdAt: now,
      updatedAt: now,
    });
  }

  await logActivity({
    projectId: input.projectId,
    clientId: client.id,
    action: "project.communication.sms_sent",
    actorType: "admin",
    actorName,
    metadata: {
      communicationId: input.communicationId ?? null,
      sid: simulated ? null : sid,
      to: maskNumber(to),
      status,
      simulated,
    },
  });

  return { ok: true, sid, to, status };
}
