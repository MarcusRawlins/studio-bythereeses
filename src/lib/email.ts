import type { SchedulerBooking, SchedulerMeetingType } from "@/db/schema";

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

async function sendResendEmail(input: {
  to: string | string[];
  subject: string;
  text: string;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

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
    }),
  });

  return response.ok;
}

export async function sendBookingEmails({ booking, meetingType, manageUrl, rescheduleUrl }: BookingEmailInput) {
  const when = formatDateTime(booking.startAt);
  const location = meetingType.locationLabel || "Zoom";
  const confirmation = meetingType.confirmationMessage || `Your ${meetingType.name.toLowerCase()} is confirmed.`;
  const adminEmail = process.env.SCHEDULER_ADMIN_EMAIL || "hello@bythereeses.com";

  const clientText = [
    `Hi ${booking.attendeeName},`,
    "",
    confirmation,
    "",
    `Event: ${meetingType.name}`,
    `When: ${when}`,
    `Location: ${location}`,
    meetingType.zoomJoinUrl ? `Zoom: ${meetingType.zoomJoinUrl}` : null,
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

  await sendResendEmail({
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
