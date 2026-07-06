import { db } from "@/db/client";
import { clients, projectCommunications, projectParticipants, projects } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { requireProjectSourceForTask } from "@/lib/agent-sources";
import { isEmailSuppressed, sendProjectEmail } from "@/lib/email";
import {
  MAX_BODY_TEXT_LENGTH,
  MAX_SUBJECT_LENGTH,
  normalizeEmail,
  sanitizeLine,
  stripReplySubjectForSend,
} from "@/lib/inbound-inquiry";
import { projectReplyToAddress } from "@/lib/project-reply-token";
import { SMS_OPT_OUT_LANGUAGE, SmsConsentError, sendProjectSms, type SmsSendResult } from "@/lib/sms";
import { and, asc, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";

const communicationDirections = ["outbound", "inbound", "internal"] as const;
const communicationChannels = ["email", "sms", "call", "note"] as const;
const communicationStatuses = ["draft", "queued", "sent", "archived"] as const;

// Twilio's own hard ceiling for a single (concatenated) outbound SMS is 1600
// characters (spec §4.3, mirrored from the inbound-field cap). The send helper
// (`sms.ts`) appends mandatory opt-out language before transport, so the STORED/
// COMPOSED body is capped a bit lower to guarantee the body-plus-opt-out-language
// never exceeds Twilio's ceiling even when the caller's text doesn't already
// contain a `STOP` token. Enforced here (not just the UI) so every caller —
// admin compose form, agent draft tool, generic MCP tool — is bound by the same
// cap; a client-side maxLength is a UX nicety, not the gate.
const SMS_BODY_MAX_LENGTH = 1600 - (SMS_OPT_OUT_LANGUAGE.length + 2); // "\n\n" + opt-out language

function assertSmsBodyLength(channel: string, body: string) {
  if (channel === "sms" && body.length > SMS_BODY_MAX_LENGTH) {
    throw new Error(`SMS message body exceeds the ${SMS_BODY_MAX_LENGTH}-character limit.`);
  }
}

// Phase 14 (email): a shared outbound/inbound email body ceiling, aligned with
// MAX_BODY_TEXT_LENGTH in inbound-inquiry.ts so an outbound body and a stored
// inbound body share one cap. Enforced here (not just the UI) so EVERY caller —
// form, agent draft tool, generic MCP tool — is bound, exactly like the SMS cap.
const EMAIL_BODY_MAX_LENGTH = MAX_BODY_TEXT_LENGTH; // 50_000

function assertEmailBodyLength(channel: string, body: string) {
  if (channel === "email" && body.length > EMAIL_BODY_MAX_LENGTH) {
    throw new Error(`Email message body exceeds the ${EMAIL_BODY_MAX_LENGTH}-character limit.`);
  }
}

// Phase 14 (email): fold CR/LF/NEL/LS/PS out of a stored email subject at
// create/update time (cleanText only trims). A single-line stored subject can
// then never carry a header-injection newline into the hash, the display, or the
// send. Send-time stripReplySubjectForSend remains as defense-in-depth.
function cleanEmailSubject(value: string | null | undefined) {
  return sanitizeLine(value, MAX_SUBJECT_LENGTH);
}

type CreateProjectCommunicationInput = {
  clientId?: string | null;
  direction?: string | null;
  channel?: string | null;
  status?: string | null;
  subject?: string | null;
  body?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  scheduledFor?: string | null;
  sentAt?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

type UpdateProjectCommunicationInput = {
  direction?: string | null;
  channel?: string | null;
  status?: string | null;
  subject?: string | null;
  body?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  scheduledFor?: string | null;
  sentAt?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

type CommunicationActor = {
  createdBy?: string;
  createAction: string;
  updateAction: string;
  actorType: "admin" | "agent" | "client" | "system";
  actorName: string;
};

const agentActor: CommunicationActor = {
  createdBy: "agent",
  createAction: "project.communication.created_by_agent",
  updateAction: "project.communication.updated_by_agent",
  actorType: "agent",
  actorName: "The Reeses Studio Agent",
};

const studioActor: CommunicationActor = {
  createdBy: "admin",
  createAction: "project.communication.created_by_admin",
  updateAction: "project.communication.updated_by_admin",
  actorType: "admin",
  actorName: "The Reeses Studio",
};

// Phase 8c: the sequence runner is trusted, config-driven CODE (not untrusted
// agent input), so it gets its own actor. It is NOT subject to the agent sms
// clamp (§1.5) — but by POLICY the runner only ever passes status:"draft" for
// drafts and only the auto-send path marks a row "sent". No widening of the
// agent's authority: we ADD an actor, we do not relax the existing clamp.
const systemActor: CommunicationActor = {
  createdBy: "system",
  createAction: "project.communication.created_by_sequence",
  updateAction: "project.communication.updated_by_sequence",
  actorType: "system",
  actorName: "The Reeses Studio Automation",
};

function cleanText(value: string | null | undefined) {
  return value?.trim() || null;
}

function cleanEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() || null;
}

function enumValue<T extends readonly string[]>(value: string | null | undefined, allowed: T, fallback: T[number]) {
  const cleaned = cleanText(value);
  return allowed.includes(cleaned ?? "") ? cleaned as T[number] : fallback;
}

function hasOwn(input: object, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : null;
}

function clientName(client: typeof clients.$inferSelect) {
  return [client.firstName, client.lastName].filter(Boolean).join(" ");
}

async function resolveRecipient(projectId: string, clientId?: string | null) {
  if (clientId) {
    const row = await db
      .select({ client: clients })
      .from(projectParticipants)
      .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
      .where(and(eq(projectParticipants.projectId, projectId), eq(projectParticipants.clientId, clientId)))
      .limit(1);
    if (!row[0]) throw new Error("Project client not found.");
    return row[0].client;
  }

  const row = await db
    .select({ client: clients, participant: projectParticipants })
    .from(projectParticipants)
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(projectParticipants.projectId, projectId))
    .orderBy(desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt))
    .limit(1);
  return row[0]?.client ?? null;
}

async function createProjectCommunication(projectId: string, input: CreateProjectCommunicationInput, actor: CommunicationActor) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new Error("Project not found.");

  const body = cleanText(input.body);
  if (!body) throw new Error("Communication body is required.");

  const sourceType = cleanText(input.sourceType);
  const sourceId = cleanText(input.sourceId);
  if (!sourceType && sourceId) {
    throw new Error("Project communication source links require sourceType when sourceId is set.");
  }
  if (sourceType === "project_source") {
    await requireProjectSourceForTask(projectId, sourceId);
  }

  const recipientClient = await resolveRecipient(projectId, cleanText(input.clientId));
  const now = new Date().toISOString();
  const channel = enumValue(input.channel, communicationChannels, "email");
  const requestedStatus = enumValue(input.status, communicationStatuses, "draft");
  // B1(b) communication-integrity fix (spec §3.0b): an AGENT-authored `sms` row
  // can only ever land `status = "draft"`. This forbids a prompt-injected agent
  // minting a forged `channel:"sms", status:"sent"` ("we texted them" that never
  // went out) via the generic studio_create_communication tool. It makes "only
  // Tyler's admin send can mark an SMS sent" a table-level invariant, not a
  // per-tool convention. Email (and non-agent actors) are UNAFFECTED — the
  // narrowing is the `sms` channel for the agent actor only.
  // B1(b) + Phase 14 §8: an AGENT-authored sms OR email row can only ever land
  // status "draft". This forbids a prompt-injected agent minting a forged
  // channel:"email"/"sms", status:"sent" ("we emailed/texted them" that never
  // went out) via the generic studio_create_communication tool — making "only
  // Tyler's admin send can mark it sent" a table-level invariant for BOTH
  // channels. Non-agent actors (admin form, sequence runner, inquiry-reply
  // insert) are UNAFFECTED.
  const status = actor.actorType === "agent" && (channel === "sms" || channel === "email") ? "draft" : requestedStatus;
  assertSmsBodyLength(channel, body);
  assertEmailBodyLength(channel, body);
  const communication = {
    id: crypto.randomUUID(),
    projectId,
    clientId: recipientClient?.id ?? cleanText(input.clientId),
    direction: enumValue(input.direction, communicationDirections, "outbound"),
    channel,
    status,
    subject: channel === "email" ? cleanEmailSubject(input.subject) : cleanText(input.subject),
    body,
    recipientName: cleanText(input.recipientName) ?? (recipientClient ? clientName(recipientClient) : null),
    recipientEmail: cleanEmail(input.recipientEmail) ?? recipientClient?.email ?? null,
    scheduledFor: cleanText(input.scheduledFor),
    sentAt: cleanText(input.sentAt) ?? (status === "sent" ? now : null),
    sourceType,
    sourceId,
    createdBy: actor.createdBy,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(projectCommunications).values(communication);
  await logActivity({
    projectId,
    clientId: communication.clientId,
    action: actor.createAction,
    actorType: actor.actorType,
    actorName: actor.actorName,
    metadata: {
      communicationId: communication.id,
      channel: communication.channel,
      status: communication.status,
      subject: communication.subject,
      sourceType: communication.sourceType,
      sourceId: communication.sourceId,
    },
  });

  return communication;
}

async function updateProjectCommunication(
  projectId: string,
  communicationId: string,
  input: UpdateProjectCommunicationInput,
  actor: CommunicationActor,
) {
  const communication = await db.query.projectCommunications.findFirst({
    where: (row, { and, eq }) => and(eq(row.id, communicationId), eq(row.projectId, projectId)),
  });
  if (!communication) throw new Error("Communication not found.");

  const nextBody = hasOwn(input, "body") ? cleanText(input.body) : communication.body;
  if (!nextBody) throw new Error("Communication body is required.");

  const now = new Date().toISOString();
  const nextChannel = hasOwn(input, "channel") ? enumValue(input.channel, communicationChannels, communication.channel as typeof communicationChannels[number]) : communication.channel;
  const requestedStatus = hasOwn(input, "status") ? enumValue(input.status, communicationStatuses, communication.status as typeof communicationStatuses[number]) : communication.status;
  // B1(b) communication-integrity fix (spec §3.0b): an agent can never flip an
  // `sms` row (existing OR newly re-channeled to sms) into `sent`/`queued`. Any
  // agent-supplied send-state on an sms row is clamped back to "draft" so the
  // approval trail stays truthful. Email/non-agent actors are unaffected.
  const nextStatus =
    actor.actorType === "agent" &&
    (nextChannel === "sms" || nextChannel === "email") &&
    (requestedStatus === "sent" || requestedStatus === "queued")
      ? "draft"
      : requestedStatus;
  assertSmsBodyLength(nextChannel, nextBody);
  assertEmailBodyLength(nextChannel, nextBody);
  const nextSentAt = hasOwn(input, "sentAt") ? cleanText(input.sentAt) : communication.sentAt;
  const nextSourceType = hasOwn(input, "sourceType") ? cleanText(input.sourceType) : communication.sourceType;
  const nextSourceId = hasOwn(input, "sourceId") ? cleanText(input.sourceId) : communication.sourceId;
  if (!nextSourceType && nextSourceId) {
    throw new Error("Project communication source links require sourceType when sourceId is set.");
  }
  if (nextSourceType === "project_source") {
    await requireProjectSourceForTask(projectId, nextSourceId);
  }

  const updates = {
    direction: hasOwn(input, "direction") ? enumValue(input.direction, communicationDirections, communication.direction as typeof communicationDirections[number]) : communication.direction,
    channel: nextChannel,
    status: nextStatus,
    subject: hasOwn(input, "subject")
      ? (nextChannel === "email" ? cleanEmailSubject(input.subject) : cleanText(input.subject))
      : communication.subject,
    body: nextBody,
    recipientName: hasOwn(input, "recipientName") ? cleanText(input.recipientName) : communication.recipientName,
    recipientEmail: hasOwn(input, "recipientEmail") ? cleanEmail(input.recipientEmail) : communication.recipientEmail,
    scheduledFor: hasOwn(input, "scheduledFor") ? cleanText(input.scheduledFor) : communication.scheduledFor,
    sentAt: nextSentAt ?? (nextStatus === "sent" ? now : null),
    sourceType: nextSourceType,
    sourceId: nextSourceId,
    updatedAt: now,
  };

  await db.update(projectCommunications).set(updates).where(eq(projectCommunications.id, communication.id));
  const updated = await db.query.projectCommunications.findFirst({ where: eq(projectCommunications.id, communication.id) });
  if (!updated) throw new Error("Communication update failed.");

  const changedFields = Object.entries(updates)
    .filter(([key, value]) => key !== "updatedAt" && communication[key as keyof typeof communication] !== value)
    .map(([key]) => key);

  await logActivity({
    projectId,
    clientId: updated.clientId,
    action: actor.updateAction,
    actorType: actor.actorType,
    actorName: actor.actorName,
    metadata: {
      communicationId: updated.id,
      status: updated.status,
      changedFields,
      sourceType: updated.sourceType,
      sourceId: updated.sourceId,
    },
  });

  return updated;
}

export async function createProjectCommunicationFromAgent(projectId: string, input: CreateProjectCommunicationInput) {
  return createProjectCommunication(projectId, input, agentActor);
}

// Phase 8c: the ONLY entry the flag-gated sequence runner uses to materialize a
// communication row (draft for review, or a sent record for an auto-send email).
// Not exported to any agent/MCP surface.
export async function createProjectCommunicationFromSystem(projectId: string, input: CreateProjectCommunicationInput) {
  return createProjectCommunication(projectId, input, systemActor);
}

export async function createProjectCommunicationFromForm(projectId: string, formData: FormData) {
  const sourceId = cleanText(formString(formData, "sourceId"));
  return createProjectCommunication(projectId, {
    clientId: formString(formData, "clientId"),
    direction: formString(formData, "direction"),
    channel: formString(formData, "channel"),
    status: formString(formData, "status"),
    subject: formString(formData, "subject"),
    body: formString(formData, "body"),
    recipientName: formString(formData, "recipientName"),
    recipientEmail: formString(formData, "recipientEmail"),
    scheduledFor: formString(formData, "scheduledFor"),
    sentAt: formString(formData, "sentAt"),
    sourceType: sourceId ? "project_source" : null,
    sourceId,
  }, studioActor);
}

export async function updateProjectCommunicationFromAgent(
  projectId: string,
  communicationId: string,
  input: UpdateProjectCommunicationInput,
) {
  return updateProjectCommunication(projectId, communicationId, input, agentActor);
}

export async function updateProjectCommunicationFromForm(projectId: string, communicationId: string, formData: FormData) {
  return updateProjectCommunication(projectId, communicationId, {
    direction: formString(formData, "direction"),
    channel: formString(formData, "channel"),
    status: formString(formData, "status"),
    subject: formString(formData, "subject"),
    body: formString(formData, "body"),
    recipientName: formString(formData, "recipientName"),
    recipientEmail: formString(formData, "recipientEmail"),
    scheduledFor: formString(formData, "scheduledFor"),
    sentAt: formString(formData, "sentAt"),
  }, studioActor);
}

// ---------------------------------------------------------------------------
// Phase 8b — admin-only "send approved SMS" action. This is the SOLE place
// `sendProjectSms` is invoked; it is behind the admin session + Phase 6 admin
// proof (like every other Studio server action). No agent/MCP/automation/inbound
// path reaches it.
// ---------------------------------------------------------------------------

export type SendApprovedSmsResult =
  | { ok: true; communicationId: string; result: Extract<SmsSendResult, { ok: true }> }
  | { ok: false; reason: "not_found" | "not_sms" | "not_draft" | "too_long" | "hash_mismatch" | "no_consent" | "bad_number" | "suppressed" | "flag_off"; message: string };

/** Exported so the admin project page can compute the SAME hash of the body it
 * renders to Tyler, to submit as the `approvedBodyHash` hidden field (B1a content
 * binding, spec §3.0a) — the send action recomputes this hash of the STORED row
 * and refuses on mismatch. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** B1(a) content-binding (spec §3.0a): approval is bound to the exact bytes Tyler
 * reviewed, not to a mutable row id. The send form submits `approvedBodyHash`
 * (sha256 of the reviewed body); we recompute the hash of the STORED row body and
 * REFUSE (no Twilio call) on mismatch — closing the draft-swap TOCTOU where a
 * prompt-injected agent rewrites the draft after review but before send. */
export async function sendApprovedProjectSms(input: {
  projectId: string;
  communicationId: string;
  approvedBodyHash: string;
  actorName?: string;
}): Promise<SendApprovedSmsResult> {
  const communication = await db.query.projectCommunications.findFirst({
    where: (row, { and, eq }) => and(eq(row.id, input.communicationId), eq(row.projectId, input.projectId)),
  });
  if (!communication) {
    return { ok: false, reason: "not_found", message: "SMS draft not found." };
  }
  if (communication.channel !== "sms") {
    return { ok: false, reason: "not_sms", message: "This communication is not an SMS." };
  }
  // Only a NOT-yet-sent OUTBOUND draft can be sent. This refuses (zero Twilio
  // calls): (a) a form re-submit of an already-"sent" row (no double-send), and
  // (b) an INBOUND row — a client's STOP/reply (direction "inbound") must never be
  // "sent" back to them, which would also clobber its providerMessageId.
  if (communication.status !== "draft" || communication.direction !== "outbound") {
    return { ok: false, reason: "not_draft", message: "Only an unsent outbound SMS draft can be sent." };
  }
  // Belt-and-braces: a legacy draft created before the shared length cap could
  // exceed SMS_BODY_MAX_LENGTH. Refuse with a friendly reason here rather than
  // let it fail at Twilio's transport with a raw 400 (Fable code-review #3).
  if ((communication.body ?? "").length > SMS_BODY_MAX_LENGTH) {
    return {
      ok: false,
      reason: "too_long",
      message: `This SMS draft exceeds the ${SMS_BODY_MAX_LENGTH}-character limit. Shorten it and try again.`,
    };
  }

  const storedHash = sha256Hex(communication.body ?? "");
  if (!input.approvedBodyHash || storedHash !== input.approvedBodyHash) {
    // The stored draft differs from what Tyler reviewed — refuse, NO Twilio call.
    await logActivity({
      projectId: input.projectId,
      clientId: communication.clientId,
      action: "project.communication.sms_send_refused",
      actorType: "admin",
      actorName: input.actorName || "Tyler",
      metadata: { communicationId: input.communicationId, reason: "hash_mismatch" },
    });
    return {
      ok: false,
      reason: "hash_mismatch",
      message: "This SMS draft changed after it was reviewed. Re-review before sending.",
    };
  }

  let result: SmsSendResult;
  try {
    result = await sendProjectSms({
      projectId: input.projectId,
      clientId: communication.clientId,
      body: communication.body,
      communicationId: communication.id,
      actorName: input.actorName,
    });
  } catch (error) {
    if (error instanceof SmsConsentError) {
      return { ok: false, reason: "no_consent", message: "Client has not opted in to SMS." };
    }
    throw error;
  }

  if (!result.ok) {
    const messages: Record<Extract<SmsSendResult, { ok: false }>["reason"], string> = {
      flag_off: "SMS is disabled.",
      no_consent: "Client has not opted in to SMS.",
      bad_number: "The client's phone number is not a valid SMS destination.",
      suppressed: "This number has texted STOP and is suppressed.",
    };
    return { ok: false, reason: result.reason, message: messages[result.reason] };
  }

  return { ok: true, communicationId: communication.id, result };
}

export async function sendApprovedProjectSmsFromForm(formData: FormData): Promise<SendApprovedSmsResult> {
  const projectId = cleanText(formString(formData, "projectId"));
  const communicationId = cleanText(formString(formData, "communicationId"));
  const approvedBodyHash = cleanText(formString(formData, "approvedBodyHash"));
  if (!projectId || !communicationId) throw new Error("Project and communication are required.");
  return sendApprovedProjectSms({
    projectId,
    communicationId,
    approvedBodyHash: approvedBodyHash ?? "",
  });
}

// ---------------------------------------------------------------------------
// Phase 14 — admin-only "send approved email" action. The SOLE place
// `sendProjectEmail` (project-thread transport) is invoked; behind the admin
// session + admin proof like send-sms. No agent/MCP/automation/inbound path
// reaches it.
// ---------------------------------------------------------------------------

/** Off-by-default outbound flag (strict `=== "1"`, read in body). OFF ⇒
 * `sendApprovedProjectEmail` returns `flag_off`, the draft stays. */
export function emailSendingEnabled(): boolean {
  return process.env.EMAIL_SENDING_ENABLED === "1";
}

/** Phase 14 content+recipient binding (spec §1.2, Finding MEDIUM 1). Unlike SMS
 * (body-only, recipient derives from the consented clientId), email binds
 * subject AND body AND the resolved recipient, because a prompt-injected agent
 * can swap ONLY `recipientEmail` after review (status stays draft, subject/body
 * unchanged). Per-component sha256 encoding so a newline-bearing subject can
 * never collide with a differently-split subject/body (Finding LOW 3). */
export function emailApprovalHash(
  subject: string | null | undefined,
  body: string | null | undefined,
  recipient: string | null | undefined,
): string {
  return sha256Hex(sha256Hex(subject ?? "") + sha256Hex(body ?? "") + sha256Hex(recipient ?? ""));
}

/** Resolve the recipient the send path will deliver to (and the UI must bind
 * into the hash): the row's `recipientEmail`, else the project primary
 * participant's email. Returns a normalized address or null. */
export async function resolveEmailRecipientForCommunication(
  projectId: string,
  communication: { recipientEmail: string | null; clientId: string | null },
): Promise<string | null> {
  const direct = normalizeEmail(communication.recipientEmail);
  if (direct) return direct;
  const client = await resolveRecipient(projectId, communication.clientId);
  return client ? normalizeEmail(client.email) : null;
}

export type SendApprovedEmailResult =
  | { ok: true; communicationId: string; providerMessageId: string | null }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_email"
        | "not_draft"
        | "too_long"
        | "hash_mismatch"
        | "no_recipient"
        | "suppressed"
        | "not_configured"
        | "send_failed"
        | "flag_off";
      message: string;
    };

/**
 * Ordered gate — each step refuses with ZERO Resend call. The recipient is
 * RESOLVED BEFORE the hash check (spec §1.3, Finding MEDIUM 1) so the hash can
 * bind it: a post-review swap of subject, body, OR recipientEmail changes the
 * resolved recipient → the hash no longer matches → `hash_mismatch`.
 */
export async function sendApprovedProjectEmail(input: {
  projectId: string;
  communicationId: string;
  approvedBodyHash: string;
  actorName?: string;
}): Promise<SendApprovedEmailResult> {
  const communication = await db.query.projectCommunications.findFirst({
    where: (row, { and, eq }) => and(eq(row.id, input.communicationId), eq(row.projectId, input.projectId)),
  });
  if (!communication) {
    return { ok: false, reason: "not_found", message: "Email draft not found." };
  }
  if (communication.channel !== "email") {
    return { ok: false, reason: "not_email", message: "This communication is not an email." };
  }
  // Only a NOT-yet-sent OUTBOUND draft can be sent: refuses a re-submit of an
  // already-sent row (no double-send) and an INBOUND client reply (never sent back).
  if (communication.status !== "draft" || communication.direction !== "outbound") {
    return { ok: false, reason: "not_draft", message: "Only an unsent outbound email draft can be sent." };
  }
  if ((communication.body ?? "").length > EMAIL_BODY_MAX_LENGTH) {
    return {
      ok: false,
      reason: "too_long",
      message: `This email draft exceeds the ${EMAIL_BODY_MAX_LENGTH}-character limit. Shorten it and try again.`,
    };
  }

  // Step 5: resolve the recipient FIRST — the hash binds the resolved recipient.
  const resolvedRecipient = await resolveEmailRecipientForCommunication(input.projectId, communication);
  if (!resolvedRecipient) {
    return { ok: false, reason: "no_recipient", message: "This email draft has no valid recipient." };
  }

  // Step 6: recompute the recipient-bound hash over the STORED row and refuse on
  // mismatch — closing BOTH the draft-swap TOCTOU and the recipient-redirect
  // TOCTOU (SMS never had to defend the latter).
  const storedHash = emailApprovalHash(communication.subject, communication.body, resolvedRecipient);
  if (!input.approvedBodyHash || storedHash !== input.approvedBodyHash) {
    await logActivity({
      projectId: input.projectId,
      clientId: communication.clientId,
      action: "project.communication.email_send_refused",
      actorType: "admin",
      actorName: input.actorName || "Tyler",
      metadata: { communicationId: input.communicationId, reason: "hash_mismatch" },
    });
    return {
      ok: false,
      reason: "hash_mismatch",
      message: "This email draft (or its recipient) changed after it was reviewed. Re-review before sending.",
    };
  }

  // Step 7: suppression WINS (same discipline as sendSequenceEmail + SMS).
  if (await isEmailSuppressed(resolvedRecipient)) {
    return { ok: false, reason: "suppressed", message: "This email address is suppressed. Nothing was sent." };
  }

  // Step 8: flag (dark no-op — draft stays, no false success).
  if (!emailSendingEnabled()) {
    return { ok: false, reason: "flag_off", message: "Email sending is currently disabled." };
  }

  // Step 10 prep: CRLF-strip the subject immediately before transport (defense in
  // depth). A subject that still bears a newline after sanitization is refused.
  let safeSubject: string;
  try {
    safeSubject = stripReplySubjectForSend(communication.subject ?? "");
  } catch {
    return { ok: false, reason: "send_failed", message: "The email subject could not be safely sent." };
  }

  // Two-way stays dark until REPLY_TOKEN_SECRET is set: mint returns null →
  // replyTo undefined → resendRequest omits reply_to entirely (no empty-tag
  // bouncing address). Outbound still sends.
  const replyTo = projectReplyToAddress(input.projectId) ?? undefined;

  let result: { delivered: boolean; status: number | null; providerMessageId: string | null };
  try {
    result = await sendProjectEmail({
      to: resolvedRecipient,
      subject: safeSubject,
      text: communication.body ?? "",
      replyTo,
    });
  } catch {
    // Thrown after dispatch — ambiguous, never a false "sent" (under-send only).
    return { ok: false, reason: "send_failed", message: "The email could not be sent. Nothing was sent." };
  }

  if (result.delivered) {
    const now = new Date().toISOString();
    await db
      .update(projectCommunications)
      .set({
        status: "sent",
        sentAt: now,
        providerMessageId: result.providerMessageId,
        deliveryStatus: "sent",
        updatedAt: now,
      })
      .where(eq(projectCommunications.id, communication.id));
    await logActivity({
      projectId: input.projectId,
      clientId: communication.clientId,
      action: "project.communication.email_sent",
      actorType: "admin",
      actorName: input.actorName || "Tyler",
      metadata: {
        communicationId: communication.id,
        recipient: resolvedRecipient,
        providerMessageId: result.providerMessageId,
        delivered: true,
      },
    });
    return { ok: true, communicationId: communication.id, providerMessageId: result.providerMessageId };
  }

  // Fail-closed key: no RESEND_API_KEY → not-delivered, status null → draft stays.
  if (result.status === null) {
    return { ok: false, reason: "not_configured", message: "Email is not configured. Nothing was sent." };
  }
  // Any 4xx (rejected) or 5xx/ambiguous → draft stays, never a false "sent".
  return { ok: false, reason: "send_failed", message: "The email could not be sent. Nothing was sent." };
}

export async function sendApprovedProjectEmailFromForm(formData: FormData): Promise<SendApprovedEmailResult> {
  const projectId = cleanText(formString(formData, "projectId"));
  const communicationId = cleanText(formString(formData, "communicationId"));
  const approvedBodyHash = cleanText(formString(formData, "approvedBodyHash"));
  if (!projectId || !communicationId) throw new Error("Project and communication are required.");
  return sendApprovedProjectEmail({
    projectId,
    communicationId,
    approvedBodyHash: approvedBodyHash ?? "",
  });
}

export async function listProjectCommunications(projectId: string, input: { status?: string | null; limit?: number | null } = {}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50);
  const status = cleanText(input.status);

  if (status) {
    return db.query.projectCommunications.findMany({
      where: (row, { and, eq }) => and(eq(row.projectId, projectId), eq(row.status, status)),
      orderBy: [desc(projectCommunications.createdAt)],
      limit,
    });
  }

  return db.query.projectCommunications.findMany({
    where: eq(projectCommunications.projectId, projectId),
    orderBy: [desc(projectCommunications.createdAt)],
    limit,
  });
}
