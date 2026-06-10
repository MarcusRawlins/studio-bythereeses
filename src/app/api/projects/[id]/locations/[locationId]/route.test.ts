import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-location-update-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

function locationForm() {
  const formData = new FormData();
  formData.set("type", "other");
  formData.set("customType", "first_look");
  formData.set("name", "Updated First Look Garden");
  formData.set("address", "44 Updated Garden Lane");
  formData.set("city", "Rhinebeck");
  formData.set("state", "NY");
  formData.set("notes", "Updated through the route handler.");
  return formData;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Location Update Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Wrong Location Wedding', 'wedding', 'planning', 'active', ?, ?)
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
    INSERT INTO project_locations (
      id, project_id, type, name, address, city, state, notes, created_at, updated_at
    ) VALUES
      ('location-1', 'project-1', 'getting_ready', 'Original Suite', '1 Original Street', 'Hudson', 'NY', 'Original notes', ?, ?),
      ('location-2', 'project-2', 'ceremony', 'Wrong Ceremony', '2 Wrong Street', 'Hudson', 'NY', 'Wrong notes', ?, ?)
  `).run(now, now, now, now);

  const originalConsoleError = console.error;
  console.error = () => {};
  const wrongProjectResponse = await POST(new Request("https://studio.test/api/projects/project-1/locations/location-2", {
    method: "POST",
    body: locationForm(),
  }), { params: Promise.resolve({ id: "project-1", locationId: "location-2" }) }).finally(() => {
    console.error = originalConsoleError;
  });
  assert.equal(wrongProjectResponse.status, 400);
  assert.deepEqual(await wrongProjectResponse.json(), { error: "Project location not found." });

  const response = await POST(new Request("https://studio.test/api/projects/project-1/locations/location-1", {
    method: "POST",
    body: locationForm(),
  }), { params: Promise.resolve({ id: "project-1", locationId: "location-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.test/projects/project-1?saved=location");
  assert.deepEqual(database.prepare(`
    SELECT type, name, address, city, state, notes
    FROM project_locations
    WHERE id = 'location-1'
  `).get(), {
    type: "first_look",
    name: "Updated First Look Garden",
    address: "44 Updated Garden Lane",
    city: "Rhinebeck",
    state: "NY",
    notes: "Updated through the route handler.",
  });

  assert.deepEqual(database.prepare(`
    SELECT action, project_id, client_id
    FROM activity_logs
    WHERE action = 'project.location_updated'
  `).get(), {
    action: "project.location_updated",
    project_id: "project-1",
    client_id: "client-1",
  });

  console.log("project location update route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
