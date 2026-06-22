import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-shooting-locations-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();

  const createForm = new FormData();
  createForm.set("_action", "create");
  createForm.set("name", "  Chatham Lighthouse Beach  ");
  createForm.set("region", "Cape Cod");
  createForm.set("city", "Chatham");
  createForm.set("state", "MA");
  createForm.set("locationType", "beach");
  createForm.set("tags", "Cape Cod, Beach, Lighthouse");
  createForm.set("status", "needs_scouting");
  createForm.set("bestFor", "Engagement sessions at sunset");

  const createResponse = await route.POST(new Request("https://studio.bythereeses.com/api/shooting-locations", {
    method: "POST",
    body: createForm,
  }));

  assert.equal(createResponse.status, 303);
  assert.equal(createResponse.headers.get("location"), "https://studio.bythereeses.com/shooting-locations");

  const created = database.prepare(`
    SELECT id, name, region, city, state, location_type, tags_json, status, best_for
    FROM shooting_locations
    WHERE name = 'Chatham Lighthouse Beach'
  `).get() as {
    id: string;
    name: string;
    region: string;
    city: string;
    state: string;
    location_type: string;
    tags_json: string;
    status: string;
    best_for: string;
  };

  assert.deepEqual(created, {
    id: created.id,
    name: "Chatham Lighthouse Beach",
    region: "Cape Cod",
    city: "Chatham",
    state: "MA",
    location_type: "beach",
    tags_json: '["cape cod","beach","lighthouse"]',
    status: "needs_scouting",
    best_for: "Engagement sessions at sunset",
  });

  const updateForm = new FormData();
  updateForm.set("_action", "update");
  updateForm.set("locationId", created.id);
  updateForm.set("name", "Chatham Lighthouse");
  updateForm.set("region", "Cape Cod");
  updateForm.set("city", "Chatham");
  updateForm.set("state", "MA");
  updateForm.set("locationType", "beach");
  updateForm.set("tags", "cape cod, lighthouse, sunset");
  updateForm.set("status", "active");
  updateForm.set("bestFor", "Sunset portraits and lighthouse backdrops");

  const updateResponse = await route.POST(new Request("https://studio.bythereeses.com/api/shooting-locations", {
    method: "POST",
    body: updateForm,
  }));

  assert.equal(updateResponse.status, 303);
  assert.equal(updateResponse.headers.get("location"), "https://studio.bythereeses.com/shooting-locations");

  const updated = database.prepare(`
    SELECT name, tags_json, status, best_for
    FROM shooting_locations
    WHERE id = ?
  `).get(created.id) as {
    name: string;
    tags_json: string;
    status: string;
    best_for: string;
  };

  assert.deepEqual(updated, {
    name: "Chatham Lighthouse",
    tags_json: '["cape cod","lighthouse","sunset"]',
    status: "active",
    best_for: "Sunset portraits and lighthouse backdrops",
  });

  const archiveForm = new FormData();
  archiveForm.set("_action", "archive");
  archiveForm.set("locationId", created.id);

  const archiveResponse = await route.POST(new Request("https://studio.bythereeses.com/api/shooting-locations", {
    method: "POST",
    body: archiveForm,
  }));

  assert.equal(archiveResponse.status, 303);
  assert.equal(archiveResponse.headers.get("location"), "https://studio.bythereeses.com/shooting-locations");

  const archived = database.prepare(`
    SELECT status
    FROM shooting_locations
    WHERE id = ?
  `).get(created.id) as { status: string };

  assert.equal(archived.status, "archived");

  const recentActivity = database.prepare(`
    SELECT action
    FROM activity_logs
    ORDER BY created_at DESC
    LIMIT 3
  `).all() as Array<{ action: string }>;

  assert.deepEqual(recentActivity.map((row) => row.action), [
    "shooting_location.archived",
    "shooting_location.updated",
    "shooting_location.created",
  ]);

  console.log("shooting locations route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});