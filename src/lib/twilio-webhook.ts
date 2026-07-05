import { db } from "@/db/client";
import { clients, projectCommunications, projectParticipants, smsSuppressions } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { maskNumber, toE164 } from "@/lib/sms";
import { and, eq, isNotNull } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Phase 8b — Twilio inbound webhook logic (untrusted input).
//
// Every field is attacker-controllable — anyone can POST form-encoded data to a
// public URL claiming to be Twilio. The endpoint is only trustworthy because of
// the X-Twilio-Signature check (verifyTwilioSignature). Business meaning
// (From/Body/MessageSid) is acted on ONLY AFTER the signature passes.
//
// These routes run on the Node runtime, so node:crypto (createHmac / SHA-1 +
// timingSafeEqual) is available — this is NOT edge middleware.
// ---------------------------------------------------------------------------

// Standard opt-out / opt-in keyword sets (exact-token, case-insensitive). We do
// NOT substring-match — "STOPPING BY" is not STOP; Twilio itself uses exact sets.
export const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
export const START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);
export const HELP_KEYWORDS = new Set(["HELP", "INFO"]);

// MessageStatus allowlist for the status callback (§4.3).
export const MESSAGE_STATUS_ALLOWLIST = new Set([
  "accepted",
  "queued",
  "sending",
  "sent",
  "receiving",
  "received",
  "delivered",
  "undelivered",
  "failed",
  "read",
  "canceled",
  "scheduled",
]);

const MAX_BODY_LENGTH = 1600; // Twilio's own max concatenated length
const MESSAGE_SID_SHAPE = /^(SM|MM)[a-zA-Z0-9]{32}$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const NUL_CHAR = /\u0000/g;

/** Length-checked constant-time byte compare (node:crypto timingSafeEqual). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify Twilio's X-Twilio-Signature (spec §4.2):
 *   signature = base64( HMAC-SHA1( AuthToken, url + concat(sortedKey + value) ) )
 * where `url` is the FULL public URL Twilio was CONFIGURED to call (a stored
 * constant, NOT reconstructed from Host/X-Forwarded-Host — a header-derived URL
 * is attacker-influenceable). Constant-time compare; never `===`.
 */
export function verifyTwilioSignature(input: {
  url: string;
  params: Array<[string, string]>;
  signature: string | null | undefined;
  authToken: string;
}): boolean {
  if (!input.signature) return false;
  const sorted = [...input.params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const data = input.url + sorted.map(([key, value]) => key + value).join("");
  const expected = createHmac("sha1", input.authToken).update(data, "utf8").digest("base64");
  return constantTimeEqual(input.signature, expected);
}

// --- Field hardening (every field hostile) ---

/** Strip CR/LF and other control chars from single-line fields before storage. */
function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

function capBody(value: string): string {
  // Body may legitimately contain newlines; strip only NUL and cap the length
  // (over-cap → truncate + keep, never error-drop).
  const cleaned = value.replace(NUL_CHAR, "");
  return cleaned.length > MAX_BODY_LENGTH ? cleaned.slice(0, MAX_BODY_LENGTH) : cleaned;
}

function safeSid(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().slice(0, 64);
  return MESSAGE_SID_SHAPE.test(trimmed) ? trimmed : null;
}

async function matchedClientsForNumber(e164: string): Promise<Array<typeof clients.$inferSelect>> {
  // clients.phone is free-text and NOT unique — several clients (couples, family
  // contacts) can share a number. Match ALL clients whose normalized phone equals
  // the inbound From (plural), never a singular "find the client". Normalize in JS
  // because the stored phone is un-normalized.
  const candidates = await db.query.clients.findMany({ where: isNotNull(clients.phone) });
  return candidates.filter((client) => toE164(client.phone) === e164);
}

async function firstProjectForClients(clientIds: string[]): Promise<string | null> {
  for (const clientId of clientIds) {
    const participant = await db.query.projectParticipants.findFirst({
      where: eq(projectParticipants.clientId, clientId),
    });
    if (participant) return participant.projectId;
  }
  return null;
}

async function insertInboundCommIfNew(input: {
  projectId: string;
  clientId: string | null;
  body: string;
  messageSid: string | null;
  deliveryStatus: string;
}): Promise<void> {
  // Dedupe on the attacker-chosen MessageSid: a replayed callback is an idempotent
  // no-op. INSERT-only, never UPDATE recipient/body from inbound.
  if (input.messageSid) {
    const existing = await db.query.projectCommunications.findFirst({
      where: eq(projectCommunications.providerMessageId, input.messageSid),
    });
    if (existing) return;
  }
  const now = new Date().toISOString();
  await db.insert(projectCommunications).values({
    id: crypto.randomUUID(),
    projectId: input.projectId,
    clientId: input.clientId,
    direction: "inbound",
    channel: "sms",
    status: "archived",
    subject: null,
    body: input.body,
    recipientName: null,
    recipientEmail: null,
    scheduledFor: null,
    sentAt: null,
    sourceType: null,
    sourceId: null,
    createdBy: "system",
    providerMessageId: input.messageSid,
    deliveryStatus: input.deliveryStatus,
    createdAt: now,
    updatedAt: now,
  });
}

export type InboundSmsResult = { action: "stop" | "start" | "help" | "message" };

/**
 * Handle a signature-verified inbound SMS. Its only write authority is: consent
 * state (clients columns + sms_suppressions) + comm/activity logging. It can
 * never create projects/clients, move money, or send anything.
 */
export async function handleInboundSms(input: {
  from: string;
  body: string;
  messageSid: string | null;
}): Promise<InboundSmsResult> {
  const normalizedFrom = toE164(stripControlChars(input.from ?? ""));
  const rawBody = capBody(input.body ?? "");
  const keyword = rawBody.trim().toUpperCase();
  const messageSid = safeSid(input.messageSid);
  const now = new Date().toISOString();
  const fromLabel = normalizedFrom ? maskNumber(normalizedFrom) : "unnormalizable";

  if (STOP_KEYWORDS.has(keyword)) {
    // 1. Number-level suppression (authoritative) — for EVERY STOP that
    //    normalizes, matched or unmatched. Earliest STOP wins (ON CONFLICT DO
    //    NOTHING). If From is unnormalizable, no suppression row can be keyed, so
    //    visibility (below) is the safety net.
    if (normalizedFrom) {
      await db
        .insert(smsSuppressions)
        .values({ phoneE164: normalizedFrom, stoppedAt: now, note: `STOP from ${fromLabel}` })
        .onConflictDoNothing();
    }

    // 2. Mirror onto every matched client (plural).
    const matched = normalizedFrom ? await matchedClientsForNumber(normalizedFrom) : [];
    for (const client of matched) {
      await db
        .update(clients)
        .set({
          smsOptIn: false,
          smsOptOutAt: now,
          smsConsentSource: "inbound_stop",
          smsLastConsentNote: `STOP via ${fromLabel}`,
          updatedAt: now,
        })
        .where(eq(clients.id, client.id));
      await logActivity({
        clientId: client.id,
        action: "client.sms.opted_out",
        actorType: "system",
        actorName: "Twilio inbound",
        metadata: { from: fromLabel },
      });
    }

    // 3. Always surface a Tyler-visible record. When a matched client has a
    //    project we log an inbound comm row on it; an UNMATCHED or
    //    UNNORMALIZABLE STOP has no project (project_communications.project_id is
    //    NOT NULL), so its Tyler-visible surface is a dedicated activity_logs row
    //    — never a silent audit note.
    const projectId = await firstProjectForClients(matched.map((client) => client.id));
    if (projectId) {
      await insertInboundCommIfNew({
        projectId,
        clientId: matched[0]?.id ?? null,
        body: rawBody,
        messageSid,
        deliveryStatus: "received",
      });
    }
    await logActivity({
      projectId: projectId ?? undefined,
      clientId: matched[0]?.id,
      action: matched.length
        ? "client.sms.inbound_stop"
        : normalizedFrom
          ? "client.sms.unmatched_stop"
          : "client.sms.unnormalizable_stop",
      actorType: "system",
      actorName: "Twilio inbound",
      metadata: { from: fromLabel, keyword, matchedClients: matched.length },
    });
    return { action: "stop" };
  }

  if (START_KEYWORDS.has(keyword)) {
    // Only re-enable the number the client themselves texted from.
    if (normalizedFrom) {
      await db.delete(smsSuppressions).where(eq(smsSuppressions.phoneE164, normalizedFrom));
    }
    const matched = normalizedFrom ? await matchedClientsForNumber(normalizedFrom) : [];
    for (const client of matched) {
      // A START from a matched client is a fresh, consumer-initiated consent event
      // (they texted us first) — TCPA-defensible; the activity row is the proof.
      await db
        .update(clients)
        .set({
          smsOptIn: true,
          smsConsentAt: now,
          smsConsentSource: "inbound_start",
          smsOptOutAt: null,
          smsLastConsentNote: `START via ${fromLabel}`,
          updatedAt: now,
        })
        .where(eq(clients.id, client.id));
      await logActivity({
        clientId: client.id,
        action: "client.sms.opted_in",
        actorType: "system",
        actorName: "Twilio inbound",
        metadata: { from: fromLabel, source: "inbound_start" },
      });
    }
    const projectId = await firstProjectForClients(matched.map((client) => client.id));
    await logActivity({
      projectId: projectId ?? undefined,
      clientId: matched[0]?.id,
      action: matched.length ? "client.sms.inbound_start" : "client.sms.unmatched_start",
      actorType: "system",
      actorName: "Twilio inbound",
      metadata: { from: fromLabel, matchedClients: matched.length },
    });
    return { action: "start" };
  }

  if (HELP_KEYWORDS.has(keyword)) {
    // HELP is answered PROVIDER-side (Twilio Advanced Opt-Out). We only log the
    // event — our code never composes a reply, preserving "no auto-send".
    await logActivity({
      action: "client.sms.help_requested",
      actorType: "system",
      actorName: "Twilio inbound",
      metadata: { from: fromLabel },
    });
    return { action: "help" };
  }

  // Non-keyword inbound message: log it (best-effort client match), never discard,
  // never auto-reply.
  const matched = normalizedFrom ? await matchedClientsForNumber(normalizedFrom) : [];
  const projectId = await firstProjectForClients(matched.map((client) => client.id));
  if (projectId) {
    await insertInboundCommIfNew({
      projectId,
      clientId: matched[0]?.id ?? null,
      body: rawBody,
      messageSid,
      deliveryStatus: "received",
    });
  }
  await logActivity({
    projectId: projectId ?? undefined,
    clientId: matched[0]?.id,
    action: "client.sms.inbound_message",
    actorType: "system",
    actorName: "Twilio inbound",
    metadata: { from: fromLabel, matchedClients: matched.length, hasProject: Boolean(projectId) },
  });
  return { action: "message" };
}

export type StatusCallbackResult = { updated: boolean; reason?: "unknown_sid" | "bad_status" | "bad_sid" };

/**
 * Handle a signature-verified delivery-status callback. The ONLY allowed inbound
 * update: advance deliveryStatus on a row we already own, keyed by our stored
 * providerMessageId. A callback referencing an unknown SID is logged + ignored,
 * never used to create or mutate a canonical row.
 */
export async function handleStatusCallback(input: {
  messageSid: string | null;
  messageStatus: string | null;
}): Promise<StatusCallbackResult> {
  const messageSid = safeSid(input.messageSid);
  if (!messageSid) return { updated: false, reason: "bad_sid" };

  const status = (input.messageStatus ?? "").trim().toLowerCase();
  if (!MESSAGE_STATUS_ALLOWLIST.has(status)) return { updated: false, reason: "bad_status" };

  const row = await db.query.projectCommunications.findFirst({
    where: eq(projectCommunications.providerMessageId, messageSid),
  });
  if (!row) {
    await logActivity({
      action: "project.communication.sms_status_unknown_sid",
      actorType: "system",
      actorName: "Twilio status",
      metadata: { messageSid, status },
    });
    return { updated: false, reason: "unknown_sid" };
  }

  await db
    .update(projectCommunications)
    .set({ deliveryStatus: status, updatedAt: new Date().toISOString() })
    .where(and(eq(projectCommunications.id, row.id), eq(projectCommunications.providerMessageId, messageSid)));
  return { updated: true };
}

export { stripControlChars };
