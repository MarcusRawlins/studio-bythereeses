import { db } from "@/db/client";
import {
  clients,
  invoicePayments,
  invoices,
  projectCommunications,
  projectParticipants,
  projectWorkflowSteps,
  projects,
  questionnaireResponses,
  schedulerBookings,
  schedulerMeetingTypes,
  sequenceEnrollments,
  sequenceSends,
} from "@/db/schema";
import type { Client, Invoice, Project, SequenceEnrollment } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { isEmailSuppressed, sendSequenceEmail, type SequenceEmailResult } from "@/lib/email";
import { formatMoney } from "@/lib/format";
import { invoiceClientPayableBalanceCents } from "@/lib/invoice-balances";
import { createProjectCommunicationFromSystem } from "@/lib/project-communications";
import { reconciledInvoicePaymentStatus } from "@/lib/sales";
import { and, asc, desc, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Phase 8c — automated communication sequences.
//
// SAFETY DOCTRINE (see docs/specs/phase-8c-sequences.md):
//   • Templates below are CODE CONSTANTS. There is no field, DB column, or tool
//     argument through which an agent / prompt-injection can inject a recipient,
//     a body, or a "send now" signal. `runDueSequences` is invoked ONLY by the
//     bearer-authed cron endpoint — never by any MCP/agent/inbound handler, and
//     it is not exported to any agent surface (a guard test asserts this).
//   • 100% DRAFT-FOR-APPROVAL by default. Auto-send is a per-sequence, EMAIL-ONLY,
//     default-OFF opt-in. SMS NEVER auto-sends here (sequences import nothing that
//     sends SMS — the 8b sendProjectSms gate is the only SMS path).
//   • AT-MOST-ONCE via UNIQUE(dedupeKey): mark-after-success for drafts,
//     claim-before-send for auto-send. A "claimed" row is TERMINAL-UNKNOWN and is
//     NEVER auto-retried — failure is always toward under-send.
//   • ONE step per enrollment per run (latest-due); earlier due steps ledgered
//     "superseded".
// ---------------------------------------------------------------------------

// -------------------------- Flags + tunables (read in body) ----------------

function flagOn(name: string): boolean {
  return process.env[name] === "1";
}

export function sequencesEnabled(): boolean {
  return flagOn("SEQUENCES_ENABLED");
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function maxPerClientPerWeek(): number {
  return intEnv("SEQUENCES_MAX_PER_CLIENT_PER_WEEK", 3);
}

function maxAttempts(): number {
  return intEnv("SEQUENCES_MAX_ATTEMPTS", 2);
}

/** A sequence email carries a one-click unsubscribe link signed by
 * UNSUBSCRIBE_SECRET; if the secret is unset the link is permanently 400, so we
 * must NOT auto-send (the send would ship a dead unsubscribe link). Drafts are
 * unaffected — Tyler reviews and sends those. */
function unsubscribeConfigured(): boolean {
  return Boolean(process.env.UNSUBSCRIBE_SECRET?.trim());
}

// -------------------------- Sequence definitions (constants) ---------------

type StepCondition = "questionnaire_not_filled" | "timeline_call_not_booked";

type RenderContext = {
  project: Project;
  client: Client | null;
  clientFirstName: string;
  invoice?: Invoice;
  balanceCents?: number;
  eventDate?: string;
};

type SequenceStep = {
  stepKey: string;
  /** For dunning: days PAST dueDate. For pre-event: days BEFORE eventDate. For
   * review: days AFTER the workflow step completed. */
  offsetDays: number;
  channel: "email";
  autoSendEligible: boolean;
  condition?: StepCondition;
  render: (ctx: RenderContext) => { subject: string; text: string };
};

type SequenceKey = "dunning" | "pre_event" | "post_delivery_review";

type SequenceDefinition = {
  key: SequenceKey;
  enableFlag: string;
  /** null ⇒ draft-only by design (review). */
  autoSendFlag: string | null;
  anchorKind: "invoice" | "event_date" | "workflow_step";
  steps: SequenceStep[];
};

const SIGNOFF = "Warmly,\nThe Reeses Studio";

const DUNNING_STEPS: SequenceStep[] = [1, 7, 14].map((offsetDays) => ({
  stepKey: `dunning-day-${offsetDays}`,
  offsetDays,
  channel: "email" as const,
  autoSendEligible: true,
  render: (ctx: RenderContext) => {
    const number = ctx.invoice?.invoiceNumber ?? "";
    const balance = formatMoney(ctx.balanceCents ?? 0);
    return {
      subject: `A gentle reminder about invoice ${number}`,
      text: [
        `Hi ${ctx.clientFirstName},`,
        "",
        `We hope you're doing well! This is a friendly reminder that invoice ${number} for ${ctx.project.name} shows an outstanding balance of ${balance}.`,
        "",
        "Whenever it's convenient, you can settle it using the payment options on your invoice. If you've already sent payment, please disregard this note — and thank you.",
        "",
        "If anything about the invoice is unclear or you'd like to arrange a different timeline, just reply and we'll happily help.",
        "",
        SIGNOFF,
      ].join("\n"),
    };
  },
}));

const PRE_EVENT_STEPS: SequenceStep[] = [
  {
    stepKey: "pre-event-45",
    offsetDays: 45,
    channel: "email",
    autoSendEligible: true,
    condition: "questionnaire_not_filled",
    render: (ctx) => ({
      subject: `A quick questionnaire before ${ctx.project.name}`,
      text: [
        `Hi ${ctx.clientFirstName},`,
        "",
        `Your day is getting closer and we can't wait! When you have a few minutes, we'd love for you to complete your planning questionnaire — it helps us capture exactly what matters most to you.`,
        "",
        "If you've already sent it over, thank you and please ignore this reminder.",
        "",
        SIGNOFF,
      ].join("\n"),
    }),
  },
  {
    stepKey: "pre-event-30",
    offsetDays: 30,
    channel: "email",
    autoSendEligible: true,
    condition: "timeline_call_not_booked",
    render: (ctx) => ({
      subject: `Let's book your timeline planning call for ${ctx.project.name}`,
      text: [
        `Hi ${ctx.clientFirstName},`,
        "",
        "We'd love to schedule your timeline planning call so everything runs beautifully on the day. When you have a moment, grab a time that works for you and we'll take it from there.",
        "",
        "Already booked? Wonderful — you can ignore this note.",
        "",
        SIGNOFF,
      ].join("\n"),
    }),
  },
  {
    stepKey: "pre-event-14",
    offsetDays: 14,
    channel: "email",
    autoSendEligible: true,
    condition: "questionnaire_not_filled",
    render: (ctx) => ({
      subject: `One more nudge on your questionnaire for ${ctx.project.name}`,
      text: [
        `Hi ${ctx.clientFirstName},`,
        "",
        "Just a gentle follow-up — we still have your planning questionnaire on our list. Completing it soon helps us finalize every detail for your day.",
        "",
        "If you've already submitted it, thank you and please disregard this.",
        "",
        SIGNOFF,
      ].join("\n"),
    }),
  },
  {
    stepKey: "pre-event-7",
    offsetDays: 7,
    channel: "email",
    autoSendEligible: true,
    condition: "timeline_call_not_booked",
    render: (ctx) => ({
      subject: `Timeline call for ${ctx.project.name} — this week?`,
      text: [
        `Hi ${ctx.clientFirstName},`,
        "",
        "With your day almost here, let's connect for your timeline planning call. Pick any time that suits you and we'll make sure everything is set.",
        "",
        "If we've already spoken, thank you — no action needed.",
        "",
        SIGNOFF,
      ].join("\n"),
    }),
  },
];

const REVIEW_STEPS: SequenceStep[] = [
  {
    stepKey: "review-request-delay",
    offsetDays: intEnv("SEQUENCES_REVIEW_DELAY_DAYS", 3),
    channel: "email",
    autoSendEligible: false,
    render: (ctx) => ({
      subject: `We'd love your feedback on ${ctx.project.name}`,
      text: [
        `Hi ${ctx.clientFirstName},`,
        "",
        "It was such a joy working with you! If you have a moment, we'd be so grateful for a short review of your experience — it means the world to a small studio like ours.",
        "",
        SIGNOFF,
      ].join("\n"),
    }),
  },
];

export const SEQUENCES: SequenceDefinition[] = [
  { key: "dunning", enableFlag: "SEQUENCES_DUNNING", autoSendFlag: "SEQUENCES_DUNNING_AUTOSEND", anchorKind: "invoice", steps: DUNNING_STEPS },
  { key: "pre_event", enableFlag: "SEQUENCES_PREEVENT", autoSendFlag: "SEQUENCES_PREEVENT_AUTOSEND", anchorKind: "event_date", steps: PRE_EVENT_STEPS },
  { key: "post_delivery_review", enableFlag: "SEQUENCES_REVIEW", autoSendFlag: null, anchorKind: "workflow_step", steps: REVIEW_STEPS },
];

function sequenceEnabled(seq: SequenceDefinition): boolean {
  return flagOn(seq.enableFlag);
}

function sequenceAutoSendOn(seq: SequenceDefinition): boolean {
  return seq.autoSendFlag !== null && flagOn(seq.autoSendFlag);
}

// -------------------------- Date helpers -----------------------------------

function parseDateOnly(value: string): Date {
  // dueDate / eventDate are stored "YYYY-MM-DD"; anchor at noon UTC to avoid
  // a TZ off-by-one when comparing whole-day offsets.
  const iso = value.length <= 10 ? `${value}T12:00:00.000Z` : value;
  return new Date(iso);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Local (America/New_York) hour, 0–23. */
function newYorkHour(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  return hour === 24 ? 0 : hour;
}

/** Auto-send email only fires within business hours (defensive; a 10am ET daily
 * cron satisfies this by construction). Drafts are unrestricted. */
function withinBusinessHours(now: Date): boolean {
  const hour = newYorkHour(now);
  return hour >= 9 && hour < 18;
}

// -------------------------- Ledger + dedupe --------------------------------

function dedupeKeyFor(seq: SequenceDefinition, enrollment: Pick<SequenceEnrollment, "projectId" | "anchorKey">, step: SequenceStep): string {
  if (seq.key === "dunning") return `dunning:${enrollment.anchorKey}:${step.stepKey}`;
  // anchorKey for pre_event is already project-scoped ("<projectId>:<eventDateISO>")
  // so it is globally unique — two weddings on the same date do not collide on
  // the enrollment UNIQUE(sequenceKey, anchorKey).
  if (seq.key === "pre_event") return `pre_event:${enrollment.anchorKey}:${step.stepKey}`;
  return `post_delivery_review:${enrollment.projectId}:${enrollment.anchorKey}`;
}

async function existingDedupeKeys(dedupeKeys: string[]): Promise<Set<string>> {
  if (dedupeKeys.length === 0) return new Set();
  const rows = await db
    .select({ dedupeKey: sequenceSends.dedupeKey })
    .from(sequenceSends)
    .where(inArray(sequenceSends.dedupeKey, dedupeKeys));
  return new Set(rows.map((row) => row.dedupeKey));
}

type LedgerInsert = {
  projectId: string;
  clientId: string | null;
  enrollmentId: string;
  sequenceKey: string;
  stepKey: string;
  dedupeKey: string;
  channel: string;
  mode: "draft" | "auto_send";
  status: "claimed" | "done" | "failed" | "superseded";
  communicationId?: string | null;
  attempts?: number;
  note?: string | null;
  firedAt: string;
};

/** Atomic insert. Returns true iff THIS call inserted the row (claim ownership);
 * false on UNIQUE(dedupeKey) conflict. */
async function insertLedger(row: LedgerInsert): Promise<boolean> {
  const inserted = await db
    .insert(sequenceSends)
    .values({
      id: crypto.randomUUID(),
      projectId: row.projectId,
      clientId: row.clientId,
      enrollmentId: row.enrollmentId,
      sequenceKey: row.sequenceKey,
      stepKey: row.stepKey,
      dedupeKey: row.dedupeKey,
      channel: row.channel,
      mode: row.mode,
      status: row.status,
      communicationId: row.communicationId ?? null,
      attempts: row.attempts ?? 0,
      firedAt: row.firedAt,
      note: row.note ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: sequenceSends.id });
  return inserted.length > 0;
}

// -------------------------- Recipient + cap --------------------------------

async function primaryClientForProject(projectId: string): Promise<Client | null> {
  const row = await db
    .select({ client: clients })
    .from(projectParticipants)
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(projectParticipants.projectId, projectId))
    .orderBy(desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt))
    .limit(1);
  return row[0]?.client ?? null;
}

/** Rolling per-client cap. Counts EMITTED / attempted ledger rows (done or
 * claimed) in the trailing 7 days — superseded/failed rows are not messages. */
async function overFrequencyCap(clientId: string | null, now: Date): Promise<boolean> {
  if (!clientId) return false;
  const cap = maxPerClientPerWeek();
  if (cap <= 0) return true;
  const cutoff = addDays(now, -7).toISOString();
  const rows = await db
    .select({ status: sequenceSends.status, firedAt: sequenceSends.firedAt })
    .from(sequenceSends)
    .where(and(eq(sequenceSends.clientId, clientId), gte(sequenceSends.firedAt, cutoff)));
  const count = rows.filter((row) => row.status === "done" || row.status === "claimed").length;
  return count >= cap;
}

// -------------------------- Pre-event conditions ---------------------------

async function evaluateCondition(condition: StepCondition, projectId: string): Promise<boolean> {
  if (condition === "questionnaire_not_filled") {
    const existing = await db.query.questionnaireResponses.findFirst({
      where: eq(questionnaireResponses.projectId, projectId),
    });
    return !existing; // fire only when NO response exists
  }
  // timeline_call_not_booked: fire only when there is NO confirmed timeline/
  // planning meeting booking for the project.
  const bookings = await db
    .select({ booking: schedulerBookings, meetingType: schedulerMeetingTypes })
    .from(schedulerBookings)
    .innerJoin(schedulerMeetingTypes, eq(schedulerBookings.meetingTypeId, schedulerMeetingTypes.id))
    .where(and(eq(schedulerBookings.projectId, projectId), eq(schedulerBookings.status, "confirmed")));
  const hasTimelineBooking = bookings.some(({ meetingType }) =>
    /timeline|planning/i.test(`${meetingType.slug} ${meetingType.name}`),
  );
  return !hasTimelineBooking;
}

// -------------------------- Context + stop-check ---------------------------

/** Returns the render context for an active enrollment, or null when the
 * enrollment's stop-condition now holds (the caller marks it completed and fires
 * nothing). Dunning stop-on-paid is RE-CHECKED here at fire time. */
async function buildContext(seq: SequenceDefinition, enrollment: SequenceEnrollment, now: Date): Promise<RenderContext | null> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, enrollment.projectId) });
  if (!project) return null;
  const client = await primaryClientForProject(enrollment.projectId);
  const clientFirstName = client?.firstName?.trim() || "there";
  const base: RenderContext = { project, client, clientFirstName };

  if (seq.key === "dunning") {
    const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, enrollment.anchorKey) });
    if (!invoice) return null;
    const payments = await db.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, invoice.id) });
    const paidTotalCents = payments.reduce(
      (sum, payment) => (payment.status === "paid" ? sum + payment.paidAmountCents : sum),
      0,
    );
    const status = reconciledInvoicePaymentStatus(invoice, paidTotalCents);
    const balanceCents = invoiceClientPayableBalanceCents(invoice, payments);
    const dueDate = invoice.dueDate;
    const stillOwed =
      (status === "sent" || status === "partially_paid") &&
      Boolean(dueDate) &&
      (dueDate as string) < dateKey(now) &&
      balanceCents > 0;
    if (!stillOwed) return null; // paid / void / draft / zero-balance / not-yet-due → completed
    return { ...base, invoice, balanceCents };
  }

  if (seq.key === "pre_event") {
    // anchorKey = "<projectId>:<eventDateISO>"; the event date is everything
    // after the first colon (projectId and the date contain no colons).
    const eventDate = enrollment.anchorKey.slice(enrollment.anchorKey.indexOf(":") + 1);
    // Event passed → completed.
    if (eventDate < dateKey(now)) return null;
    return { ...base, eventDate };
  }

  // post_delivery_review: single step; the enrollment completes after it fires.
  return base;
}

function stepDueAt(seq: SequenceDefinition, ctx: RenderContext, step: SequenceStep, anchorCompletedAtIso?: string): Date {
  if (seq.key === "dunning") {
    return addDays(parseDateOnly(ctx.invoice!.dueDate as string), step.offsetDays);
  }
  if (seq.key === "pre_event") {
    return addDays(parseDateOnly(ctx.eventDate as string), -step.offsetDays);
  }
  // review: offset days AFTER completion.
  return addDays(new Date(anchorCompletedAtIso ?? new Date().toISOString()), step.offsetDays);
}

// -------------------------- Auto-enroll ------------------------------------

type RunSummary = {
  enrolled: number;
  drafted: number;
  autoSent: number;
  superseded: number;
  cappedSkips: number;
  suppressedSkips: number;
  completed: number;
  failed: number;
  stuck: number;
  checked: number;
};

async function enroll(
  seq: SequenceDefinition,
  input: { projectId: string; clientId: string | null; anchorKey: string },
  now: Date,
  summary: RunSummary,
): Promise<void> {
  const inserted = await db
    .insert(sequenceEnrollments)
    .values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      clientId: input.clientId,
      sequenceKey: seq.key,
      anchorKey: input.anchorKey,
      status: "active",
      enrolledBy: "system",
      enrolledAt: now.toISOString(),
    })
    .onConflictDoNothing()
    .returning({ id: sequenceEnrollments.id });
  if (inserted.length > 0) {
    summary.enrolled += 1;
    await logActivity({
      projectId: input.projectId,
      clientId: input.clientId,
      action: "sequence.enrolled",
      actorType: "system",
      actorName: "The Reeses Studio Automation",
      metadata: { sequenceKey: seq.key, anchorKey: input.anchorKey },
    });
  }
}

async function enrollDunning(seq: SequenceDefinition, now: Date, summary: RunSummary): Promise<void> {
  const today = dateKey(now);
  // Only invoices that are not paid/void/draft and are past due are candidates.
  const candidates = await db.query.invoices.findMany({
    where: inArray(invoices.status, ["sent", "partially_paid", "overdue"]),
    limit: 500,
  });
  for (const invoice of candidates) {
    if (!invoice.dueDate || invoice.dueDate >= today) continue;
    const payments = await db.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, invoice.id) });
    const paidTotalCents = payments.reduce(
      (sum, payment) => (payment.status === "paid" ? sum + payment.paidAmountCents : sum),
      0,
    );
    const status = reconciledInvoicePaymentStatus(invoice, paidTotalCents);
    if (status !== "sent" && status !== "partially_paid") continue;
    if (invoiceClientPayableBalanceCents(invoice, payments) <= 0) continue;
    const client = await primaryClientForProject(invoice.projectId);
    await enroll(seq, { projectId: invoice.projectId, clientId: client?.id ?? null, anchorKey: invoice.id }, now, summary);
  }
}

async function enrollPreEvent(seq: SequenceDefinition, now: Date, summary: RunSummary): Promise<void> {
  const today = dateKey(now);
  const rows = await db.query.projects.findMany({ limit: 1000 });
  for (const project of rows) {
    if (!project.eventDate || project.eventDate < today) continue;
    const client = await primaryClientForProject(project.id);
    // Project-scoped anchor so two weddings on the same date don't collide on
    // the enrollment UNIQUE(sequenceKey, anchorKey).
    await enroll(seq, { projectId: project.id, clientId: client?.id ?? null, anchorKey: `${project.id}:${project.eventDate}` }, now, summary);
  }
}

async function enrollReview(seq: SequenceDefinition, now: Date, summary: RunSummary): Promise<void> {
  const steps = await db.query.projectWorkflowSteps.findMany({
    where: and(
      eq(projectWorkflowSteps.stepKey, "gallery-delivery"),
      inArray(projectWorkflowSteps.status, ["done", "completed"]),
    ),
    limit: 500,
  });
  for (const step of steps) {
    const client = await primaryClientForProject(step.projectId);
    await enroll(seq, { projectId: step.projectId, clientId: client?.id ?? null, anchorKey: step.id }, now, summary);
  }
}

// -------------------------- Fire a step ------------------------------------

async function markCompleted(enrollment: SequenceEnrollment, now: Date, reason: string): Promise<void> {
  await db
    .update(sequenceEnrollments)
    .set({ status: "completed", stoppedAt: now.toISOString(), stopReason: reason })
    .where(eq(sequenceEnrollments.id, enrollment.id));
}

async function draftStep(
  seq: SequenceDefinition,
  enrollment: SequenceEnrollment,
  step: SequenceStep,
  dedupeKey: string,
  ctx: RenderContext,
  now: Date,
  summary: RunSummary,
): Promise<void> {
  const rendered = step.render(ctx);
  const communication = await createProjectCommunicationFromSystem(enrollment.projectId, {
    clientId: enrollment.clientId,
    direction: "outbound",
    channel: "email",
    status: "draft",
    subject: rendered.subject,
    body: rendered.text,
    recipientEmail: ctx.client?.email ?? null,
    sourceType: "sequence_step",
    sourceId: `${seq.key}:${step.stepKey}`,
  });
  await insertLedger({
    projectId: enrollment.projectId,
    clientId: enrollment.clientId,
    enrollmentId: enrollment.id,
    sequenceKey: seq.key,
    stepKey: step.stepKey,
    dedupeKey,
    channel: "email",
    mode: "draft",
    status: "done",
    communicationId: communication.id,
    firedAt: now.toISOString(),
  });
  summary.drafted += 1;
}

async function autoSendStep(
  seq: SequenceDefinition,
  enrollment: SequenceEnrollment,
  step: SequenceStep,
  dedupeKey: string,
  ctx: RenderContext,
  now: Date,
  summary: RunSummary,
): Promise<void> {
  const email = ctx.client?.email;
  if (!email) return;

  // Never auto-send a dead-unsubscribe-link email. Unconfigured secret ⇒ skip
  // (no claim, no send); the step re-evaluates once the secret is set.
  if (!unsubscribeConfigured()) return;

  // CLAIM-FIRST: own the dedupeKey BEFORE the send so a crash/retry can never
  // double-send. If we did not insert (conflict) another run already owns it.
  const claimed = await insertLedger({
    projectId: enrollment.projectId,
    clientId: enrollment.clientId,
    enrollmentId: enrollment.id,
    sequenceKey: seq.key,
    stepKey: step.stepKey,
    dedupeKey,
    channel: "email",
    mode: "auto_send",
    status: "claimed",
    attempts: 1,
    firedAt: now.toISOString(),
  });
  if (!claimed) return;

  const rendered = step.render(ctx);
  let result: SequenceEmailResult;
  try {
    result = await sendSequenceEmail({ to: email, subject: rendered.subject, text: rendered.text, purpose: "sequences" });
  } catch {
    // Thrown AFTER dispatch → Resend MAY have accepted → leave the row "claimed"
    // (terminal-unknown). NEVER auto-retry. Surfaced later via send_stuck.
    return;
  }

  if (result.ok) {
    const communication = await createProjectCommunicationFromSystem(enrollment.projectId, {
      clientId: enrollment.clientId,
      direction: "outbound",
      channel: "email",
      status: "sent",
      subject: rendered.subject,
      body: rendered.text,
      recipientEmail: email,
      sentAt: now.toISOString(),
      sourceType: "sequence_step",
      sourceId: `${seq.key}:${step.stepKey}`,
    });
    await db
      .update(sequenceSends)
      .set({ status: "done", communicationId: communication.id })
      .where(eq(sequenceSends.dedupeKey, dedupeKey));
    summary.autoSent += 1;
    return;
  }

  if (result.reason === "suppressed" || result.reason === "rejected") {
    // PROVABLY not sent → retryable. Mark failed; a later run may retry until
    // SEQUENCES_MAX_ATTEMPTS, then abandon + log.
    await db
      .update(sequenceSends)
      .set({ status: "failed", note: result.reason })
      .where(eq(sequenceSends.dedupeKey, dedupeKey));
    summary.failed += 1;
    return;
  }

  // "unknown": ambiguous (5xx / no-key) → leave the row "claimed". Never retry.
}

// Retry ONLY provably-not-sent rows (status "failed") up to maxAttempts.
//
// B1 (own-enrollment render): the retry renders from the row's OWN enrollment
// (looked up by the enrollmentId stored at claim time), NOT "any active
// enrollment of this sequence type". This closes the cross-client leak where a
// retry rendered client A's invoice into client B's email, and re-checks
// stop-on-paid against the correct invoice.
//
// B2 (no concurrent double-send): a compare-and-swap (UPDATE ... WHERE
// status='failed') claims the row BEFORE the transport call. Two overlapping
// runs (daily cron + a manual bearer POST, or a cron overlap) cannot both send —
// only the run whose CAS changes exactly one row proceeds. A 24h backoff gate
// (firedAt older than one run interval) also prevents retrying a row that failed
// THIS run in the SAME run.
async function retryFailedSends(now: Date, summary: RunSummary): Promise<void> {
  const attemptsCap = maxAttempts();
  const backoffCutoff = addDays(now, -1).toISOString(); // 24h backoff between attempts
  const failed = await db.query.sequenceSends.findMany({
    where: and(eq(sequenceSends.status, "failed"), eq(sequenceSends.mode, "auto_send")),
    limit: 100,
  });
  for (const row of failed) {
    if (row.attempts >= attemptsCap) continue;
    if (row.firedAt >= backoffCutoff) continue; // don't retry a row that failed within the last run interval
    if (!unsubscribeConfigured()) continue; // never ship a dead-unsubscribe-link email

    // B1: the row's OWN enrollment (bound at claim time), not just any active one.
    const enrollment = row.enrollmentId
      ? await db.query.sequenceEnrollments.findFirst({ where: eq(sequenceEnrollments.id, row.enrollmentId) })
      : null;
    if (!enrollment || enrollment.status !== "active") continue;

    const seq = SEQUENCES.find((candidate) => candidate.key === row.sequenceKey);
    const step = seq?.steps.find((candidate) => candidate.stepKey === row.stepKey);
    if (!seq || !step || !sequenceEnabled(seq) || !sequenceAutoSendOn(seq)) continue;
    if (!withinBusinessHours(now)) continue;

    const client = row.clientId ? await db.query.clients.findFirst({ where: eq(clients.id, row.clientId) }) : null;
    if (!client?.email || (await isEmailSuppressed(client.email))) continue;

    // Re-check the per-client frequency cap before a retry send.
    if (await overFrequencyCap(row.clientId, now)) continue;

    // Render from the row's OWN enrollment/invoice (buildContext also re-checks
    // stop-on-paid for the CORRECT invoice).
    const ctx = await buildContext(seq, enrollment, now);
    if (!ctx) continue;

    // B2: compare-and-swap claim BEFORE sending. Only one overlapping run wins.
    const claimed = await db
      .update(sequenceSends)
      .set({ status: "claimed", attempts: row.attempts + 1 })
      .where(and(eq(sequenceSends.id, row.id), eq(sequenceSends.status, "failed")))
      .returning({ id: sequenceSends.id });
    if (claimed.length === 0) continue; // another overlapping run already claimed it

    const rendered = step.render(ctx);
    let result: SequenceEmailResult;
    try {
      result = await sendSequenceEmail({ to: client.email, subject: rendered.subject, text: rendered.text, purpose: "sequences" });
    } catch {
      // Ambiguous on retry → stays claimed (terminal-unknown). It keeps its old
      // note (e.g. "rejected"), which surfaceStuckSends now surfaces (note !=
      // 'stuck_surfaced'). Never re-sent.
      continue;
    }
    if (result.ok) {
      const communication = await createProjectCommunicationFromSystem(enrollment.projectId, {
        clientId: row.clientId,
        direction: "outbound",
        channel: "email",
        status: "sent",
        subject: rendered.subject,
        body: rendered.text,
        recipientEmail: client.email,
        sentAt: now.toISOString(),
        sourceType: "sequence_step",
        sourceId: `${seq.key}:${step.stepKey}`,
      });
      await db.update(sequenceSends).set({ status: "done", communicationId: communication.id }).where(eq(sequenceSends.id, row.id));
      summary.autoSent += 1;
    } else if (result.reason === "unknown") {
      // Ambiguous (5xx / no-key) → leave claimed (terminal-unknown). Surfaced.
      continue;
    } else {
      // Provably not sent (suppressed / pre-acceptance 4xx) → back to failed
      // (retryable next interval; attempts already incremented by the CAS).
      await db.update(sequenceSends).set({ status: "failed", note: result.reason }).where(eq(sequenceSends.id, row.id));
      summary.failed += 1;
    }
  }
}

// -------------------------- Stuck (claimed) surfacing ----------------------

async function surfaceStuckSends(now: Date, summary: RunSummary): Promise<void> {
  const cutoff = addDays(now, -1).toISOString(); // older than one daily run interval
  // Surface any claimed (terminal-unknown) row not yet surfaced — including rows
  // escalated failed→claimed by a retry (which keep their old note, e.g.
  // "rejected"). Matching only isNull(note) would miss those forever.
  const stuck = await db.query.sequenceSends.findMany({
    where: and(
      eq(sequenceSends.status, "claimed"),
      or(isNull(sequenceSends.note), ne(sequenceSends.note, "stuck_surfaced")),
    ),
    limit: 100,
  });
  for (const row of stuck) {
    if (row.firedAt >= cutoff) continue;
    await logActivity({
      projectId: row.projectId,
      clientId: row.clientId,
      action: "sequence.send_stuck",
      actorType: "system",
      actorName: "The Reeses Studio Automation",
      metadata: { sequenceKey: row.sequenceKey, stepKey: row.stepKey, dedupeKey: row.dedupeKey, firedAt: row.firedAt },
    });
    await db.update(sequenceSends).set({ note: "stuck_surfaced" }).where(eq(sequenceSends.id, row.id));
    summary.stuck += 1;
  }
}

// -------------------------- Process one enrollment -------------------------

async function processEnrollment(
  seq: SequenceDefinition,
  enrollment: SequenceEnrollment,
  now: Date,
  summary: RunSummary,
): Promise<void> {
  const ctx = await buildContext(seq, enrollment, now);
  if (!ctx) {
    await markCompleted(enrollment, now, "stop_condition_met");
    summary.completed += 1;
    return;
  }

  // Review anchor completion timestamp (for stepDueAt).
  let anchorCompletedAtIso: string | undefined;
  if (seq.key === "post_delivery_review") {
    const step = await db.query.projectWorkflowSteps.findFirst({ where: eq(projectWorkflowSteps.id, enrollment.anchorKey) });
    anchorCompletedAtIso = step?.updatedAt ?? undefined;
    if (!step) {
      await markCompleted(enrollment, now, "workflow_step_missing");
      summary.completed += 1;
      return;
    }
  }

  // Candidate due steps not already in the ledger, condition-passing.
  const dedupeKeys = seq.steps.map((step) => dedupeKeyFor(seq, enrollment, step));
  const alreadyLedgered = await existingDedupeKeys(dedupeKeys);

  const candidates: Array<{ step: SequenceStep; dueAt: Date; dedupeKey: string }> = [];
  for (const step of seq.steps) {
    const dedupeKey = dedupeKeyFor(seq, enrollment, step);
    if (alreadyLedgered.has(dedupeKey)) continue;
    const dueAt = stepDueAt(seq, ctx, step, anchorCompletedAtIso);
    if (now.getTime() < dueAt.getTime()) continue;
    if (step.condition && !(await evaluateCondition(step.condition, enrollment.projectId))) continue;
    candidates.push({ step, dueAt, dedupeKey });
  }
  if (candidates.length === 0) return;

  candidates.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  const chosen = candidates[candidates.length - 1];
  const earlier = candidates.slice(0, -1);

  const email = ctx.client?.email ?? null;
  if (!email) return; // no recipient — cannot draft/send (under-send)

  // Frequency cap — skip the whole firing this run (do not consume any slot).
  if (await overFrequencyCap(enrollment.clientId, now)) {
    summary.cappedSkips += 1;
    await logActivity({
      projectId: enrollment.projectId,
      clientId: enrollment.clientId,
      action: "sequence.capped",
      actorType: "system",
      actorName: "The Reeses Studio Automation",
      metadata: { sequenceKey: seq.key, stepKey: chosen.step.stepKey },
    });
    return;
  }

  // Suppression — a suppressed client gets NO draft either.
  if (await isEmailSuppressed(email)) {
    summary.suppressedSkips += 1;
    await logActivity({
      projectId: enrollment.projectId,
      clientId: enrollment.clientId,
      action: "sequence.suppressed_skip",
      actorType: "system",
      actorName: "The Reeses Studio Automation",
      metadata: { sequenceKey: seq.key, stepKey: chosen.step.stepKey },
    });
    return;
  }

  // Supersede earlier due steps (audit; they never fire on a later run).
  for (const item of earlier) {
    const inserted = await insertLedger({
      projectId: enrollment.projectId,
      clientId: enrollment.clientId,
      enrollmentId: enrollment.id,
      sequenceKey: seq.key,
      stepKey: item.step.stepKey,
      dedupeKey: item.dedupeKey,
      channel: "email",
      mode: "draft",
      status: "superseded",
      note: "superseded_by_latest_due",
      firedAt: now.toISOString(),
    });
    if (inserted) summary.superseded += 1;
  }

  // Fire the latest-due step: auto-send (email-only opt-in) or draft.
  const autoSend = chosen.step.autoSendEligible && sequenceAutoSendOn(seq) && chosen.step.channel === "email";
  if (autoSend) {
    if (!withinBusinessHours(now)) return; // defensive quiet-hours; re-eval next run
    await autoSendStep(seq, enrollment, chosen.step, chosen.dedupeKey, ctx, now, summary);
  } else {
    await draftStep(seq, enrollment, chosen.step, chosen.dedupeKey, ctx, now, summary);
  }

  // Single-step sequences complete once their step is ledgered.
  if (seq.key === "post_delivery_review") {
    await markCompleted(enrollment, now, "review_requested");
    summary.completed += 1;
  }
}

// -------------------------- Public entry (cron-only) -----------------------

/** The idempotent evaluator. Invoked ONLY by POST /api/cron/sequences (bearer-
 * authed). Not exported to any agent/MCP surface. A no-op when SEQUENCES_ENABLED
 * is off (defense-in-depth; the cron route also short-circuits). */
export async function runDueSequences(now: Date = new Date()): Promise<RunSummary | { skipped: "flag_off" }> {
  if (!sequencesEnabled()) return { skipped: "flag_off" };

  const summary: RunSummary = {
    enrolled: 0,
    drafted: 0,
    autoSent: 0,
    superseded: 0,
    cappedSkips: 0,
    suppressedSkips: 0,
    completed: 0,
    failed: 0,
    stuck: 0,
    checked: 0,
  };

  await surfaceStuckSends(now, summary);

  for (const seq of SEQUENCES) {
    if (!sequenceEnabled(seq)) continue;
    if (seq.key === "dunning") await enrollDunning(seq, now, summary);
    else if (seq.key === "pre_event") await enrollPreEvent(seq, now, summary);
    else await enrollReview(seq, now, summary);
  }

  const active = await db.query.sequenceEnrollments.findMany({
    where: eq(sequenceEnrollments.status, "active"),
    limit: 100,
  });
  for (const enrollment of active) {
    const seq = SEQUENCES.find((candidate) => candidate.key === enrollment.sequenceKey);
    if (!seq || !sequenceEnabled(seq)) continue;
    summary.checked += 1;
    await processEnrollment(seq, enrollment, now, summary);
  }

  await retryFailedSends(now, summary);

  return summary;
}

// -------------------------- Admin enroll/unenroll --------------------------

export type SequenceEnrollmentAction = "stop" | "activate";

/** Explicit admin control (admin session + Phase-6 admin proof enforced by the
 * proxy/route). No agent/MCP surface — config authority stays with Tyler + the
 * runner. */
export async function setSequenceEnrollment(input: {
  projectId: string;
  sequenceKey: string;
  action: SequenceEnrollmentAction;
  actorName?: string;
}): Promise<{ ok: boolean; updated: number }> {
  const now = new Date().toISOString();
  const enrollments = await db.query.sequenceEnrollments.findMany({
    where: and(eq(sequenceEnrollments.projectId, input.projectId), eq(sequenceEnrollments.sequenceKey, input.sequenceKey)),
  });
  if (enrollments.length === 0) return { ok: false, updated: 0 };

  const nextStatus = input.action === "stop" ? "stopped" : "active";
  for (const enrollment of enrollments) {
    await db
      .update(sequenceEnrollments)
      .set({
        status: nextStatus,
        stoppedAt: input.action === "stop" ? now : null,
        stopReason: input.action === "stop" ? "admin_unenrolled" : null,
      })
      .where(eq(sequenceEnrollments.id, enrollment.id));
  }
  await logActivity({
    projectId: input.projectId,
    action: input.action === "stop" ? "sequence.unenrolled_by_admin" : "sequence.reactivated_by_admin",
    actorType: "admin",
    actorName: input.actorName || "Tyler",
    metadata: { sequenceKey: input.sequenceKey, count: enrollments.length },
  });
  return { ok: true, updated: enrollments.length };
}

export async function listProjectSequenceEnrollments(projectId: string) {
  const enrollments = await db.query.sequenceEnrollments.findMany({
    where: eq(sequenceEnrollments.projectId, projectId),
    orderBy: [desc(sequenceEnrollments.enrolledAt)],
  });
  const result = [] as Array<{ enrollment: SequenceEnrollment; lastStep: string | null }>;
  for (const enrollment of enrollments) {
    const last = await db.query.sequenceSends.findFirst({
      where: and(eq(sequenceSends.projectId, projectId), eq(sequenceSends.sequenceKey, enrollment.sequenceKey)),
      orderBy: [desc(sequenceSends.firedAt)],
    });
    result.push({ enrollment, lastStep: last?.stepKey ?? null });
  }
  return result;
}

// -------------------------- Admin send of a sequence draft -----------------

export type SendSequenceDraftResult =
  | { ok: true; communicationId: string }
  | { ok: false; reason: "not_found" | "not_sequence_email" | "not_draft" | "suppressed" | "send_failed"; message: string };

/** Defence-in-depth at the send boundary (§2.1): the admin action that sends a
 * queued `sequence_step` email draft RE-CHECKS suppression and REFUSES (no Resend
 * call) if the recipient is suppressed — so a draft that slipped past the
 * unsubscribe void step (or a race) can never go out. */
export async function sendSequenceEmailDraft(input: {
  projectId: string;
  communicationId: string;
  actorName?: string;
}): Promise<SendSequenceDraftResult> {
  const communication = await db.query.projectCommunications.findFirst({
    where: and(eq(projectCommunications.id, input.communicationId), eq(projectCommunications.projectId, input.projectId)),
  });
  if (!communication) return { ok: false, reason: "not_found", message: "Sequence draft not found." };
  if (communication.channel !== "email" || communication.sourceType !== "sequence_step") {
    return { ok: false, reason: "not_sequence_email", message: "This is not a sequence email draft." };
  }
  if (communication.status !== "draft" || communication.direction !== "outbound") {
    return { ok: false, reason: "not_draft", message: "Only an unsent outbound sequence draft can be sent." };
  }
  const email = communication.recipientEmail;
  if (!email) return { ok: false, reason: "send_failed", message: "The draft has no recipient email." };

  if (await isEmailSuppressed(email)) {
    await logActivity({
      projectId: input.projectId,
      clientId: communication.clientId,
      action: "sequence.email_send_refused",
      actorType: "admin",
      actorName: input.actorName || "Tyler",
      metadata: { communicationId: communication.id, reason: "suppressed" },
    });
    return { ok: false, reason: "suppressed", message: "This recipient has unsubscribed from automated emails." };
  }

  const result = await sendSequenceEmail({
    to: email,
    subject: communication.subject ?? "",
    text: communication.body,
    purpose: "sequences",
  });
  if (!result.ok) {
    return { ok: false, reason: "send_failed", message: `Send did not complete (${result.reason}).` };
  }
  const now = new Date().toISOString();
  await db
    .update(projectCommunications)
    .set({ status: "sent", sentAt: now, updatedAt: now })
    .where(eq(projectCommunications.id, communication.id));
  await logActivity({
    projectId: input.projectId,
    clientId: communication.clientId,
    action: "sequence.email_sent_by_admin",
    actorType: "admin",
    actorName: input.actorName || "Tyler",
    metadata: { communicationId: communication.id },
  });
  return { ok: true, communicationId: communication.id };
}
