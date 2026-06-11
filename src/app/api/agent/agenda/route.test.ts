import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-agenda-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "agenda-token";

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
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
    )
  `).run(now, now, now, now);
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
    )
  `).run(now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blockedOrigin = await route.GET(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/agent/agenda", {
    headers: { authorization: "Bearer agenda-token" },
  }));
  assert.equal(blockedOrigin.status, 404);

  const unauthorized = await route.GET(new Request("https://studio.bythereeses.com/api/agent/agenda"));
  assert.equal(unauthorized.status, 401);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/agent/agenda?fromDate=2026-05-29&toDate=2026-07-10&types=wedding,call&limit=2&timeZone=America/New_York", {
    headers: {
      authorization: "Bearer agenda-token",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.agenda.items.map((item: {
    id: string;
    category: string;
    kind: string;
    date: string;
    time: string | null;
    title: string;
    projectName: string | null;
    clientName: string | null;
    href: string;
  }) => ({
    id: item.id,
    category: item.category,
    kind: item.kind,
    date: item.date,
    time: item.time,
    title: item.title,
    projectName: item.projectName,
    clientName: item.clientName,
    href: item.href,
  })), [
    {
      id: "booking-1",
      category: "call",
      kind: "call",
      date: "2026-05-31",
      time: "10:00 AM",
      title: "Discovery Call",
      projectName: "Alex Wedding",
      clientName: "Alex Taylor",
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
      href: "/projects/project-1#events",
    },
  ]);

  console.log("agent agenda route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
