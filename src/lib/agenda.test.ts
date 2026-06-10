import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agenda-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getAgenda } = await import("./agenda");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (
      id, name, type, stage, status, event_date, venue_name, city, state, created_at, updated_at
    ) VALUES (
      'project-1', 'Alex Wedding', 'wedding', 'planning', 'active', '2026-06-20',
      'River House', 'Charleston', 'SC', ?, ?
    ), (
      'project-2', 'Morgan Wedding', 'wedding', 'planning', 'active', '2026-07-04',
      'Garden Hall', 'Savannah', 'GA', ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_events (
      id, project_id, type, title, event_date, venue_name, city, state, calendar_sync_status, created_at, updated_at
    ) VALUES (
      'event-engagement', 'project-1', 'engagement', 'Engagement session',
      '2026-05-30', 'Downtown', 'Charleston', 'SC', 'not_connected', ?, ?
    ), (
      'event-wedding', 'project-1', 'wedding', 'Wedding Day',
      '2026-06-20', 'River House Ceremony Lawn', 'Charleston', 'SC', 'synced', ?, ?
    ), (
      'event-past', 'project-1', 'rehearsal', 'Past rehearsal',
      '2026-05-01', 'River House', 'Charleston', 'SC', 'not_connected', ?, ?
    )
  `).run(now, now, now, now, now, now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, created_at, updated_at
    ) VALUES ('meeting-1', 'discovery', 'Discovery Call', 30, 15, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, client_id, attendee_name, attendee_email,
      start_at, end_at, status, source, cancelled_at, calendar_sync_status, created_at, updated_at
    ) VALUES (
      'booking-1', 'meeting-1', 'project-1', 'client-1', 'Alex Taylor', 'alex@example.com',
      '2026-05-31T14:00:00.000Z', '2026-05-31T14:30:00.000Z', 'confirmed', 'booking_link',
      NULL, 'synced', ?, ?
    ), (
      'booking-cancelled', 'meeting-1', 'project-1', 'client-1', 'Alex Taylor', 'alex@example.com',
      '2026-06-01T14:00:00.000Z', '2026-06-01T14:30:00.000Z', 'cancelled', 'booking_link',
      '2026-05-29T13:00:00.000Z', 'not_connected', ?, ?
    )
  `).run(now, now, now, now);

  const agenda = await getAgenda({
    fromDate: "2026-05-29",
    toDate: "2026-07-10",
    timeZone: "America/New_York",
  });

  assert.deepEqual(agenda.items.map((item) => ({
    id: item.id,
    category: item.category,
    kind: item.kind,
    date: item.date,
    time: item.time,
    title: item.title,
    projectName: item.projectName,
    clientName: item.clientName,
    venueLabel: item.venueLabel,
    calendarSyncStatus: item.calendarSyncStatus,
    href: item.href,
  })), [
    {
      id: "event-engagement",
      category: "engagement",
      kind: "session",
      date: "2026-05-30",
      time: null,
      title: "Engagement session",
      projectName: "Alex Wedding",
      clientName: "Alex Taylor",
      venueLabel: "Downtown, Charleston, SC",
      calendarSyncStatus: "not_connected",
      href: "/projects/project-1#events",
    },
    {
      id: "booking-1",
      category: "call",
      kind: "call",
      date: "2026-05-31",
      time: "10:00 AM",
      title: "Discovery Call",
      projectName: "Alex Wedding",
      clientName: "Alex Taylor",
      venueLabel: null,
      calendarSyncStatus: "synced",
      href: "/scheduler/bookings/booking-1",
    },
    {
      id: "event-wedding",
      category: "wedding",
      kind: "session",
      date: "2026-06-20",
      time: null,
      title: "Wedding Day",
      projectName: "Alex Wedding",
      clientName: "Alex Taylor",
      venueLabel: "River House Ceremony Lawn, Charleston, SC",
      calendarSyncStatus: "synced",
      href: "/projects/project-1#events",
    },
    {
      id: "project-2:wedding",
      category: "wedding",
      kind: "session",
      date: "2026-07-04",
      time: null,
      title: "Wedding Day",
      projectName: "Morgan Wedding",
      clientName: null,
      venueLabel: "Garden Hall, Savannah, GA",
      calendarSyncStatus: "not_connected",
      href: "/projects/project-2",
    },
  ]);

  const callsOnly = await getAgenda({
    fromDate: "2026-05-29",
    toDate: "2026-07-10",
    types: ["call"],
    timeZone: "America/New_York",
  });
  assert.deepEqual(callsOnly.items.map((item) => item.id), ["booking-1"]);

  console.log("agenda tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
