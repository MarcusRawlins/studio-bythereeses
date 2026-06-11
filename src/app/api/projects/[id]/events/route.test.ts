import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-events-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Route Event Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);

  const formData = new FormData();
  formData.set("title", "Wedding day");
  formData.set("type", "wedding");
  formData.set("eventDate", "2026-09-19");
  formData.set("venueName", "Route Venue");
  formData.set("venueAddress", "12 Route Lane");
  formData.set("city", "Hudson");
  formData.set("state", "NY");
  formData.set("notes", "Created through the route handler.");

  const response = await POST(new Request("https://studio.test/api/projects/project-1/events", {
    method: "POST",
    body: formData,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.test/projects/project-1");

  assert.deepEqual(database.prepare(`
    SELECT type, event_date, venue_name, venue_address, city, state, calendar_sync_status
    FROM projects
    WHERE id = 'project-1'
  `).get(), {
    type: "wedding",
    event_date: "2026-09-19",
    venue_name: "Route Venue",
    venue_address: "12 Route Lane",
    city: "Hudson",
    state: "NY",
    calendar_sync_status: "needs_google_connection",
  });

  assert.deepEqual(database.prepare(`
    SELECT project_id, type, title, event_date, venue_name, venue_address, city, state, notes
    FROM project_events
  `).get(), {
    project_id: "project-1",
    type: "wedding",
    title: "Wedding day",
    event_date: "2026-09-19",
    venue_name: "Route Venue",
    venue_address: "12 Route Lane",
    city: "Hudson",
    state: "NY",
    notes: "Created through the route handler.",
  });

  assert.deepEqual(database.prepare(`
    SELECT action, project_id, client_id
    FROM activity_logs
  `).get(), {
    action: "project.event_created",
    project_id: "project-1",
    client_id: "client-1",
  });

  console.log("project events route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
