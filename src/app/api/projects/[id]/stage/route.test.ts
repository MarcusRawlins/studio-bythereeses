import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-stage-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Stage Route Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, email, created_at, updated_at)
    VALUES ('client-1', 'Avery', 'avery@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);

  const formData = new FormData();
  formData.set("stage", "planning");

  const response = await POST(new Request("https://studio.test/api/projects/project-1/stage", {
    method: "POST",
    body: formData,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.test/projects/project-1");
  assert.deepEqual(database.prepare("SELECT stage FROM projects WHERE id = 'project-1'").get(), {
    stage: "planning",
  });
  assert.deepEqual(database.prepare(`
    SELECT action, project_id, client_id, metadata
    FROM activity_logs
  `).get(), {
    action: "project.stage_updated",
    project_id: "project-1",
    client_id: "client-1",
    metadata: JSON.stringify({ from: "inquiry", to: "planning" }),
  });

  const sameStageResponse = await POST(new Request("https://studio.test/api/projects/project-1/stage", {
    method: "POST",
    body: formData,
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(sameStageResponse.status, 303);
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM activity_logs").get(), {
    count: 1,
  });

  console.log("project stage route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
