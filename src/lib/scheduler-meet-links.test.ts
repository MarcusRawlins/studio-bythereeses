import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// CR-4: per-booking auto-generated Google Meet links, dark behind SCHEDULER_MEET_LINKS.
// Covers: (a) flag on + google_meet type creates a conferenceData request and persists
// the returned link; (b) a Google Calendar failure still books locally with the link
// left null; (c) flag off (or a non-google_meet type) is byte-identical to the existing
// zoom path, even when Google Calendar is otherwise connected; (d) confirmation email
// includes a Join line when the booking has a meetingJoinUrl, labeled "Google Meet" for
// the google_meet type and absent for the zoom path.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-scheduler-meet-links-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.GOOGLE_REFRESH_TOKEN = "test-refresh-token";
process.env.RESEND_API_KEY = "test-resend-key";

function makeGoogleFetchMock(eventsBehavior: "meet" | "plain" | "fail-response" | "throw") {
  const eventCalls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const resendCalls: Array<{ url: string; body: Record<string, unknown> | null }> = [];

  const fetchImpl = async (input: string | URL, init?: { body?: unknown }) => {
    const href = typeof input === "string" ? input : input.toString();

    if (href.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "test-access-token" }), { status: 200 });
    }
    if (href.includes("/freeBusy")) {
      return new Response(JSON.stringify({ calendars: {} }), { status: 200 });
    }
    if (href.includes("/calendars/") && href.includes("/events")) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      eventCalls.push({ url: href, body });
      if (eventsBehavior === "throw") throw new Error("simulated Google Calendar outage");
      if (eventsBehavior === "fail-response") return new Response(null, { status: 500 });
      const includeMeet = eventsBehavior === "meet";
      return new Response(JSON.stringify({
        id: "gcal-event-1",
        ...(includeMeet ? {
          hangoutLink: "https://meet.google.com/abc-defg-hij",
          conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] },
        } : {}),
      }), { status: 200 });
    }
    if (href.includes("api.resend.com/emails")) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      resendCalls.push({ url: href, body });
      return new Response(JSON.stringify({ id: "resend-1" }), { status: 200 });
    }

    throw new Error(`Unexpected fetch in test: ${href}`);
  };

  return { fetchImpl, eventCalls, resendCalls };
}

function bookingForm(input: { meetingTypeId: string; attendeeName: string; attendeeEmail: string; startAt: string; endAt: string }) {
  const formData = new FormData();
  formData.set("meetingTypeId", input.meetingTypeId);
  formData.set("attendeeName", input.attendeeName);
  formData.set("attendeeEmail", input.attendeeEmail);
  formData.set("startAt", input.startAt);
  formData.set("endAt", input.endAt);
  return formData;
}

async function main() {
  const { rawDb, db } = await import("@/db/client");
  const { schedulerBookings, schedulerMeetingTypes } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const {
    createSchedulerBookingFromForm,
    getAvailableBookingDates,
    getAvailableSlots,
  } = await import("./scheduler");
  const { sendBookingReminderEmail } = await import("./email");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  // Wide-open availability (every day, all day) so we can always find a bookable slot
  // regardless of when this test runs, without hand-computing slot math.
  const availabilityJson = JSON.stringify(
    [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: "00:00", end: "23:30" })),
  );
  database.prepare(`
    INSERT INTO scheduler_settings (
      id, timezone, booking_window_days, minimum_notice_minutes, availability_json,
      google_calendar_ids, google_create_calendar_id, created_at, updated_at
    ) VALUES (
      'default', 'America/New_York', 14, 0, ?, NULL, 'hello@bythereeses.com', ?, ?
    )
  `).run(availabilityJson, now, now);

  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, location_type, location_label,
      zoom_join_url, is_active, created_at, updated_at
    ) VALUES (
      'meeting-zoom', 'zoom-consult', 'Zoom Consult', 30, 10, 'zoom', 'Zoom',
      'https://zoom.us/j/555', 1, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, location_type, location_label,
      zoom_join_url, is_active, created_at, updated_at
    ) VALUES (
      'meeting-meet', 'meet-consult', 'Google Meet Consult', 30, 10, 'google_meet', 'Google Meet',
      NULL, 1, ?, ?
    )
  `).run(now, now);

  async function nextSlot(slug: string) {
    const [date] = await getAvailableBookingDates(slug);
    assert.ok(date, `expected an available date for ${slug}`);
    const [slot] = await getAvailableSlots(slug, date);
    assert.ok(slot, `expected an available slot for ${slug} on ${date}`);
    return slot;
  }

  // --- (c) flag OFF: zoom path is byte-identical, even with Google Calendar connected ---
  delete process.env.SCHEDULER_MEET_LINKS;
  {
    const mock = makeGoogleFetchMock("plain");
    const originalFetch = global.fetch;
    global.fetch = mock.fetchImpl as typeof fetch;
    try {
      const slot = await nextSlot("zoom-consult");
      const form = bookingForm({
        meetingTypeId: "meeting-zoom",
        attendeeName: "Casey Flag Off",
        attendeeEmail: "casey.flagoff@example.com",
        startAt: slot.startAt,
        endAt: slot.endAt,
      });
      await assert.rejects(() => createSchedulerBookingFromForm(form), /static generation store missing/);

      assert.equal(mock.eventCalls.length, 1, "expected exactly one Google Calendar event request");
      const [eventCall] = mock.eventCalls;
      assert.ok(!eventCall.url.includes("conferenceDataVersion"), "flag off must not request conferenceDataVersion");
      assert.equal(eventCall.body?.conferenceData, undefined, "flag off must not send conferenceData");
      assert.equal(eventCall.body?.location, "https://zoom.us/j/555", "flag off keeps the static zoom link as the event location");

      const row = database.prepare(`
        SELECT meeting_join_url, google_calendar_event_id, calendar_sync_status
        FROM scheduler_bookings WHERE attendee_email = 'casey.flagoff@example.com'
      `).get() as { meeting_join_url: string | null; google_calendar_event_id: string | null; calendar_sync_status: string };
      assert.equal(row.meeting_join_url, null, "flag off must never write meeting_join_url");
      assert.equal(row.google_calendar_event_id, "gcal-event-1");
      assert.equal(row.calendar_sync_status, "synced");

      assert.equal(mock.resendCalls.length, 2, "expected client + admin confirmation emails");
      const clientEmail = mock.resendCalls.find((call) => (call.body?.to as string) === "casey.flagoff@example.com");
      assert.ok(clientEmail, "expected a confirmation email to the attendee");
      const text = String(clientEmail!.body?.text ?? "");
      assert.match(text, /Zoom: https:\/\/zoom\.us\/j\/555/);
      assert.doesNotMatch(text, /Join:/);
      assert.doesNotMatch(text, /Google Meet:/);
    } finally {
      global.fetch = originalFetch;
    }
  }

  // --- (a) flag ON + google_meet type: conferenceData requested, link persisted ---
  process.env.SCHEDULER_MEET_LINKS = "1";
  let meetBookingEmail = "";
  {
    const mock = makeGoogleFetchMock("meet");
    const originalFetch = global.fetch;
    global.fetch = mock.fetchImpl as typeof fetch;
    try {
      const slot = await nextSlot("meet-consult");
      meetBookingEmail = "riley.meet@example.com";
      const form = bookingForm({
        meetingTypeId: "meeting-meet",
        attendeeName: "Riley Meet",
        attendeeEmail: meetBookingEmail,
        startAt: slot.startAt,
        endAt: slot.endAt,
      });
      await assert.rejects(() => createSchedulerBookingFromForm(form), /static generation store missing/);

      assert.equal(mock.eventCalls.length, 1);
      const [eventCall] = mock.eventCalls;
      assert.ok(eventCall.url.includes("conferenceDataVersion=1"), "flag on + google_meet must request conferenceDataVersion=1");
      assert.equal(
        (eventCall.body?.conferenceData as { createRequest?: { conferenceSolutionKey?: { type?: string } } } | undefined)
          ?.createRequest?.conferenceSolutionKey?.type,
        "hangoutsMeet",
      );
      assert.equal(eventCall.body?.location, undefined, "google_meet path must not pass a static zoom link as the event location");

      const row = database.prepare(`
        SELECT meeting_join_url, google_calendar_event_id, calendar_sync_status
        FROM scheduler_bookings WHERE attendee_email = ?
      `).get(meetBookingEmail) as { meeting_join_url: string | null; google_calendar_event_id: string | null; calendar_sync_status: string };
      assert.equal(row.meeting_join_url, "https://meet.google.com/abc-defg-hij");
      assert.equal(row.google_calendar_event_id, "gcal-event-1");
      assert.equal(row.calendar_sync_status, "synced");

      // (d) confirmation email includes a "Google Meet" join line for the google_meet type.
      const clientEmail = mock.resendCalls.find((call) => (call.body?.to as string) === meetBookingEmail);
      assert.ok(clientEmail, "expected a confirmation email to the attendee");
      const text = String(clientEmail!.body?.text ?? "");
      assert.match(text, /Google Meet: https:\/\/meet\.google\.com\/abc-defg-hij/);
    } finally {
      global.fetch = originalFetch;
    }
  }

  // (d) continued: the reminder email also threads the booking-level meetingJoinUrl.
  {
    const booking = await db.query.schedulerBookings.findFirst({
      where: eq(schedulerBookings.attendeeEmail, meetBookingEmail),
    });
    assert.ok(booking, "expected the google_meet booking to exist for the reminder check");
    const meetingType = await db.query.schedulerMeetingTypes.findFirst({
      where: eq(schedulerMeetingTypes.id, "meeting-meet"),
    });
    assert.ok(meetingType, "expected the google_meet meeting type to exist");

    const mock = makeGoogleFetchMock("meet");
    const originalFetch = global.fetch;
    global.fetch = mock.fetchImpl as typeof fetch;
    try {
      const delivered = await sendBookingReminderEmail({ booking: booking!, meetingType: meetingType! });
      assert.equal(delivered, true);
      assert.equal(mock.resendCalls.length, 1);
      const text = String(mock.resendCalls[0].body?.text ?? "");
      assert.match(text, /Google Meet: https:\/\/meet\.google\.com\/abc-defg-hij/);
    } finally {
      global.fetch = originalFetch;
    }
  }

  // --- (b) Google Calendar failure: booking still created, link stays null, sync_failed ---
  {
    const mock = makeGoogleFetchMock("throw");
    const originalFetch = global.fetch;
    global.fetch = mock.fetchImpl as typeof fetch;
    try {
      const slot = await nextSlot("meet-consult");
      const form = bookingForm({
        meetingTypeId: "meeting-meet",
        attendeeName: "Jordan Failure",
        attendeeEmail: "jordan.failure@example.com",
        startAt: slot.startAt,
        endAt: slot.endAt,
      });
      await assert.rejects(() => createSchedulerBookingFromForm(form), /static generation store missing/);

      const row = database.prepare(`
        SELECT meeting_join_url, google_calendar_event_id, calendar_sync_status
        FROM scheduler_bookings WHERE attendee_email = 'jordan.failure@example.com'
      `).get() as { meeting_join_url: string | null; google_calendar_event_id: string | null; calendar_sync_status: string };
      assert.equal(row.meeting_join_url, null, "a calendar failure must never leave a stray meeting_join_url");
      assert.equal(row.google_calendar_event_id, null);
      assert.equal(row.calendar_sync_status, "sync_failed");
    } finally {
      global.fetch = originalFetch;
    }
  }

  console.log("scheduler meet link tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
