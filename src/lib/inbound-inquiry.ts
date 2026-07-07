import { db } from "@/db/client";
import { agentTasks, clients, inboundInquiries, projectCommunications } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { createProjectFromAgent, type AgentProjectCreateInput } from "@/lib/crm";
// Phase 24 (CR-6, §5): the canonical Resend sender lives in email.ts, co-located with the
// suppression gate (isEmailSuppressed). This closes the bypass — the intake surface used to
// reimplement the raw Resend fetch here and never checked suppression.
import { sendInquiryReplyEmail } from "@/lib/email";
import { and, desc, eq, gte, inArray } from "drizzle-orm";

// =============================================================================
// Phase 8a — Inquiry-email → triage intake.
//
// THE CORE INVARIANT (B1): the drafting step in this module has ZERO
// canonical-mutation authority. `draftFromInquiry()` is a pure parser + template
// with no LLM, no agent tools, and no access to canonical-write functions. It
// only ever produces draft columns for an `inbound_inquiries` staging row.
//
// Inbound email can therefore only ever create a review item; it can never
// mutate canonical data (projects / clients / project_sources / communications)
// or trigger a send. Those happen exclusively via the admin approval actions at
// the bottom of this file, which are gated on an admin request (invoked from the
// admin-only Studio surface), NOT reachable from the intake endpoint.
//
// Every stored field is capped; every attacker-chosen id (Message-ID, In-Reply-
// To, References) is capped; ingestion is INSERT-OR-IGNORE on Message-ID and
// NEVER updates an existing row from inbound data (B2).
// =============================================================================

// ---------------------------------------------------------------------------
// Length caps. Mirror the public scheduler/questionnaire caps so a single
// message cannot store an unbounded payload. Message-threading headers are
// attacker-controlled too and are capped explicitly (B2).
// ---------------------------------------------------------------------------
export const MAX_SUBJECT_LENGTH = 500;
export const MAX_PARSED_NAME_LENGTH = 200;
export const MAX_PARSED_EMAIL_LENGTH = 320;
export const MAX_ADDRESS_LENGTH = 320;
export const MAX_BODY_TEXT_LENGTH = 50_000;
export const MAX_MESSAGE_ID_LENGTH = 998; // RFC 5322 line limit
export const MAX_IN_REPLY_TO_LENGTH = 998;
export const MAX_REFERENCES_LENGTH = 2048;
export const MAX_AUTH_RESULTS_LENGTH = 2048;
export const MAX_VENUE_LENGTH = 200;
export const MAX_EVENT_DATE_LENGTH = 40;
// Endpoint-level hard JSON cap (defense in depth if the Worker is bypassed).
export const MAX_INBOUND_JSON_BYTES = 2_000_000; // ~2 MB
// Worker raw-body cap (documented for the Worker; enforced there too).
export const MAX_RAW_BYTES = 2_000_000;

// Rate / volume guard: over-cap inquiries still store, but auto-mark spam so a
// flood cannot generate an unbounded actionable queue or agent-task fan-out.
export const GLOBAL_HOURLY_INSERT_CAP = 200;
export const DOMAIN_HOURLY_INSERT_CAP = 25;

export type InboundEmailPayload = {
  envelopeFrom?: string | null;
  envelopeTo?: string | null;
  headerFrom?: string | null;
  subject?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  authResults?: string | null;
  rawSize?: number | null;
  raw?: string | null;
  receivedAt?: string | null;
};

export type IngestInboundInquiryResult = {
  id: string;
  status: string;
  deduped: boolean;
};

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

// Strip CR/LF and other control characters from any single-line field before
// storage, then trim + cap. Control-char stripping also neutralizes header /
// CRLF smuggling if a stored value is ever interpolated elsewhere.
export function sanitizeLine(value: string | null | undefined, cap: number): string | null {
  if (value == null) return null;
  const cleaned = String(value)
    // Also fold Unicode line breaks NEL (U+0085), LS (U+2028), PS (U+2029) to a
    // space so they can never masquerade as a benign single-line value.
    .replace(/[\r\n\t\u0085\u2028\u2029]+/g, " ")
    // Strip C0 + DEL + C1 (U+0080–U+009F) control characters.
    .replace(/[\x00-\x1F\x7F\u0080-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, cap);
}

// Multi-line body: preserve line breaks but strip other control chars, cap.
export function sanitizeBody(value: string | null | undefined, cap: number): string | null {
  if (value == null) return null;
  const cleaned = String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, cap);
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&[a-zA-Z]+;|&#39;|&apos;/g, (entity) => HTML_ENTITIES[entity] ?? entity);
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

// Strip an HTML body to plain text server-side. NEVER render inbound HTML in the
// admin UI — only this text-only projection is stored/displayed. Removes
// script/style blocks entirely (with their contents), then all tags, event
// handlers, and javascript:/data: URIs, decodes entities, and collapses
// whitespace.
export function stripHtmlToText(html: string): string {
  let text = String(html);
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ");
  text = text.replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ");
  // Any lingering unterminated script/style opener → drop the rest defensively.
  text = text.replace(/<script\b[\s\S]*$/gi, " ");
  text = text.replace(/<style\b[\s\S]*$/gi, " ");
  text = text.replace(/<(?:br|BR)\s*\/?>/g, "\n");
  text = text.replace(/<\/(?:p|div|h[1-6]|li|tr)\s*>/gi, "\n");
  text = text.replace(/<[^>]*>/g, " ");
  text = decodeEntities(text);
  // Neutralize any decoded dangerous URI schemes so they can never be rendered
  // as active content even if a future surface mishandles the text.
  text = text.replace(/javascript:/gi, "").replace(/data:/gi, "");
  return text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// MIME parsing (dependency-free, best-effort). Prefer text/plain; fall back to
// stripping the first text/html part. This is deliberately conservative: a
// parse miss yields an empty body, never a throw.
// ---------------------------------------------------------------------------
export function extractPlainTextFromRaw(raw: string | null | undefined): string {
  if (!raw) return "";
  const source = String(raw);

  // Multipart: split on the declared boundary and pick the best text part.
  const boundaryMatch = source.match(/boundary="?([^"\r\n;]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = source.split(new RegExp(`--${escapeRegExp(boundary)}(?:--)?`));
    let htmlFallback = "";
    for (const part of parts) {
      const split = splitHeadersAndBody(part);
      if (!split) continue;
      const { headers, body } = split;
      const contentType = (headers.match(/content-type:\s*([^\r\n;]+)/i)?.[1] ?? "").toLowerCase().trim();
      const decoded = decodeTransfer(body, headers);
      if (contentType === "text/plain") {
        const cleaned = decoded.trim();
        if (cleaned) return cleaned;
      } else if (contentType === "text/html" && !htmlFallback) {
        htmlFallback = stripHtmlToText(decoded);
      }
    }
    if (htmlFallback) return htmlFallback;
  }

  // Single-part message: separate headers from the body.
  const split = splitHeadersAndBody(source);
  if (split) {
    const contentType = (split.headers.match(/content-type:\s*([^\r\n;]+)/i)?.[1] ?? "").toLowerCase().trim();
    const decoded = decodeTransfer(split.body, split.headers);
    if (contentType === "text/html") return stripHtmlToText(decoded);
    return decoded.trim();
  }
  return source.trim();
}

function splitHeadersAndBody(part: string): { headers: string; body: string } | null {
  const idx = part.search(/\r?\n\r?\n/);
  if (idx === -1) return null;
  const sepMatch = part.slice(idx).match(/^\r?\n\r?\n/);
  const sepLen = sepMatch ? sepMatch[0].length : 2;
  return { headers: part.slice(0, idx), body: part.slice(idx + sepLen) };
}

function decodeTransfer(body: string, headers: string): string {
  const encoding = (headers.match(/content-transfer-encoding:\s*([^\r\n;]+)/i)?.[1] ?? "").toLowerCase().trim();
  if (encoding === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)));
  }
  if (encoding === "base64") {
    try {
      return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return body;
    }
  }
  return body;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Attachment metadata (spec §3.5). Slice A does NOT parse, store, or preview
// attachments — the body is dropped — but we DO record best-effort metadata
// (filename / declared MIME / approximate size) so Tyler at least sees that an
// attachment existed. The declared MIME is NEVER trusted; nothing is opened.
export type AttachmentMeta = { filename: string | null; mimeType: string | null; sizeBytes: number };

const MAX_ATTACHMENTS_RECORDED = 20;
const MAX_ATTACHMENT_FIELD_LENGTH = 255;

export function extractAttachmentMetadata(raw: string | null | undefined): AttachmentMeta[] {
  if (!raw) return [];
  const source = String(raw);
  const boundaryMatch = source.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!boundaryMatch) return [];
  const boundary = boundaryMatch[1];
  const parts = source.split(new RegExp(`--${escapeRegExp(boundary)}(?:--)?`));
  const attachments: AttachmentMeta[] = [];
  for (const part of parts) {
    if (attachments.length >= MAX_ATTACHMENTS_RECORDED) break;
    const split = splitHeadersAndBody(part);
    if (!split) continue;
    const { headers, body } = split;
    const disposition = (headers.match(/content-disposition:\s*([^\r\n]+)/i)?.[1] ?? "").toLowerCase();
    const contentType = (headers.match(/content-type:\s*([^\r\n;]+)/i)?.[1] ?? "").toLowerCase().trim();
    const filenameMatch = headers.match(/(?:filename|name)\s*=\s*"?([^"\r\n;]+)"?/i);
    const looksInline = /^text\/(plain|html)$/.test(contentType) || contentType.startsWith("multipart/");
    const isAttachment = disposition.includes("attachment") || (!!filenameMatch && !looksInline);
    if (!isAttachment) continue;

    const encoding = (headers.match(/content-transfer-encoding:\s*([^\r\n;]+)/i)?.[1] ?? "").toLowerCase().trim();
    const trimmedBody = body.replace(/\s+$/, "");
    const sizeBytes = encoding === "base64"
      ? Math.max(0, Math.floor(trimmedBody.replace(/\s+/g, "").length * 3 / 4))
      : trimmedBody.length;
    attachments.push({
      filename: sanitizeLine(filenameMatch?.[1] ?? null, MAX_ATTACHMENT_FIELD_LENGTH),
      mimeType: sanitizeLine(contentType || null, MAX_ATTACHMENT_FIELD_LENGTH),
      sizeBytes,
    });
  }
  return attachments;
}

// ---------------------------------------------------------------------------
// Auth-results parsing. Parse ONLY the value Cloudflare prepended (passed in
// `payload.authResults` — the topmost result from the routing hop). We NEVER
// scan the raw MIME for `Authentication-Results`, because that header is also
// attacker-supplied in the body. Verdicts are DISPLAY-ONLY trust signals, never
// an authz decision.
//
// Hardening: an attacker can add their OWN `Authentication-Results` header to
// the message; `headers.get()` joins multiple header instances with ", ". So we
// (1) require the authserv-id (the token before the first ";") to be
// Cloudflare's, else return no verdicts, and (2) truncate at the first
// joined-header boundary so a spoofed second AR value can't inject a verdict key
// Cloudflare omitted. Fail-safe: an unrecognized authserv-id yields all-null
// (treated as "unverified"), never an attacker-chosen verdict.
// ---------------------------------------------------------------------------
export type AuthVerdicts = { spf: string | null; dkim: string | null; dmarc: string | null };

// Cloudflare Email Routing prepends its Authentication-Results with an
// authserv-id on its own mail hosts (e.g. `mx.cloudflare.net`). Match the
// cloudflare-owned authserv-id so an attacker-chosen id is not trusted.
const CLOUDFLARE_AUTHSERV_PATTERN = /cloudflare/i;

export function parseAuthResults(authResults: string | null | undefined): AuthVerdicts {
  const none: AuthVerdicts = { spf: null, dkim: null, dmarc: null };
  let value = sanitizeLine(authResults, MAX_AUTH_RESULTS_LENGTH) ?? "";
  if (!value) return none;

  // authserv-id = the token before the first ";".
  const firstSemi = value.indexOf(";");
  const authservId = (firstSemi === -1 ? value : value.slice(0, firstSemi)).trim();
  if (!CLOUDFLARE_AUTHSERV_PATTERN.test(authservId)) return none;

  // Truncate at the first joined-header boundary: ", " that begins a new
  // authserv-id segment (`token;`). Anything past that is a second (attacker)
  // header instance joined by headers.get() and must be discarded.
  const boundary = value.slice(firstSemi + 1).search(/, +[^;,]+;/);
  if (boundary !== -1) {
    value = value.slice(0, firstSemi + 1 + boundary);
  }

  const pick = (key: string) => {
    const match = value.match(new RegExp(`\\b${key}=([a-zA-Z]+)`, "i"));
    return match ? match[1].toLowerCase() : null;
  };
  return { spf: pick("spf"), dkim: pick("dkim"), dmarc: pick("dmarc") };
}

// ---------------------------------------------------------------------------
// Best-effort, low-trust parsers for the draft. A mis-parse can only ever
// produce a wrong DRAFT (a table column), never a wrong canonical record.
// ---------------------------------------------------------------------------
export function parseNameAndEmail(headerFrom: string | null, envelopeFrom: string | null): { name: string | null; email: string | null } {
  const candidates = [headerFrom, envelopeFrom];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const angle = candidate.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (angle) {
      const name = sanitizeLine(angle[1], MAX_PARSED_NAME_LENGTH);
      const email = normalizeEmail(angle[2]);
      if (email) return { name: name || null, email };
    }
    const bare = normalizeEmail(candidate);
    if (bare) return { name: null, email: bare };
  }
  return { name: null, email: null };
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const cleaned = sanitizeLine(value, MAX_PARSED_EMAIL_LENGTH);
  if (!cleaned) return null;
  const email = cleaned.replace(/^mailto:/i, "").trim().toLowerCase();
  // Single well-formed address only — no comma-separated lists, no display name.
  if (!/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(email)) return null;
  if (email.length > MAX_PARSED_EMAIL_LENGTH) return null;
  return email;
}

export function parseEventDate(body: string | null): string | null {
  if (!body) return null;
  const iso = body.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  if (iso) return iso[0];
  const months = "january|february|march|april|may|june|july|august|september|october|november|december";
  const monthDay = body.match(new RegExp(`\\b(${months})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, "i"));
  if (monthDay) return sanitizeLine(monthDay[0], MAX_EVENT_DATE_LENGTH);
  const slash = body.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\b/);
  if (slash) return slash[0];
  return null;
}

export function parseVenue(body: string | null): string | null {
  if (!body) return null;
  const labelled = body.match(/\bvenue\s*(?:is|:|-)?\s*([^\n.,;]{2,120})/i);
  if (labelled) return sanitizeLine(labelled[1], MAX_VENUE_LENGTH);
  const atThe = body.match(/\bat\s+(the\s+[A-Z][\w'&-]*(?:\s+[A-Z][\w'&-]*){0,4})/);
  if (atThe) return sanitizeLine(atThe[1], MAX_VENUE_LENGTH);
  return null;
}

// ---------------------------------------------------------------------------
// THE DRAFT STEP (B1). Deterministic. No LLM, no tools, no canonical mutation.
// Produces only draft columns. This function literally cannot write a canonical
// row — that is what makes "a mis-parse (or a fully-successful prompt injection)
// can never produce a wrong canonical record" trivially true.
// ---------------------------------------------------------------------------
export type InquiryDraft = {
  proposedProject: AgentProjectCreateInput;
  draftReplySubject: string;
  draftReplyBody: string;
};

export function draftFromInquiry(inquiry: {
  id: string;
  subject: string | null;
  bodyText: string | null;
  parsedName: string | null;
  parsedEmail: string | null;
  parsedEventDate: string | null;
  parsedVenue: string | null;
}): InquiryDraft {
  const name = inquiry.parsedName?.trim() || null;
  const [firstName, ...rest] = (name ?? "").split(/\s+/).filter(Boolean);
  const projectLabel = name ? `${name} — Wedding Inquiry` : "Wedding Inquiry";

  const proposedProject: AgentProjectCreateInput = {
    name: projectLabel.slice(0, 200),
    type: "wedding",
    stage: "inquiry",
    status: "active",
    eventDate: inquiry.parsedEventDate,
    venueName: inquiry.parsedVenue,
    primaryClient: {
      firstName: firstName ?? name ?? null,
      lastName: rest.length ? rest.join(" ") : null,
      email: inquiry.parsedEmail,
      role: "primary",
    },
    intakeSource: {
      kind: "inquiry",
      title: (inquiry.subject ?? "Inbound inquiry").slice(0, 200),
      body: inquiry.bodyText ?? "(no body)",
      capturedBy: "Inbound Inquiry Intake",
      sourceType: "inbound_inquiry",
      sourceId: inquiry.id,
    },
  };

  const greetingName = firstName || "there";
  const draftReplySubject = `Re: ${inquiry.subject ?? "Your inquiry"}`.slice(0, MAX_SUBJECT_LENGTH);
  const draftReplyBody = [
    `Hi ${greetingName},`,
    "",
    "Thank you so much for reaching out to The Reeses — we'd love to hear more about",
    "your day. We'll review the details you shared and follow up with availability and",
    "next steps shortly.",
    "",
    "Warmly,",
    "The Reeses Studio",
  ].join("\n");

  return { proposedProject, draftReplySubject, draftReplyBody };
}

// CRLF-strip the machine-generated reply subject at SEND time (N6). Even though
// the draft is templated, it could carry CR/LF if it ever interpolated parsed
// inbound text. A subject becomes an email header at Resend, so a stray newline
// is a header-injection vector. Strip, then reject if a newline somehow remains.
export function stripReplySubjectForSend(subject: string): string {
  const stripped = String(subject)
    // Fold CR/LF plus the Unicode line breaks NEL/LS/PS to a space.
    .replace(/[\r\n\u0085\u2028\u2029]+/g, " ")
    // Strip C0 + DEL + C1 control characters.
    .replace(/[\x00-\x1F\x7F\u0080-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/[\r\n\u0085\u2028\u2029]/.test(stripped)) {
    throw new Error("Reply subject contains a newline after sanitization.");
  }
  return stripped.slice(0, MAX_SUBJECT_LENGTH);
}

// ---------------------------------------------------------------------------
// Ingestion. INSERT-OR-IGNORE on message_id, never UPDATE from inbound (B2).
// ---------------------------------------------------------------------------
function domainOf(address: string | null): string | null {
  if (!address) return null;
  const email = normalizeEmail(address) ?? address.toLowerCase();
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = email.slice(at + 1).replace(/[>\s].*$/, "").trim();
  return domain || null;
}

function extractMessageIdTokens(value: string | null): string[] {
  if (!value) return [];
  const tokens = value.match(/<[^>\s]+>/g);
  if (tokens) return tokens.map((token) => token.trim());
  const single = value.trim();
  return single ? [single] : [];
}

async function isRateLimited(envelopeFrom: string | null, now: Date): Promise<boolean> {
  const windowStart = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const recent = await db.query.inboundInquiries.findMany({
    where: gte(inboundInquiries.receivedAt, windowStart),
    columns: { envelopeFrom: true },
    limit: GLOBAL_HOURLY_INSERT_CAP + 1,
  });
  if (recent.length >= GLOBAL_HOURLY_INSERT_CAP) return true;
  const domain = domainOf(envelopeFrom);
  if (!domain) return false;
  const perDomain = recent.filter((row) => domainOf(row.envelopeFrom) === domain).length;
  return perDomain >= DOMAIN_HOURLY_INSERT_CAP;
}

export async function ingestInboundInquiry(payload: InboundEmailPayload): Promise<IngestInboundInquiryResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  const receivedAt = sanitizeLine(payload.receivedAt, 40) ?? nowIso;

  const messageId = sanitizeLine(payload.messageId, MAX_MESSAGE_ID_LENGTH);
  const inReplyTo = sanitizeLine(payload.inReplyTo, MAX_IN_REPLY_TO_LENGTH);
  const referencesHeader = sanitizeLine(payload.references, MAX_REFERENCES_LENGTH);
  const envelopeFrom = sanitizeLine(payload.envelopeFrom, MAX_ADDRESS_LENGTH);
  const headerFrom = sanitizeLine(payload.headerFrom, MAX_ADDRESS_LENGTH);
  const toAddress = sanitizeLine(payload.envelopeTo, MAX_ADDRESS_LENGTH);
  const subject = sanitizeLine(payload.subject, MAX_SUBJECT_LENGTH);
  const bodyText = sanitizeBody(extractPlainTextFromRaw(payload.raw), MAX_BODY_TEXT_LENGTH);
  const auth = parseAuthResults(payload.authResults);
  const { name: parsedName, email: parsedEmail } = parseNameAndEmail(headerFrom, envelopeFrom);
  const parsedEventDate = parseEventDate(bodyText);
  const parsedVenue = parseVenue(bodyText);
  const attachments = extractAttachmentMetadata(payload.raw);

  const id = crypto.randomUUID();
  const baseValues = {
    id,
    status: "new",
    messageId,
    inReplyTo,
    referencesHeader,
    envelopeFrom,
    headerFrom,
    toAddress,
    subject,
    bodyText,
    spfResult: auth.spf,
    dkimResult: auth.dkim,
    dmarcResult: auth.dmarc,
    parsedName,
    parsedEmail,
    parsedEventDate,
    parsedVenue,
    parsedJson: JSON.stringify({ attachments }),
    receivedAt,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // INSERT-OR-IGNORE. A duplicate message_id is a no-op; a NULL message_id never
  // conflicts (SQLite treats NULLs as distinct) so it is always a fresh row.
  if (messageId) {
    await db.insert(inboundInquiries).values(baseValues).onConflictDoNothing({ target: inboundInquiries.messageId });
  } else {
    await db.insert(inboundInquiries).values(baseValues);
  }

  // Did our row win, or did an existing one already hold this message_id?
  const ours = await db.query.inboundInquiries.findFirst({ where: eq(inboundInquiries.id, id) });
  if (!ours) {
    const existing = messageId
      ? await db.query.inboundInquiries.findFirst({ where: eq(inboundInquiries.messageId, messageId) })
      : null;
    // Idempotent replay: return the existing id, no second row, no second task,
    // and CRITICALLY no UPDATE of the existing (possibly-about-to-be-approved) row.
    return { id: existing?.id ?? id, status: existing?.status ?? "new", deduped: true };
  }

  // ---- everything below only ever writes THIS row's own draft columns ----

  const parsedJson: Record<string, unknown> = { attachments };

  // Rate / volume guard: over-cap → mark spam (retained + auditable, not surfaced
  // as actionable), and never raise an agent task.
  if (await isRateLimited(envelopeFrom, now)) {
    parsedJson.spamReason = "rate_limited";
    await db.update(inboundInquiries)
      .set({ status: "spam", parsedJson: JSON.stringify(parsedJson), updatedAt: new Date().toISOString() })
      .where(eq(inboundInquiries.id, id));
    return { id, status: "spam", deduped: false };
  }

  // Soft-duplicate signal (read-only): surface a possible existing client so
  // Tyler links instead of creating a duplicate. No auto-link, no write.
  if (parsedEmail) {
    const existingClient = await db.query.clients.findFirst({ where: eq(clients.email, parsedEmail) });
    if (existingClient) parsedJson.possibleExistingClientId = existingClient.id;
  }

  // Reply-chain guard: if this message replies to one we already ingested, mark
  // it and do NOT raise a fresh proposal/task (avoids a thread spawning multiple
  // projects). Full thread→project matching is slice B.
  const referencedIds = [...extractMessageIdTokens(inReplyTo), ...extractMessageIdTokens(referencesHeader)];
  if (referencedIds.length) {
    const priorThreadRow = await db.query.inboundInquiries.findFirst({
      where: and(inArray(inboundInquiries.messageId, referencedIds)),
    });
    if (priorThreadRow) {
      parsedJson.threadReply = true;
      parsedJson.threadRootInquiryId = priorThreadRow.id;
      await db.update(inboundInquiries)
        .set({ status: "new", parsedJson: JSON.stringify(parsedJson), updatedAt: new Date().toISOString() })
        .where(eq(inboundInquiries.id, id));
      return { id, status: "new", deduped: false };
    }
  }

  // Deterministic draft (B1 — no canonical-mutation authority).
  const draft = draftFromInquiry({
    id,
    subject,
    bodyText,
    parsedName,
    parsedEmail,
    parsedEventDate,
    parsedVenue,
  });

  // Authority-less review task, purely to surface the item in the Inbox. It is
  // marked inquiry-sourced and carries NO canonical-mutation authority.
  const taskId = crypto.randomUUID();
  await db.insert(agentTasks).values({
    id: taskId,
    title: `Review inquiry: ${subject ?? "(no subject)"}`.slice(0, 200),
    instructions: "Inbound inquiry email awaiting Tyler review. Draft only — approve to create a canonical project or send a reply.",
    status: "queued",
    priority: "normal",
    requestedBy: "inbound_inquiry_intake",
    assignedAgent: "Intake Agent",
    sourceType: "inbound_inquiry",
    sourceId: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await db.update(inboundInquiries)
    .set({
      status: "proposed",
      proposedProjectJson: JSON.stringify(draft.proposedProject),
      draftReplySubject: draft.draftReplySubject,
      draftReplyBody: draft.draftReplyBody,
      parsedJson: JSON.stringify(parsedJson),
      agentTaskId: taskId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(inboundInquiries.id, id));

  return { id, status: "proposed", deduped: false };
}

// ---------------------------------------------------------------------------
// Admin approval actions (the ONLY place a canonical project is created or a
// reply is sent from an inquiry). These are gated on an admin request — they are
// invoked from the admin-only Studio surface (proxy-terminated admin session /
// admin proof), NEVER from the intake endpoint or the drafter. The intake
// endpoint, Worker, and draft step have no path to these functions.
//
// Slice A ships these as the sanctioned approval touchpoints; the full admin UI
// wiring is described in the spec (§6) and out of scope to build here.
// ---------------------------------------------------------------------------

export type AdminActor = { actorName: string };

async function loadInquiryForApproval(inquiryId: string) {
  const inquiry = await db.query.inboundInquiries.findFirst({ where: eq(inboundInquiries.id, inquiryId) });
  if (!inquiry) throw new Error("Inquiry not found.");
  return inquiry;
}

// Approve project creation → the existing canonical studio_create_project path.
// This is the only place an inquiry becomes a canonical project.
export async function approveInquiryProjectCreation(
  inquiryId: string,
  admin: AdminActor,
  overrides?: Partial<AgentProjectCreateInput>,
) {
  const inquiry = await loadInquiryForApproval(inquiryId);
  if (inquiry.status === "approved" && inquiry.projectId) {
    return { projectId: inquiry.projectId, alreadyApproved: true };
  }
  const proposed = inquiry.proposedProjectJson
    ? (JSON.parse(inquiry.proposedProjectJson) as AgentProjectCreateInput)
    : draftFromInquiry({
        id: inquiry.id,
        subject: inquiry.subject,
        bodyText: inquiry.bodyText,
        parsedName: inquiry.parsedName,
        parsedEmail: inquiry.parsedEmail,
        parsedEventDate: inquiry.parsedEventDate,
        parsedVenue: inquiry.parsedVenue,
      }).proposedProject;

  const input: AgentProjectCreateInput = { ...proposed, ...overrides };
  const project = await createProjectFromAgent(input);

  await db.update(inboundInquiries)
    .set({ status: "approved", projectId: project.id, updatedAt: new Date().toISOString() })
    .where(eq(inboundInquiries.id, inquiryId));

  await logActivity({
    projectId: project.id,
    action: "inquiry.project_created_from_intake",
    actorType: "admin",
    actorName: admin.actorName,
    metadata: { inquiryId },
  });

  return { projectId: project.id, alreadyApproved: false };
}

// Approve + send reply → composed by our template through Resend with our From.
// Gated on the project existing so the outbound communication has a canonical
// home. CRLF-strips the subject before send (N6).
// Rev 2 (MEDIUM 6) — this function is currently UNWIRED (no caller anywhere in `src/`); this fix
// closes the suppression bypass regardless, but there is no live path exercising the `suppressed`
// branch in production today. Returns `{ sent, suppressed }` (rather than collapsing "suppressed"
// and "transport failure" into the same `sent: false`) so a future caller can distinguish them.
export async function approveInquiryReply(inquiryId: string, admin: AdminActor) {
  const inquiry = await loadInquiryForApproval(inquiryId);
  if (!inquiry.projectId) throw new Error("Approve project creation before sending a reply.");
  const recipient = normalizeEmail(inquiry.parsedEmail);
  if (!recipient) throw new Error("Inquiry has no valid single reply recipient.");

  const subject = stripReplySubjectForSend(inquiry.draftReplySubject ?? "Re: Your inquiry");
  const body = sanitizeBody(inquiry.draftReplyBody, MAX_BODY_TEXT_LENGTH) ?? "";

  const { delivered: sent, suppressed } = await sendInquiryReplyEmail({ to: recipient, subject, text: body });
  const now = new Date().toISOString();

  await db.insert(projectCommunications).values({
    id: crypto.randomUUID(),
    projectId: inquiry.projectId,
    direction: "outbound",
    channel: "email",
    status: sent ? "sent" : "draft",
    subject,
    body,
    recipientName: inquiry.parsedName,
    recipientEmail: recipient,
    sentAt: sent ? now : null,
    sourceType: "inbound_inquiry",
    sourceId: inquiry.id,
    createdBy: admin.actorName,
    createdAt: now,
    updatedAt: now,
  });

  await logActivity({
    projectId: inquiry.projectId,
    // A suppressed recipient gets a distinct activity action (rather than a silent sent:false) so
    // Tyler sees WHY it didn't send, same rationale as the rest of this phase.
    action: suppressed ? "inquiry.reply_suppressed" : "inquiry.reply_sent",
    actorType: "admin",
    actorName: admin.actorName,
    metadata: { inquiryId, recipient, sent, suppressed },
  });

  return { sent, suppressed };
}

export async function dismissInquiry(inquiryId: string, admin: AdminActor, status: "dismissed" | "spam", reason?: string) {
  await loadInquiryForApproval(inquiryId);
  await db.update(inboundInquiries)
    .set({ status, dismissedReason: reason ? sanitizeLine(reason, 500) : null, updatedAt: new Date().toISOString() })
    .where(eq(inboundInquiries.id, inquiryId));
  await logActivity({
    action: status === "spam" ? "inquiry.marked_spam" : "inquiry.dismissed",
    actorType: "admin",
    actorName: admin.actorName,
    metadata: { inquiryId, reason: reason ?? null },
  });
  return { status };
}

// Recent inquiries for the admin triage list (describe-only UI in slice A).
export async function listInboundInquiries(limit = 50) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  return db.query.inboundInquiries.findMany({
    orderBy: desc(inboundInquiries.receivedAt),
    limit: safeLimit,
  });
}

export const INQUIRY_INTAKE_ENABLED_FLAG = "INQUIRY_INTAKE_ENABLED";

export function isInquiryIntakeEnabled(): boolean {
  return process.env.INQUIRY_INTAKE_ENABLED === "true";
}
