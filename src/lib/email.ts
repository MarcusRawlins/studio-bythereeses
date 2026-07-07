import { db } from "@/db/client";
import { emailSuppressions } from "@/db/schema";
import type { SchedulerBooking, SchedulerMeetingType } from "@/db/schema";
import { signUnsubscribeToken, unsubscribeBaseUrl } from "@/lib/unsubscribe-token";
import { eq } from "drizzle-orm";

type BookingEmailInput = {
  booking: SchedulerBooking;
  meetingType: SchedulerMeetingType;
  manageUrl?: string;
  rescheduleUrl?: string;
};

function formatDateTime(value: string, timeZone = "America/New_York") {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

// Low-level Resend request. Returns the delivery flag AND the HTTP status so
// callers that need to CLASSIFY a failure (sequence auto-send: provably-not-sent
// 4xx vs ambiguous 5xx/network) can do so. A network error THROWS (the caller
// treats a throw as terminal-unknown). No API key → not delivered, status null.
// The optional `headers` map is forwarded to Resend's `headers` field (used for
// RFC 8058 List-Unsubscribe on sequence email).
async function resendRequest(input: {
  to: string | string[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
  // Phase 14: optional Reply-To (carries the signed project-reply token so a
  // client reply routes back to the right project thread). Omitted entirely when
  // undefined — never an empty-tag bouncing address.
  replyTo?: string;
}): Promise<{ delivered: boolean; status: number | null; providerMessageId: string | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { delivered: false, status: null, providerMessageId: null };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || "The Reeses <hello@bythereeses.com>",
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    }),
  });

  // Capture the Resend message id on success. Existing callers ignore this field
  // (no behavior change to booking/sequence/magic-link mail).
  let providerMessageId: string | null = null;
  if (response.ok) {
    try {
      const body = (await response.json()) as { id?: unknown };
      if (typeof body?.id === "string" && body.id) providerMessageId = body.id;
    } catch {
      providerMessageId = null;
    }
  }

  return { delivered: response.ok, status: response.status, providerMessageId };
}

// Phase 14: the SINGLE Resend entry the project-thread send uses. Transport only
// — suppression/consent/flag/hash gating all live in `sendApprovedProjectEmail`
// (like SMS keeps consent in the lib). Returns the delivery flag, the HTTP status
// (so the caller can classify 4xx-rejected vs 5xx/network-unknown, mirroring
// `sendSequenceEmail`), and the captured Resend message id.
export async function sendProjectEmail(input: {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}): Promise<{ delivered: boolean; status: number | null; providerMessageId: string | null }> {
  return resendRequest({ to: input.to, subject: input.subject, text: input.text, replyTo: input.replyTo });
}

async function sendResendEmail(input: {
  to: string | string[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
}) {
  const result = await resendRequest(input);
  return result.delivered;
}

// ---------------------------------------------------------------------------
// Phase 8c — consent-gated sequence email sender (the ONLY email path that
// carries a one-click unsubscribe). Transactional booking mail is unchanged.
//
// Ordering: (1) lowercase recipient + consult email_suppressions — a suppressed
// address REFUSES with no Resend call and no false success; (2) attach RFC 8058
// List-Unsubscribe + List-Unsubscribe-Post headers (signed stateless token) plus
// a visible footer; (3) send and classify the outcome so the sequence runner's
// crash-safe ledger stays strictly toward under-send:
//   ok        → Resend accepted → ledger "done".
//   suppressed→ provably not sent → ledger "failed" (retryable).
//   rejected  → definitive pre-acceptance 4xx → provably not sent → "failed".
//   unknown   → thrown/network/5xx AFTER dispatch → Resend MAY have accepted →
//               ledger stays "claimed" (terminal-unknown, never auto-retried).
// ---------------------------------------------------------------------------
export type SequenceEmailResult =
  | { ok: true }
  | { ok: false; reason: "suppressed" }
  | { ok: false; reason: "rejected" }
  | { ok: false; reason: "unknown" };

export async function isEmailSuppressed(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  const row = await db.query.emailSuppressions.findFirst({ where: eq(emailSuppressions.email, normalized) });
  return Boolean(row);
}

export async function sendSequenceEmail(input: {
  to: string;
  subject: string;
  text: string;
  purpose?: string;
}): Promise<SequenceEmailResult> {
  const to = input.to.trim().toLowerCase();
  if (!to) return { ok: false, reason: "rejected" };

  // 1. Suppression gate — before any Resend call, no false success.
  if (await isEmailSuppressed(to)) return { ok: false, reason: "suppressed" };

  // 2. RFC 8058 one-click unsubscribe headers + visible footer.
  const purpose = input.purpose ?? "sequences";
  const token = signUnsubscribeToken(to, purpose);
  const link = `${unsubscribeBaseUrl()}/api/email/unsubscribe?t=${encodeURIComponent(token)}`;
  const mailto = `mailto:${process.env.RESEND_UNSUBSCRIBE_MAILBOX || "unsubscribe@bythereeses.com"}?subject=unsubscribe`;
  const headers: Record<string, string> = {
    "List-Unsubscribe": `<${link}>, <${mailto}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
  const text = `${input.text}\n\n—\nTo stop these automated emails, unsubscribe here: ${link}`;

  // 3. Send + classify.
  let result: { delivered: boolean; status: number | null };
  try {
    result = await resendRequest({ to, subject: input.subject, text, headers });
  } catch {
    return { ok: false, reason: "unknown" }; // thrown after dispatch — terminal unknown
  }
  if (result.delivered) return { ok: true };
  if (result.status !== null && result.status >= 400 && result.status < 500) {
    return { ok: false, reason: "rejected" }; // provably not accepted
  }
  return { ok: false, reason: "unknown" }; // 5xx or no-key — ambiguous, never auto-retry
}

// Phase 21 — owner-only ops alert sender (the daily digest + immediate critical email). The
// recipient is ALWAYS process.env.ALERT_EMAIL (Tyler's OWN address) — a FIXED config value,
// NEVER anything derived from client data. This is the structural guarantee that the monitor
// cannot email a client or leak data outward. No List-Unsubscribe footer (transactional ops
// mail to the owner, not bulk marketing). Fail-closed on config: ALERT_EMAIL unset → return
// false + no send (the digest is considered un-wired until Tyler sets it). Uses the private
// resendRequest, which returns false (never throws) when RESEND_API_KEY is unset.
export async function sendAdminAlertEmail(input: { subject: string; text: string }): Promise<boolean> {
  const to = process.env.ALERT_EMAIL?.trim();
  if (!to) return false; // fail-closed: no owner address configured → no send, no false success.
  try {
    const result = await resendRequest({ to, subject: input.subject, text: input.text });
    return result.delivered;
  } catch {
    return false; // thrown after dispatch — treat as not-delivered (never a false success).
  }
}

// Phase 6.5: self-service portal magic-link email. One email per request
// regardless of project count; the body lists a "View {project}" link per
// active project. Reuses the private Resend sender (returns false, never throws,
// when RESEND_API_KEY is unset) and is fire-and-forget relative to the HTTP
// response.
export async function sendPortalMagicLinkEmail(input: {
  to: string;
  clientFirstName: string | null;
  links: Array<{ projectName: string; url: string }>;
  ttlMinutes: number;
}): Promise<boolean> {
  const greetingName = input.clientFirstName?.trim() || "there";
  const text = [
    `Hi ${greetingName},`,
    "",
    "Here's your secure sign-in link for The Reeses client portal.",
    "",
    ...input.links.map((link) => `  View ${link.projectName}: ${link.url}`),
    "",
    `This link expires in ${input.ttlMinutes} minutes and can be used once. If you didn't`,
    "request it, you can ignore this email — no one can access your portal without it.",
    "",
    "The Reeses Studio",
  ].join("\n");

  return sendResendEmail({
    to: input.to,
    subject: "Your Reese Photography portal sign-in link",
    text,
  });
}

export async function sendBookingEmails({ booking, meetingType, manageUrl, rescheduleUrl }: BookingEmailInput) {
  const when = formatDateTime(booking.startAt);
  const location = meetingType.locationLabel || "Zoom";
  const confirmation = meetingType.confirmationMessage || `Your ${meetingType.name.toLowerCase()} is confirmed.`;
  const adminEmail = process.env.SCHEDULER_ADMIN_EMAIL || "hello@bythereeses.com";
  const joinLabel = meetingType.locationType === "google_meet" ? "Google Meet" : "Join";

  const clientText = [
    `Hi ${booking.attendeeName},`,
    "",
    confirmation,
    "",
    `Event: ${meetingType.name}`,
    `When: ${when}`,
    `Location: ${location}`,
    // CR-4 review fix: NEVER emit the static Zoom line for a google_meet type — a type converted
    // from Zoom can retain a stale zoomJoinUrl, and a client sent both links may join the old
    // Zoom room alone.
    meetingType.zoomJoinUrl && meetingType.locationType !== "google_meet" ? `Zoom: ${meetingType.zoomJoinUrl}` : null,
    booking.meetingJoinUrl ? `${joinLabel}: ${booking.meetingJoinUrl}` : null,
    rescheduleUrl ? `Reschedule: ${rescheduleUrl}` : null,
    manageUrl ? `Cancel or manage: ${manageUrl}` : null,
    "",
    "See you soon,",
    "The Reeses Studio",
  ].filter(Boolean).join("\n");

  const adminText = [
    "New scheduler booking",
    "",
    `Event: ${meetingType.name}`,
    `Name: ${booking.attendeeName}`,
    `Email: ${booking.attendeeEmail}`,
    booking.attendeePhone ? `Phone: ${booking.attendeePhone}` : null,
    `When: ${when}`,
    `Calendar sync: ${booking.calendarSyncStatus}`,
  ].filter(Boolean).join("\n");

  await Promise.allSettled([
    sendResendEmail({
      to: booking.attendeeEmail,
      subject: `Confirmed: ${meetingType.name}`,
      text: clientText,
    }),
    sendResendEmail({
      to: adminEmail,
      subject: `New booking: ${meetingType.name}`,
      text: adminText,
    }),
  ]);
}

export async function sendBookingReminderEmail({ booking, meetingType, manageUrl, rescheduleUrl }: BookingEmailInput) {
  const when = formatDateTime(booking.startAt);
  const location = meetingType.locationLabel || "Zoom";
  const joinLabel = meetingType.locationType === "google_meet" ? "Google Meet" : "Join";

  return sendResendEmail({
    to: booking.attendeeEmail,
    subject: `Reminder: ${meetingType.name}`,
    text: [
      `Hi ${booking.attendeeName},`,
      "",
      `A quick reminder that your ${meetingType.name.toLowerCase()} is coming up.`,
      "",
      `When: ${when}`,
      `Location: ${location}`,
      meetingType.zoomJoinUrl ? `Zoom: ${meetingType.zoomJoinUrl}` : null,
      booking.meetingJoinUrl ? `${joinLabel}: ${booking.meetingJoinUrl}` : null,
      rescheduleUrl ? `Reschedule: ${rescheduleUrl}` : null,
      manageUrl ? `Cancel or manage: ${manageUrl}` : null,
      "",
      "The Reeses Studio",
    ].filter(Boolean).join("\n"),
  });
}

export async function sendBookingCancellationEmail({ booking, meetingType }: BookingEmailInput) {
  await Promise.allSettled([
    sendResendEmail({
      to: booking.attendeeEmail,
      subject: `Cancelled: ${meetingType.name}`,
      text: [
        `Hi ${booking.attendeeName},`,
        "",
        `Your ${meetingType.name.toLowerCase()} has been cancelled.`,
        "",
        "The Reeses Studio",
      ].join("\n"),
    }),
    sendResendEmail({
      to: process.env.SCHEDULER_ADMIN_EMAIL || "hello@bythereeses.com",
      subject: `Cancelled booking: ${meetingType.name}`,
      text: [
        "Scheduler booking cancelled",
        "",
        `Event: ${meetingType.name}`,
        `Name: ${booking.attendeeName}`,
        `Email: ${booking.attendeeEmail}`,
        `When: ${whenSafe(booking.startAt)}`,
      ].join("\n"),
    }),
  ]);
}

function whenSafe(value: string) {
  try {
    return formatDateTime(value);
  } catch {
    return value;
  }
}
