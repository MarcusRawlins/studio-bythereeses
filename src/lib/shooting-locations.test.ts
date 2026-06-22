import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-shooting-locations-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { listShootingLocations, parseShootingLocationTags } = await import("./shooting-locations");

  const database = rawDb();
  const seeded = database.prepare(`
    SELECT name, region, city, state, location_type, tags_json, status
    FROM shooting_locations
    WHERE id = 'shooting-location-rock-harbor-beach-orleans-ma'
  `).get() as {
    name: string;
    region: string;
    city: string;
    state: string;
    location_type: string;
    tags_json: string;
    status: string;
  } | undefined;

  assert.deepEqual(seeded, {
    name: "Rock Harbor Beach",
    region: "Cape Cod",
    city: "Orleans",
    state: "MA",
    location_type: "beach",
    tags_json: "[\"cape cod\",\"orleans\",\"beach\",\"harbor\",\"sunset\",\"drone\",\"engagements\"]",
    status: "active",
  });

  assert.deepEqual(parseShootingLocationTags(seeded?.tags_json ?? null), [
    "cape cod",
    "orleans",
    "beach",
    "harbor",
    "sunset",
    "drone",
    "engagements",
  ]);

  const locations = await listShootingLocations();
  assert.ok(locations.some((location) => location.name === "Rock Harbor Beach" && location.region === "Cape Cod"));

  console.log("shooting locations tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
