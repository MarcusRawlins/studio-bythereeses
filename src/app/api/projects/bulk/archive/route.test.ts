import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-bulk-archive-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-06-02T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Archive One', 'wedding', 'inquiry', 'active', ?, ?),
      ('project-2', 'Archive Two', 'wedding', 'planning', 'active', ?, ?),
      ('project-3', 'Already Archived', 'wedding', 'planning', 'archived', ?, ?)
  `).run(now, now, now, now, now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, email, created_at, updated_at)
    VALUES ('client-1', 'Avery', 'avery@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);

  const response = await POST(new Request("https://studio.test/api/projects/bulk/archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectIds: ["project-1", "project-2", "project-3"],
    }),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    archivedCount: 2,
    requestedCount: 3,
    status: "archived",
  });
  assert.deepEqual(database.prepare(`
    SELECT id, status
    FROM projects
    ORDER BY id
  `).all(), [
    { id: "project-1", status: "archived" },
    { id: "project-2", status: "archived" },
    { id: "project-3", status: "archived" },
  ]);
  assert.deepEqual(database.prepare(`
    SELECT action, project_id, client_id, metadata
    FROM activity_logs
    ORDER BY project_id
  `).all(), [
    {
      action: "project.archived",
      project_id: "project-1",
      client_id: "client-1",
      metadata: JSON.stringify({ from: "active", to: "archived", bulk: true, selectedProjectCount: 3 }),
    },
    {
      action: "project.archived",
      project_id: "project-2",
      client_id: null,
      metadata: JSON.stringify({ from: "active", to: "archived", bulk: true, selectedProjectCount: 3 }),
    },
  ]);

  const missingResponse = await POST(new Request("https://studio.test/api/projects/bulk/archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectIds: ["project-1", "missing-project"],
    }),
  }));

  assert.equal(missingResponse.status, 400);
  assert.match(await missingResponse.text(), /could not be found/);

  console.log("bulk project archive route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
