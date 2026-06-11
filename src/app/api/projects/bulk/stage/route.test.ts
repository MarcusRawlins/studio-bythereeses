import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-bulk-stage-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-06-02T12:00:00.000Z";

  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES (?, ?, 'wedding', ?, 'active', ?, ?)
  `);
  const insertClient = database.prepare(`
    INSERT INTO clients (id, first_name, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertParticipant = database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES (?, ?, ?, 'primary', 1, ?)
  `);

  insertProject.run("project-1", "Bulk One", "inquiry", now, now);
  insertProject.run("project-2", "Bulk Two", "retainer_paid", now, now);
  insertProject.run("project-3", "Bulk Three", "planning", now, now);
  insertClient.run("client-1", "Avery", "avery@example.com", now, now);
  insertClient.run("client-2", "Blair", "blair@example.com", now, now);
  insertParticipant.run("participant-1", "project-1", "client-1", now);
  insertParticipant.run("participant-2", "project-2", "client-2", now);

  const response = await POST(new Request("https://studio.test/api/projects/bulk/stage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectIds: ["project-1", "project-2", "project-3"],
      stage: "planning",
    }),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    requestedCount: 3,
    stage: "planning",
    updatedCount: 2,
  });
  assert.deepEqual(database.prepare(`
    SELECT id, stage
    FROM projects
    ORDER BY id
  `).all(), [
    { id: "project-1", stage: "planning" },
    { id: "project-2", stage: "planning" },
    { id: "project-3", stage: "planning" },
  ]);
  assert.deepEqual(database.prepare(`
    SELECT action, project_id, client_id, metadata
    FROM activity_logs
    ORDER BY project_id
  `).all(), [
    {
      action: "project.stage_updated",
      project_id: "project-1",
      client_id: "client-1",
      metadata: JSON.stringify({ from: "inquiry", to: "planning", bulk: true, selectedProjectCount: 3 }),
    },
    {
      action: "project.stage_updated",
      project_id: "project-2",
      client_id: "client-2",
      metadata: JSON.stringify({ from: "retainer_paid", to: "planning", bulk: true, selectedProjectCount: 3 }),
    },
  ]);

  const missingResponse = await POST(new Request("https://studio.test/api/projects/bulk/stage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectIds: ["project-1", "missing-project"],
      stage: "completed",
    }),
  }));

  assert.equal(missingResponse.status, 400);
  assert.match(await missingResponse.text(), /could not be found/);

  console.log("bulk project stage route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
