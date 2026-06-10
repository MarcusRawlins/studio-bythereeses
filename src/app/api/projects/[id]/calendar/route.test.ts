import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-calendar-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (
      id, name, type, stage, status, event_date, google_calendar_event_id, calendar_sync_status, created_at, updated_at
    ) VALUES
      ('project-missing-date', 'Missing Date Wedding', 'wedding', 'planning', 'active', NULL, NULL, 'not_connected', ?, ?),
      ('project-synced', 'Synced Wedding', 'wedding', 'planning', 'active', '2026-09-19', 'google-project-1', 'synced', ?, ?),
      ('project-event', 'Event Calendar Wedding', 'wedding', 'planning', 'active', '2026-09-19', NULL, 'needs_google_connection', ?, ?)
  `).run(now, now, now, now, now, now);
  database.prepare(`
    INSERT INTO project_events (
      id, project_id, type, title, event_date, google_calendar_event_id, calendar_sync_status, created_at, updated_at
    ) VALUES
      ('event-missing-date', 'project-event', 'engagement', 'Engagement session', NULL, NULL, 'not_connected', ?, ?),
      ('event-synced', 'project-event', 'wedding', 'Wedding day', '2026-09-19', 'google-event-1', 'synced', ?, ?)
  `).run(now, now, now, now);

  const missingProjectDateResponse = await POST(new Request("https://studio.test/api/projects/project-missing-date/calendar", {
    method: "POST",
    body: new FormData(),
  }), { params: Promise.resolve({ id: "project-missing-date" }) });
  assert.equal(missingProjectDateResponse.status, 303);
  assert.equal(missingProjectDateResponse.headers.get("location"), "https://studio.test/projects/project-missing-date?error=calendar-date");

  const syncedProjectResponse = await POST(new Request("https://studio.test/api/projects/project-synced/calendar", {
    method: "POST",
    body: new FormData(),
  }), { params: Promise.resolve({ id: "project-synced" }) });
  assert.equal(syncedProjectResponse.status, 303);
  assert.equal(syncedProjectResponse.headers.get("location"), "https://studio.test/projects/project-synced?saved=calendar");
  assert.deepEqual(database.prepare(`
    SELECT google_calendar_event_id, calendar_sync_status
    FROM projects
    WHERE id = 'project-synced'
  `).get(), {
    google_calendar_event_id: "google-project-1",
    calendar_sync_status: "synced",
  });

  const missingEventDateForm = new FormData();
  missingEventDateForm.set("eventId", "event-missing-date");
  const missingEventDateResponse = await POST(new Request("https://studio.test/api/projects/project-event/calendar", {
    method: "POST",
    body: missingEventDateForm,
  }), { params: Promise.resolve({ id: "project-event" }) });
  assert.equal(missingEventDateResponse.status, 303);
  assert.equal(missingEventDateResponse.headers.get("location"), "https://studio.test/projects/project-event?error=calendar-date");

  const syncedEventForm = new FormData();
  syncedEventForm.set("eventId", "event-synced");
  const syncedEventResponse = await POST(new Request("https://studio.test/api/projects/project-event/calendar", {
    method: "POST",
    body: syncedEventForm,
  }), { params: Promise.resolve({ id: "project-event" }) });
  assert.equal(syncedEventResponse.status, 303);
  assert.equal(syncedEventResponse.headers.get("location"), "https://studio.test/projects/project-event?saved=calendar-event");
  assert.deepEqual(database.prepare(`
    SELECT google_calendar_event_id, calendar_sync_status
    FROM project_events
    WHERE id = 'event-synced'
  `).get(), {
    google_calendar_event_id: "google-event-1",
    calendar_sync_status: "synced",
  });

  const wrongProjectEventForm = new FormData();
  wrongProjectEventForm.set("eventId", "event-synced");
  const originalConsoleError = console.error;
  console.error = () => {};
  const wrongProjectResponse = await POST(new Request("https://studio.test/api/projects/project-synced/calendar", {
    method: "POST",
    body: wrongProjectEventForm,
  }), { params: Promise.resolve({ id: "project-synced" }) }).finally(() => {
    console.error = originalConsoleError;
  });
  assert.equal(wrongProjectResponse.status, 303);
  assert.equal(wrongProjectResponse.headers.get("location"), "https://studio.test/projects/project-synced?error=calendar-sync");

  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM activity_logs").get(), { count: 0 });

  console.log("project calendar route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
