import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { formatDate } from "@/lib/format";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: ProjectDetailPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?),
      ('client-2', 'Jordan', 'Taylor', 'jordan@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, notes, created_at, updated_at)
    VALUES (
      'project-1', 'Alex Wedding', 'wedding', 'planning', 'active', '2026-09-19',
      'Imported from HoneyBook on 2026-05-12. HoneyBook project: Alex Wedding. Lead date: 2025-03-11.',
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-1', 'project-1', 'client-1', 'primary', 1, ?),
      ('participant-2', 'project-1', 'client-2', 'partner', 0, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_amount_cents, created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-PROJECT-FEE', 'partially_paid', 900000, 300000,
      'client_pays', 26130, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-1', 'invoice-1', 'Retainer', 300000, '2026-06-01', 'paid',
      '2026-06-02T10:00:00.000Z', 'stripe',
      300000, 8730, 8730, 308730,
      300000, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO vendors (id, name, normalized_name, created_at, updated_at)
    VALUES ('vendor-1', 'Second Shooter Co', 'second shooter co', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO expenses (
      id, vendor_id, project_id, category, description, amount_cents, status, paid_at,
      payment_method, tax_deductible, created_at, updated_at
    ) VALUES (
      'expense-unpaid', 'vendor-1', 'project-1', 'contractor', 'Second shooter balance',
      40000, 'unpaid', '2026-06-10', 'ach', 1, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, source_type, source_id,
      created_at, updated_at
    ) VALUES (
      'source-discovery-1', 'project-1', 'discovery_call', 'Discovery call with Alex and Jordan',
      'Transcript notes for proposal and timeline generation.',
      'Source for proposal and timeline drafting.', 'Studio UI', 'studio_project', 'manual-discovery-1',
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_locations (
      id, project_id, type, name, address, city, state, source_type, source_id, created_at, updated_at
    ) VALUES (
      'location-ceremony-1', 'project-1', 'ceremony', 'Garden Lawn',
      '123 Garden Lane', 'Hudson', 'NY', 'questionnaire_response', 'response-1', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_events (
      id, project_id, type, title, event_date, venue_name, notes,
      source_type, source_id, calendar_sync_status, created_at, updated_at
    ) VALUES (
      'event-wedding-1', 'project-1', 'wedding', 'Wedding day', '2026-09-19',
      'Garden House', 'Ceremony begins at 4:30 PM. Reception flow includes toasts and first dance.',
      'questionnaire_response', 'response-1', 'needs_google_connection', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaires (
      id, title, description, status, created_at, updated_at
    ) VALUES (
      'questionnaire-1', 'Photography Timeline & Vision Questionnaire',
      'Timeline and planning details.', 'active', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaire_responses (
      id, questionnaire_id, project_id, client_id, respondent_name, respondent_email,
      submitted_at, answers_json, created_at, updated_at
    ) VALUES (
      'response-1', 'questionnaire-1', 'project-1', 'client-1', 'Alex Taylor',
      'alex@example.com', '2026-06-16T14:30:00.000Z', '[]', ?, ?
    )
  `).run(now, now);

  // Phase 7a: one safe gallery + one hand-seeded UNSAFE row (a non-https url
  // that could only exist via a direct D1 edit, bypassing normalizeGalleryUrl)
  // to exercise the admin belt-and-suspenders isGalleryUrlSafe re-check.
  database.prepare(`
    INSERT INTO project_galleries (
      id, project_id, provider, title, url, status, passcode, delivered_at, expires_at, created_by, created_at, updated_at
    ) VALUES
      ('gallery-safe', 'project-1', 'Pixieset', 'Safe wedding gallery', 'https://client.pixieset.com/wedding', 'delivered', NULL, ?, NULL, 'admin', ?, ?),
      ('gallery-unsafe', 'project-1', 'Custom', 'Hand-edited unsafe gallery', 'javascript:alert(document.cookie)', 'draft', NULL, NULL, NULL, 'admin', ?, ?)
  `).run(now, now, now, now, now);

  const markup = renderToStaticMarkup(await ProjectDetailPage({
    params: Promise.resolve({ id: "project-1" }),
    searchParams: Promise.resolve({}),
  }));

  // The safe gallery renders a clickable "Open gallery" anchor.
  assert.match(markup, /href="https:\/\/client\.pixieset\.com\/wedding"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  // The unsafe (hand-edited) gallery must NOT render a clickable href — the
  // url only appears as inert, escaped, non-anchor text.
  assert.doesNotMatch(markup, /href="javascript:/i);
  assert.match(markup, /Unsafe gallery URL \(not shown as a link\)/);

  assert.match(markup, /INV-PROJECT-FEE/);
  assert.match(markup, /\$6,174 balance/);
  assert.match(markup, /Accounts payable/);
  assert.match(markup, /\$400/);
  assert.match(markup, /Primary client/);
  assert.match(markup, /action="\/api\/projects\/project-1\/primary-client"/);
  assert.match(markup, /Jordan Taylor · partner/);
  assert.match(markup, /Discovery call with Alex and Jordan/);
  assert.match(markup, /No working notes yet/);
  assert.doesNotMatch(markup, /Imported from HoneyBook on 2026-05-12/);
  assert.match(markup, /Day-of locations/);
  assert.match(markup, /Garden Lawn/);
  assert.match(markup, /123 Garden Lane/);
  assert.match(markup, /Calendar dates/);
  assert.match(markup, /Dates that belong on the calendar/);
  assert.match(markup, /Ceremony begins at 4:30 PM/);
  assert.match(markup, /Locations &amp; logistics/);
  assert.match(markup, /Questionnaire answers can fill these in automatically/);
  assert.match(markup, /Responses for this project/);
  assert.match(markup, /Photography Timeline &amp; Vision Questionnaire/);
  assert.match(markup, /View responses/);
  assert.match(markup, /href="\/questionnaires\/questionnaire-1\/responses\/response-1"/);
  assert.doesNotMatch(markup, /href="\/questionnaires\/questionnaire-1\/responses\/response-1\/edit"/);
  assert.match(markup, /Evidence the Studio can cite/);
  assert.match(markup, /Tasks land in the Inbox/);
  assert.match(markup, /Create proposal task/);
  assert.match(markup, /Create timeline draft/);
  assert.match(markup, /Create invoice task/);
  assert.match(markup, /Create expense task/);
  assert.match(markup, /Create follow-up task/);
  assert.match(markup, /name="projectSourceId" value="source-discovery-1"/);
  assert.match(markup, /name="assignedAgent" value="Proposal Agent"/);
  assert.match(markup, /name="assignedAgent" value="Timeline Agent"/);
  assert.match(markup, /name="runTimelineDraft" value="1"/);
  assert.match(markup, /name="assignedAgent" value="Billing Agent"/);
  assert.match(markup, /name="assignedAgent" value="Bookkeeping Agent"/);
  assert.match(markup, /name="assignedAgent" value="Communications Agent"/);
  assert.match(markup, /Create proposal from Discovery call with Alex and Jordan/);
  assert.match(markup, /Create timeline from Discovery call with Alex and Jordan/);
  assert.match(markup, /Create invoice from Discovery call with Alex and Jordan/);
  assert.match(markup, /Create expense from Discovery call with Alex and Jordan/);
  assert.match(markup, /Create follow-up from Discovery call with Alex and Jordan/);
  assert.match(markup, /Studio workflow/);
  assert.match(markup, /Configure project workflow/);
  assert.doesNotMatch(markup, /Six Figure/);
  assert.match(renderToStaticMarkup(await ProjectDetailPage({
    params: Promise.resolve({ id: "project-1" }),
    searchParams: Promise.resolve({ saved: "location" }),
  })), /Project location saved/);

  await assert.rejects(
    () => ProjectDetailPage({
      params: Promise.resolve({ id: "seed-project-alex-taylor-wedding" }),
      searchParams: Promise.resolve({}),
    }),
    (error) => {
      assert.match(error instanceof Error ? error.message : String(error), /NEXT_REDIRECT/);
      assert.match((error as { digest?: string }).digest ?? "", /;\/projects\?pageSize=200;/);
      assert.doesNotMatch((error as { digest?: string }).digest ?? "", /seed-data-removed/);
      return true;
    },
  );

  // =============================================================================================
  // Phase 20 (meeting/consult notes) — Tests 9-12, 18. MEETING_NOTES_ENABLED stays unset by
  // default in this process, so everything up to this point already proves flag-off purity: no
  // fixture above ever produced "Meeting note"/"Meeting:" markup. This section makes that explicit,
  // then exercises the flag-on composer and badge behavior.
  // =============================================================================================
  assert.equal(process.env.MEETING_NOTES_ENABLED, undefined, "meeting notes flag must be unset for the flag-off assertions below");

  database.prepare(`
    INSERT INTO scheduler_meeting_types (id, slug, name, duration_minutes, buffer_minutes, created_at, updated_at)
    VALUES ('meeting-type-notes-1', 'notes-consult', 'Discovery Call', 30, 15, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, status, attendee_name, attendee_email, start_at, end_at, created_at, updated_at
    ) VALUES
      ('booking-notes-confirmed', 'meeting-type-notes-1', 'project-1', 'confirmed', 'Alex Taylor', 'alex@example.com',
       '2026-06-20T15:00:00.000Z', '2026-06-20T15:30:00.000Z', ?, ?),
      ('booking-notes-cancelled', 'meeting-type-notes-1', 'project-1', 'cancelled', 'Alex Taylor', 'alex@example.com',
       '2026-06-25T15:00:00.000Z', '2026-06-25T15:30:00.000Z', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_communications (
      id, project_id, direction, channel, status, body, booking_id, created_by, created_at, updated_at
    ) VALUES (
      'communication-notes-linked', 'project-1', 'internal', 'note', 'draft',
      'Discussed venue logistics.', 'booking-notes-confirmed', 'admin', ?, ?
    )
  `).run(now, now);

  // Test 9 — flag-off purity: with scheduler_bookings rows AND a booking-linked communication row
  // both present in the DB, the flag OFF still renders no "Meeting note" composer and no per-row
  // "Meeting:" badge (D6: both flags off ⇒ `bookings: []` ⇒ the composer/badge have nothing to key
  // off of, regardless of DB content) — the linked row's body still renders as a PLAIN communication
  // (unrelated to the badge), proving the flag gates only the Phase-20-specific additions.
  const flagOffMarkup = renderToStaticMarkup(await ProjectDetailPage({
    params: Promise.resolve({ id: "project-1" }),
    searchParams: Promise.resolve({}),
  }));
  assert.doesNotMatch(flagOffMarkup, /Meeting note/);
  assert.doesNotMatch(flagOffMarkup, /Meeting:/);
  assert.match(flagOffMarkup, /Discussed venue logistics\./, "the linked note's body still renders as a plain communication when the flag is off");
  console.log("test 9 (flag-off purity) passed");

  // ---------------------------------------------------------------------------------------------
  // Flip the flag on for the remaining tests.
  // ---------------------------------------------------------------------------------------------
  process.env.MEETING_NOTES_ENABLED = "1";

  // Test 10 — composer fields (channel=note, direction=internal, bookingId=<selected>, D5 template),
  // and the booking <select> excludes the cancelled booking (B-4) while data.bookings itself (not
  // directly inspectable from markup, but proven via crm.test.ts) stays unfiltered.
  const flagOnMarkup = renderToStaticMarkup(await ProjectDetailPage({
    params: Promise.resolve({ id: "project-1" }),
    searchParams: Promise.resolve({}),
  }));
  assert.match(flagOnMarkup, /Meeting note/);
  assert.match(flagOnMarkup, /<input[^>]*name="channel"[^>]*value="note"/);
  assert.match(flagOnMarkup, /<input[^>]*name="direction"[^>]*value="internal"/);
  assert.match(flagOnMarkup, /<select[^>]*name="bookingId"/);
  assert.match(flagOnMarkup, new RegExp(`Discovery Call · ${formatDate("2026-06-20T15:00:00.000Z")}`));
  assert.doesNotMatch(flagOnMarkup, new RegExp(`Discovery Call · ${formatDate("2026-06-25T15:00:00.000Z")}`), "the cancelled booking is excluded from the picker options (B-4)");
  assert.match(flagOnMarkup, /Discussed:/);
  assert.match(flagOnMarkup, /Decisions:/);
  assert.match(flagOnMarkup, /Follow-ups:/);
  console.log("test 10 (composer fields, cancelled excluded from picker) passed");

  // Test 12 — the booking-linked communication row (inserted above, for test 9) renders
  // "Meeting: {meetingName} · {date}" linking to the booking page, sourced from the already-loaded
  // data.bookings map (no extra query — proven separately in crm.test.ts's spy assertion).
  assert.match(
    flagOnMarkup,
    new RegExp(`Meeting:\\s*<a[^>]*href="/scheduler/bookings/booking-notes-confirmed"[^>]*>Discovery Call · ${formatDate("2026-06-20T15:00:00.000Z")}</a>`),
  );
  console.log("test 12 (booking-linked badge rendering) passed");

  // Test 18 — the badge survives the linked booking being cancelled LATER: data.bookings (and the
  // badge-labeling map built from it) stays unfiltered by status (only the composer's picker is
  // filtered, per B-4), so the badge keeps rendering.
  database.prepare(`UPDATE scheduler_bookings SET status = 'cancelled' WHERE id = 'booking-notes-confirmed'`).run();
  const badgeAfterCancellationMarkup = renderToStaticMarkup(await ProjectDetailPage({
    params: Promise.resolve({ id: "project-1" }),
    searchParams: Promise.resolve({}),
  }));
  assert.match(
    badgeAfterCancellationMarkup,
    new RegExp(`Meeting:\\s*<a[^>]*href="/scheduler/bookings/booking-notes-confirmed"[^>]*>Discovery Call · ${formatDate("2026-06-20T15:00:00.000Z")}</a>`),
    "a note linked to a since-cancelled booking still renders its badge (B-4/test 18)",
  );
  console.log("test 18 (badge survives later cancellation) passed");

  // Test 11 — composer hidden with zero linkable bookings: a project with NO bookings at all, and
  // a project with bookings that are ALL cancelled, both render no "Meeting note" composer.
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-notes-empty', 'Sam', 'Reese', 'sam@example.com', ?, ?), ('client-notes-allcancelled', 'Riley', 'Reese', 'riley@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-notes-empty', 'No Bookings Wedding', 'wedding', 'inquiry', 'active', ?, ?),
      ('project-notes-allcancelled', 'All Cancelled Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-notes-empty', 'project-notes-empty', 'client-notes-empty', 'primary', 1, ?),
      ('participant-notes-allcancelled', 'project-notes-allcancelled', 'client-notes-allcancelled', 'primary', 1, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, status, attendee_name, attendee_email, start_at, end_at, created_at, updated_at
    ) VALUES (
      'booking-notes-only-cancelled', 'meeting-type-notes-1', 'project-notes-allcancelled', 'cancelled',
      'Riley Reese', 'riley@example.com', '2026-06-27T15:00:00.000Z', '2026-06-27T15:30:00.000Z', ?, ?
    )
  `).run(now, now);

  const emptyBookingsMarkup = renderToStaticMarkup(await ProjectDetailPage({
    params: Promise.resolve({ id: "project-notes-empty" }),
    searchParams: Promise.resolve({}),
  }));
  assert.doesNotMatch(emptyBookingsMarkup, /Meeting note/);

  const allCancelledBookingsMarkup = renderToStaticMarkup(await ProjectDetailPage({
    params: Promise.resolve({ id: "project-notes-allcancelled" }),
    searchParams: Promise.resolve({}),
  }));
  assert.doesNotMatch(allCancelledBookingsMarkup, /Meeting note/);
  console.log("test 11 (composer hidden with zero linkable bookings) passed");

  delete process.env.MEETING_NOTES_ENABLED;

  console.log("project detail page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
