import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-client-merge-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T13:30:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-survivor', 'Alex', 'Taylor', 'alex@example.com', ?, ?),
      ('client-duplicate', 'Alex', 'Taylor', 'alex.duplicate@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-duplicate', 'project-1', 'client-duplicate', 'primary', 1, ?)
  `).run(now);

  const formData = new FormData();
  formData.set("duplicateClientId", "client-duplicate");
  formData.set("actorName", "Tyler");

  const response = await route.POST(new Request("https://studio.bythereeses.com/api/clients/client-survivor/merge", {
    method: "POST",
    body: formData,
  }), {
    params: Promise.resolve({ id: "client-survivor" }),
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.bythereeses.com/clients/client-survivor?saved=merged");
  assert.equal(database.prepare("SELECT count(*) AS count FROM clients WHERE id = 'client-duplicate'").get().count, 0);
  assert.deepEqual(database.prepare(`
    SELECT client_id
    FROM project_participants
    WHERE project_id = 'project-1'
  `).get(), { client_id: "client-survivor" });

  const activity = database.prepare("SELECT action, client_id FROM activity_logs WHERE action = 'client.merged'").get() as {
    action: string;
    client_id: string;
  };
  assert.equal(activity.client_id, "client-survivor");

  console.log("client merge route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
