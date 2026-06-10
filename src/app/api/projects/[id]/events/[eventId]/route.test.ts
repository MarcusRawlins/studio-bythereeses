import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-event-update-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

function eventForm() {
  const formData = new FormData();
  formData.set("title", "Wedding day");
  formData.set("type", "wedding");
  formData.set("eventDate", "2026-10-03");
  formData.set("venueName", "Updated Route Venue");
  formData.set("venueAddress", "44 Updated Lane");
  formData.set("city", "Rhinebeck");
  formData.set("state", "NY");
  formData.set("notes", "Updated through the route handler.");
  return formData;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, venue_name, calendar_sync_status, created_at, updated_at)
    VALUES
      ('project-1', 'Route Update Wedding', 'wedding', 'planning', 'active', '2026-09-19', 'Original Venue', 'needs_google_connection', ?, ?),
      ('project-2', 'Wrong Route Wedding', 'wedding', 'planning', 'active', NULL, NULL, 'not_connected', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_events (
      id, project_id, type, title, event_date, venue_name, calendar_sync_status, created_at, updated_at
    ) VALUES
      ('event-1', 'project-1', 'wedding', 'Wedding day', '2026-09-19', 'Original Venue', 'needs_google_connection', ?, ?),
      ('event-2', 'project-2', 'wedding', 'Wedding day', '2026-11-01', 'Wrong Venue', 'needs_google_connection', ?, ?)
  `).run(now, now, now, now);

  const originalConsoleError = console.error;
  console.error = () => {};
  const wrongProjectResponse = await POST(new Request("https://studio.test/api/projects/project-1/events/event-2", {
    method: "POST",
    body: eventForm(),
  }), { params: Promise.resolve({ id: "project-1", eventId: "event-2" }) }).finally(() => {
    console.error = originalConsoleError;
  });

  assert.equal(wrongProjectResponse.status, 400);
  assert.deepEqual(await wrongProjectResponse.json(), { error: "Project event not found." });

  const response = await POST(new Request("https://studio.test/api/projects/project-1/events/event-1", {
    method: "POST",
    body: eventForm(),
  }), { params: Promise.resolve({ id: "project-1", eventId: "event-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.test/projects/project-1?saved=event");

  assert.deepEqual(database.prepare(`
    SELECT event_date, venue_name, venue_address, city, state, calendar_sync_status
    FROM projects
    WHERE id = 'project-1'
  `).get(), {
    event_date: "2026-10-03",
    venue_name: "Updated Route Venue",
    venue_address: "44 Updated Lane",
    city: "Rhinebeck",
    state: "NY",
    calendar_sync_status: "needs_google_connection",
  });

  assert.deepEqual(database.prepare(`
    SELECT title, event_date, venue_name, venue_address, city, state, notes
    FROM project_events
    WHERE id = 'event-1'
  `).get(), {
    title: "Wedding day",
    event_date: "2026-10-03",
    venue_name: "Updated Route Venue",
    venue_address: "44 Updated Lane",
    city: "Rhinebeck",
    state: "NY",
    notes: "Updated through the route handler.",
  });

  assert.deepEqual(database.prepare(`
    SELECT action, project_id, client_id
    FROM activity_logs
    WHERE action = 'project.event_updated'
  `).get(), {
    action: "project.event_updated",
    project_id: "project-1",
    client_id: "client-1",
  });

  console.log("project event update route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
