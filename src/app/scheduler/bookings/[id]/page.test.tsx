import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-scheduler-booking-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: SchedulerBookingDetailPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Reed', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Paid Scheduler Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, collect_payment, price_cents,
      stripe_payment_link, created_at, updated_at
    ) VALUES (
      'meeting-1', 'paid-consult', 'Paid Consultation', 45, 15, 1, 25000,
      'https://pay.stripe.com/test_paid_consult', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, client_id, attendee_name, attendee_email,
      start_at, end_at, status, source, payment_status, payment_method, paid_at,
      paid_amount_cents, gross_collected_cents, net_deposit_cents, external_payment_id,
      payment_notes, created_at, updated_at
    ) VALUES (
      'booking-1', 'meeting-1', 'project-1', 'client-1', 'Alex Reed', 'alex@example.com',
      '2026-06-01T14:00:00.000Z', '2026-06-01T14:45:00.000Z', 'confirmed', 'booking_link',
      'paid', 'stripe', '2026-05-29T13:00:00.000Z', 25000, 25755, 25000,
      'pi_scheduler_page_123', 'Stripe payment evidence.', ?, ?
    )
  `).run(now, now);

  const markup = renderToStaticMarkup(await SchedulerBookingDetailPage({
    params: Promise.resolve({ id: "booking-1" }),
  }));

  assert.match(markup, /id="payment-booking-1"/);
  assert.match(markup, /Stripe payment evidence/);

  // =============================================================================================
  // Phase 20 (meeting/consult notes) — Tests 13-15.
  // =============================================================================================

  // Test 13 — flag-off purity: MEETING_NOTES_ENABLED unset ⇒ no "Meeting notes" section, and
  // getSchedulerBookingDetail issues only its pre-Phase-20 queries (spy assertion — no query
  // touches project_communications, which this function never queried before this phase).
  assert.equal(process.env.MEETING_NOTES_ENABLED, undefined, "meeting notes flag must be unset for the flag-off assertions below");
  assert.doesNotMatch(markup, /Meeting notes/);

  {
    const original = database.prepare.bind(database);
    let notesQueryCalls = 0;
    database.prepare = ((sql: string) => {
      if (sql.includes("project_communications")) notesQueryCalls += 1;
      return original(sql);
    }) as typeof database.prepare;
    renderToStaticMarkup(await SchedulerBookingDetailPage({ params: Promise.resolve({ id: "booking-1" }) }));
    database.prepare = original;
    assert.equal(notesQueryCalls, 0, "the notes query is never issued when MEETING_NOTES_ENABLED is off");
  }
  console.log("test 13 (flag-off purity) passed");

  // ---------------------------------------------------------------------------------------------
  // Flip the flag on for the remaining tests.
  // ---------------------------------------------------------------------------------------------
  process.env.MEETING_NOTES_ENABLED = "1";

  // Test 14 — flag on, unlinked booking (data.project null): the D7 hint renders, no compose form,
  // no notes list.
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, attendee_name, attendee_email, start_at, end_at, created_at, updated_at
    ) VALUES (
      'booking-unlinked', 'meeting-1', 'Sam Unlinked', 'sam@example.com',
      '2026-06-02T14:00:00.000Z', '2026-06-02T14:45:00.000Z', ?, ?
    )
  `).run(now, now);
  const unlinkedMarkup = renderToStaticMarkup(await SchedulerBookingDetailPage({
    params: Promise.resolve({ id: "booking-unlinked" }),
  }));
  assert.match(unlinkedMarkup, /Link this booking to a project to add meeting notes\./);
  assert.doesNotMatch(unlinkedMarkup, /name="body"/);
  console.log("test 14 (flag on, unlinked booking) passed");

  // Test 15 — flag on, linked booking (booking-1): lists this booking's notes newest-first; the
  // compose form posts projectId/bookingId pre-set from page data (no picker) plus the D5 template.
  database.prepare(`
    INSERT INTO project_communications (
      id, project_id, direction, channel, status, body, booking_id, created_by, created_at, updated_at
    ) VALUES
      ('note-older', 'project-1', 'internal', 'note', 'draft', 'Older meeting note body.', 'booking-1', 'admin', '2026-06-01T15:00:00.000Z', '2026-06-01T15:00:00.000Z'),
      ('note-newer', 'project-1', 'internal', 'note', 'draft', 'Newer meeting note body.', 'booking-1', 'admin', '2026-06-01T16:00:00.000Z', '2026-06-01T16:00:00.000Z')
  `).run();
  const linkedMarkup = renderToStaticMarkup(await SchedulerBookingDetailPage({
    params: Promise.resolve({ id: "booking-1" }),
  }));
  assert.match(linkedMarkup, /Meeting notes/);
  assert.match(linkedMarkup, /<input[^>]*name="projectId"[^>]*value="project-1"/);
  assert.match(linkedMarkup, /<input[^>]*name="bookingId"[^>]*value="booking-1"/);
  assert.match(linkedMarkup, /<input[^>]*name="channel"[^>]*value="note"/);
  assert.match(linkedMarkup, /<input[^>]*name="direction"[^>]*value="internal"/);
  assert.match(linkedMarkup, /Discussed:/);
  assert.match(linkedMarkup, /Decisions:/);
  assert.match(linkedMarkup, /Follow-ups:/);
  assert.match(linkedMarkup, /Newer meeting note body\./);
  assert.match(linkedMarkup, /Older meeting note body\./);
  assert.ok(
    linkedMarkup.indexOf("Newer meeting note body.") < linkedMarkup.indexOf("Older meeting note body."),
    "notes render newest-first",
  );
  console.log("test 15 (flag on, linked booking) passed");

  delete process.env.MEETING_NOTES_ENABLED;

  console.log("scheduler booking page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
