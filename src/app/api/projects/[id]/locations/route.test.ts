import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-locations-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Location Route Wedding', 'wedding', 'planning', 'active', ?, ?)
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
  formData.set("type", "getting_ready");
  formData.set("name", "Route Bridal Suite");
  formData.set("address", "11 Route Street");
  formData.set("city", "Hudson");
  formData.set("state", "NY");
  formData.set("notes", "Created through the route handler.");

  const response = await POST(new Request("https://studio.test/api/projects/project-1/locations", {
    method: "POST",
    body: formData,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.test/projects/project-1?saved=location");

  assert.deepEqual(database.prepare(`
    SELECT project_id, type, name, address, city, state, notes
    FROM project_locations
  `).get(), {
    project_id: "project-1",
    type: "getting_ready",
    name: "Route Bridal Suite",
    address: "11 Route Street",
    city: "Hudson",
    state: "NY",
    notes: "Created through the route handler.",
  });

  assert.deepEqual(database.prepare(`
    SELECT action, project_id, client_id
    FROM activity_logs
  `).get(), {
    action: "project.location_created",
    project_id: "project-1",
    client_id: "client-1",
  });

  console.log("project locations route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
