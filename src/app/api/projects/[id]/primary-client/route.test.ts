import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-primary-client-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T17:30:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?),
      ('client-2', 'Jordan', 'Taylor', 'jordan@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-1', 'project-1', 'client-1', 'bride', 1, ?),
      ('participant-2', 'project-1', 'client-2', 'groom', 0, ?)
  `).run(now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const formData = new FormData();
  formData.set("clientId", "client-2");

  const response = await route.POST(new Request("https://studio.bythereeses.com/api/projects/project-1/primary-client", {
    method: "POST",
    headers: { "x-reese-origin-secret": "origin-secret" },
    body: formData,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.bythereeses.com/projects/project-1?saved=primary-client");
  assert.deepEqual(database.prepare(`
    SELECT client_id, is_primary_contact
    FROM project_participants
    WHERE project_id = 'project-1'
    ORDER BY client_id
  `).all(), [
    { client_id: "client-1", is_primary_contact: 0 },
    { client_id: "client-2", is_primary_contact: 1 },
  ]);

  console.log("project primary client route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
