import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-scheduler-reminders-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
delete process.env.RESEND_API_KEY;

function insertBooking(
  database: ReturnType<typeof import("@/db/client").rawDb>,
  input: {
    id: string;
    meetingTypeId: string;
    startAt: string;
    endAt: string;
    status?: string;
    reminderSentAt?: string | null;
  },
  now: string,
) {
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, attendee_name, attendee_email,
      start_at, end_at, status, source, reminder_sent_at, created_at, updated_at
    ) VALUES (?, ?, 'Alex Reed', 'alex@example.com', ?, ?, ?, 'booking_link', ?, ?, ?)
  `).run(
    input.id,
    input.meetingTypeId,
    input.startAt,
    input.endAt,
    input.status ?? "confirmed",
    input.reminderSentAt ?? null,
    now,
    now,
  );
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { sendDueSchedulerReminders } = await import("./scheduler");
  const database = rawDb();
  const now = new Date("2026-06-01T12:00:00.000Z");
  const seedTime = now.toISOString();

  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, collect_payment, price_cents,
      stripe_payment_link, created_at, updated_at
    ) VALUES (
      'meeting-1', 'discovery-call', 'Discovery Call', 45, 15, 0, 0,
      NULL, ?, ?
    )
  `).run(seedTime, seedTime);

  insertBooking(database, {
    id: "booking-due",
    meetingTypeId: "meeting-1",
    startAt: "2026-06-02T10:00:00.000Z",
    endAt: "2026-06-02T10:45:00.000Z",
  }, seedTime);
  insertBooking(database, {
    id: "booking-outside-window",
    meetingTypeId: "meeting-1",
    startAt: "2026-06-05T10:00:00.000Z",
    endAt: "2026-06-05T10:45:00.000Z",
  }, seedTime);
  insertBooking(database, {
    id: "booking-already-reminded",
    meetingTypeId: "meeting-1",
    startAt: "2026-06-02T11:00:00.000Z",
    endAt: "2026-06-02T11:45:00.000Z",
    reminderSentAt: "2026-05-31T12:00:00.000Z",
  }, seedTime);
  insertBooking(database, {
    id: "booking-cancelled",
    meetingTypeId: "meeting-1",
    startAt: "2026-06-02T11:30:00.000Z",
    endAt: "2026-06-02T12:15:00.000Z",
    status: "cancelled",
  }, seedTime);

  const withoutProvider = await sendDueSchedulerReminders(now);
  // Phase 21: extended return {checked, due, sent, failed}. With RESEND unset the one eligible
  // booking is attempted (due:1) and returns delivered:false (failed:1, sent:0).
  assert.deepEqual(withoutProvider, { checked: 2, due: 1, sent: 0, failed: 1 });
  assert.deepEqual(database.prepare(`
    SELECT id, reminder_sent_at
    FROM scheduler_bookings
    WHERE id IN ('booking-due', 'booking-already-reminded')
    ORDER BY id
  `).all(), [
    { id: "booking-already-reminded", reminder_sent_at: "2026-05-31T12:00:00.000Z" },
    { id: "booking-due", reminder_sent_at: null },
  ]);

  const originalFetch = global.fetch;
  process.env.RESEND_API_KEY = "test-key";
  global.fetch = async () => new Response(null, { status: 200 });
  try {
    const withProvider = await sendDueSchedulerReminders(now);
    assert.deepEqual(withProvider, { checked: 2, due: 1, sent: 1, failed: 0 });
    assert.equal(
      database.prepare("SELECT reminder_sent_at FROM scheduler_bookings WHERE id = 'booking-due'").get()?.reminder_sent_at,
      now.toISOString(),
    );
    assert.equal(
      database.prepare("SELECT reminder_sent_at FROM scheduler_bookings WHERE id = 'booking-already-reminded'").get()?.reminder_sent_at,
      "2026-05-31T12:00:00.000Z",
    );
    assert.equal(
      database.prepare("SELECT reminder_sent_at FROM scheduler_bookings WHERE id = 'booking-cancelled'").get()?.reminder_sent_at,
      null,
    );
  } finally {
    global.fetch = originalFetch;
    delete process.env.RESEND_API_KEY;
  }

  console.log("scheduler reminder tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});