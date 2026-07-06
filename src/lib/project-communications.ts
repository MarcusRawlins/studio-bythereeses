import { db } from "@/db/client";
import { clients, projectCommunications, projectParticipants, projects } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { requireProjectSourceForTask } from "@/lib/agent-sources";
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
  const status = actor.actorType === "agent" && channel === "sms" ? "draft" : requestedStatus;
  assertSmsBodyLength(channel, body);
  const communication = {
    id: crypto.randomUUID(),
    projectId,
    clientId: recipientClient?.id ?? cleanText(input.clientId),
    direction: enumValue(input.direction, communicationDirections, "outbound"),
    channel,
    status,
    subject: cleanText(input.subject),
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
    actor.actorType === "agent" && nextChannel === "sms" && (requestedStatus === "sent" || requestedStatus === "queued")
      ? "draft"
      : requestedStatus;
  assertSmsBodyLength(nextChannel, nextBody);
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
    subject: hasOwn(input, "subject") ? cleanText(input.subject) : communication.subject,
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
  | { ok: false; reason: "not_found" | "not_sms" | "not_draft" | "hash_mismatch" | "no_consent" | "bad_number" | "suppressed" | "flag_off"; message: string };

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
