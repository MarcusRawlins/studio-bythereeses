import { db } from "@/db/client";
import { clients, projectCommunications, projectParticipants, projects } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import {
  extractAttachmentMetadata,
  extractPlainTextFromRaw,
  MAX_ADDRESS_LENGTH,
  MAX_BODY_TEXT_LENGTH,
  MAX_MESSAGE_ID_LENGTH,
  MAX_SUBJECT_LENGTH,
  parseAuthResults,
  parseNameAndEmail,
  sanitizeBody,
  sanitizeLine,
  stripHtmlToText,
  type InboundEmailPayload,
} from "@/lib/inbound-inquiry";
import { verifyProjectReplyToken } from "@/lib/project-reply-token";
import { and, eq, gte } from "drizzle-orm";

// =============================================================================
// Phase 14 — inbound client email → EXISTING project thread.
//
// THE CORE INVARIANT (B1): attaching a valid reply token grants EXACTLY ONE
// capability — appending an INBOUND message row to that ONE project's thread. No
// canonical mutation, no send, no agent tool, no cross-project reach. This module
// has ZERO access to canonical-write functions; a fully-successful prompt
// injection in the body can at most write the one comm row + one activity row.
//
// Authority to attach comes SOLELY from a valid signed reply token read off the
// SMTP ENVELOPE recipient (never the spoofable To/Reply-To headers). SPF/DKIM/
// DMARC and `From` are DISPLAY-ONLY (a token holder can spoof From). No valid
// token ⇒ non-attach ⇒ the endpoint answers non-2xx ⇒ the Worker forwards to a
// human (never a silent drop, never an auto-attach on a weak From signal).
// =============================================================================

// Rate / volume guard (spec §2.3 step 4). The global + per-domain caps alone do
// NOT bound a single stolen token: a token holder rotating sender domains stays
// under the per-domain cap and floods ONE thread until the global cap trips
// (which also chokes legitimate intake). The per-projectId cap is what actually
// bounds a stolen token. Over ANY cap → non-attach → forward (throughput cost).
export const PROJECT_EMAIL_GLOBAL_HOURLY_CAP = 200;
export const PROJECT_EMAIL_DOMAIN_HOURLY_CAP = 25;
export const PROJECT_EMAIL_PROJECT_HOURLY_CAP = 25;

export const INBOUND_PROJECT_EMAIL_SOURCE_TYPE = "inbound_project_email";

// Anchored, CASE-SENSITIVE local-part match (base64url is case-significant — do
// NOT lowercase it). Only the two 22-char base64url parts of a project-reply
// token qualify; anything else is a non-match → non-attach → forward.
const REPLY_LOCAL_PART_PATTERN = /^reply\+([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;

export type IngestProjectEmailResult =
  | { attached: true; id: string; projectId: string; deduped: boolean }
  | {
      attached: false;
      reason: "no_token" | "invalid_token" | "unknown_project" | "rate_limited" | "flag_off";
    };

export const INBOUND_PROJECT_EMAIL_ENABLED_FLAG = "INBOUND_PROJECT_EMAIL_ENABLED";

export function isInboundProjectEmailEnabled(): boolean {
  return process.env.INBOUND_PROJECT_EMAIL_ENABLED === "true";
}

// Extract + verify the reply token from the SMTP ENVELOPE recipient ONLY. Read
// message.to (payload.envelopeTo), NEVER the To/Reply-To headers. Lowercase only
// the DOMAIN; match the local part case-sensitively. Returns the bound projectId
// or null (non-match / bad token / verify fail).
export function resolveProjectFromEnvelope(envelopeTo: string | null | undefined): string | null {
  if (!envelopeTo) return null;
  // A single, well-formed address only. Strip any display-name/angle wrapper the
  // envelope should not carry, then split on the LAST "@".
  const raw = String(envelopeTo).trim().replace(/^.*<([^>]+)>.*$/, "$1").trim();
  const at = raw.lastIndexOf("@");
  if (at === -1) return null;
  const localPart = raw.slice(0, at); // case-SIGNIFICANT — do not lowercase
  // (domain is lowercased for completeness but is not used for authority)
  const match = REPLY_LOCAL_PART_PATTERN.exec(localPart);
  if (!match) return null;
  const token = `${match[1]}.${match[2]}`;
  const verified = verifyProjectReplyToken(token);
  return verified?.projectId ?? null;
}

function domainOf(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

// Count inbound project-email rows in the trailing hour and evaluate all three
// caps (global, per-domain, per-projectId). Mirrors 8a isRateLimited but adds the
// per-projectId cap (Finding LOW 4).
async function isRateLimited(projectId: string, senderEmail: string | null, now: Date): Promise<boolean> {
  const windowStart = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const recent = await db
    .select({ projectId: projectCommunications.projectId, recipientEmail: projectCommunications.recipientEmail })
    .from(projectCommunications)
    .where(
      and(
        eq(projectCommunications.sourceType, INBOUND_PROJECT_EMAIL_SOURCE_TYPE),
        eq(projectCommunications.direction, "inbound"),
        gte(projectCommunications.createdAt, windowStart),
      ),
    )
    .limit(PROJECT_EMAIL_GLOBAL_HOURLY_CAP + 1);

  if (recent.length >= PROJECT_EMAIL_GLOBAL_HOURLY_CAP) return true;

  const perProject = recent.filter((row) => row.projectId === projectId).length;
  if (perProject >= PROJECT_EMAIL_PROJECT_HOURLY_CAP) return true;

  const domain = domainOf(senderEmail);
  if (domain) {
    const perDomain = recent.filter((row) => domainOf(row.recipientEmail) === domain).length;
    if (perDomain >= PROJECT_EMAIL_DOMAIN_HOURLY_CAP) return true;
  }
  return false;
}

/**
 * Ingest a client email reply into an EXISTING project thread. The token on the
 * envelope recipient is the ONLY authority; everything else is untrusted.
 */
export async function ingestInboundProjectEmail(payload: InboundEmailPayload): Promise<IngestProjectEmailResult> {
  // 1. Strict envelope-token extraction + verify. No valid token ⇒ non-attach.
  const projectId = resolveProjectFromEnvelope(payload.envelopeTo);
  if (!projectId) {
    return { attached: false, reason: "invalid_token" };
  }

  // 2. Verify the project still exists (may be deleted). Missing ⇒ non-attach.
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) {
    return { attached: false, reason: "unknown_project" };
  }

  // 3. Sanitize EVERY field with the 8a sanitizers (never render inbound HTML —
  //    only the text projection is stored/displayed).
  // Neutralize HTML in the subject the SAME way the body is (strip tags,
  // entities, javascript:/data:) BEFORE folding to a single line — so a hostile
  // subject like `<img src=x onerror=…>` is stored display-safe regardless of
  // any current or future render/notify surface (Fable M1). sanitizeLine alone
  // strips control chars but leaves `<`/`>`/tags intact.
  const subject = sanitizeLine(
    payload.subject != null ? stripHtmlToText(payload.subject) : null,
    MAX_SUBJECT_LENGTH,
  );
  const bodyText = sanitizeBody(extractPlainTextFromRaw(payload.raw), MAX_BODY_TEXT_LENGTH);
  const messageId = sanitizeLine(payload.messageId, MAX_MESSAGE_ID_LENGTH);
  const headerFrom = sanitizeLine(payload.headerFrom, MAX_ADDRESS_LENGTH);
  const envelopeFrom = sanitizeLine(payload.envelopeFrom, MAX_ADDRESS_LENGTH);
  const { name, email } = parseNameAndEmail(headerFrom, envelopeFrom);
  const auth = parseAuthResults(payload.authResults); // DISPLAY-ONLY, never authz
  const attachments = extractAttachmentMetadata(payload.raw); // metadata only, never opened

  // Body must be trimmed non-empty (canon trigger). Attachment metadata is
  // surfaced as a compact, human-readable footer so Tyler sees one existed.
  const attachmentNote = attachments.length
    ? `[${attachments.length} attachment(s): ${attachments
        .map((a) => `${a.filename ?? "unnamed"} (${a.mimeType ?? "unknown"}, ${a.sizeBytes} bytes)`)
        .join("; ")}]`
    : null;
  const bodyBase = bodyText || "(no message body)";
  const body = attachmentNote ? `${bodyBase}\n\n${attachmentNote}` : bodyBase;

  const now = new Date();
  const nowIso = now.toISOString();

  // 5 (dedupe pre-check). A replay of the SAME Message-ID to the SAME project is
  // an idempotent no-op — return the existing row, do NOT count it against the
  // rate cap, do NOT UPDATE it. (Cross-project same Message-ID is NOT a conflict.)
  if (messageId) {
    const existing = await db.query.projectCommunications.findFirst({
      where: (row, { and: a, eq: e }) => a(e(row.projectId, projectId), e(row.inboundMessageId, messageId)),
    });
    if (existing) {
      return { attached: true, id: existing.id, projectId, deduped: true };
    }
  }

  // 4. Rate/volume guard (global + per-domain + per-projectId). Over any cap →
  //    non-attach (forward), and an audit activity row (never a canonical write).
  if (await isRateLimited(projectId, email, now)) {
    await logActivity({
      projectId,
      action: "project.communication.inbound_email_rate_limited",
      actorType: "system",
      actorName: "Inbound Project Email",
      metadata: { projectId, from: email, domain: domainOf(email) },
    });
    return { attached: false, reason: "rate_limited" };
  }

  // best-effort client match: a project participant whose email equals the From.
  let clientId: string | null = null;
  if (email) {
    const participant = await db
      .select({ id: clients.id })
      .from(projectParticipants)
      .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
      .where(and(eq(projectParticipants.projectId, projectId), eq(clients.email, email)))
      .limit(1);
    clientId = participant[0]?.id ?? null;
  }

  const id = crypto.randomUUID();
  const values = {
    id,
    projectId,
    clientId,
    direction: "inbound" as const,
    channel: "email" as const,
    status: "archived" as const, // appears in the thread; never an actionable draft
    subject,
    body,
    recipientName: name,
    recipientEmail: email,
    scheduledFor: null,
    sentAt: null,
    sourceType: INBOUND_PROJECT_EMAIL_SOURCE_TYPE,
    sourceId: null,
    createdBy: "system",
    providerMessageId: null,
    deliveryStatus: null,
    inboundMessageId: messageId,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // 5 (converge append). Dedupe scoped to the THREAD via the composite unique
  // index — replay to the same project is a no-op; the same Message-ID for a
  // DIFFERENT project appends there too (never a silent cross-project drop). NULL
  // Message-ID never conflicts (SQLite treats NULLs distinct) → always a fresh
  // append. NEVER UPDATE an existing row from inbound data.
  if (messageId) {
    await db
      .insert(projectCommunications)
      .values(values)
      .onConflictDoNothing({
        target: [projectCommunications.projectId, projectCommunications.inboundMessageId],
      });
  } else {
    await db.insert(projectCommunications).values(values);
  }

  const ours = await db.query.projectCommunications.findFirst({ where: eq(projectCommunications.id, id) });
  if (!ours) {
    // A concurrent insert won this (project, Message-ID) — idempotent replay.
    const existing = messageId
      ? await db.query.projectCommunications.findFirst({
          where: (row, { and: a, eq: e }) => a(e(row.projectId, projectId), e(row.inboundMessageId, messageId)),
        })
      : null;
    return { attached: true, id: existing?.id ?? id, projectId, deduped: true };
  }

  // 6. Auth verdicts logged as DISPLAY signals for Tyler, never used to decide.
  await logActivity({
    projectId,
    clientId,
    action: "project.communication.inbound_email_received",
    actorType: "system",
    actorName: "Inbound Project Email",
    metadata: {
      projectId,
      from: email,
      matchedClient: clientId,
      spf: auth.spf,
      dkim: auth.dkim,
      dmarc: auth.dmarc,
    },
  });

  // 7. Persist-then-2xx: return only after the row is durably written.
  return { attached: true, id, projectId, deduped: false };
}
