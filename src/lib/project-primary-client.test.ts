import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-primary-client-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { setProjectPrimaryClient } = await import("./crm");
  const database = rawDb();
  const now = "2026-05-31T17:00:00.000Z";

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

  const result = await setProjectPrimaryClient({
    projectId: "project-1",
    clientId: "client-2",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
  });

  assert.equal(result.projectId, "project-1");
  assert.equal(result.clientId, "client-2");
  assert.equal(result.previousPrimaryClientId, "client-1");

  assert.deepEqual(database.prepare(`
    SELECT client_id, is_primary_contact
    FROM project_participants
    WHERE project_id = 'project-1'
    ORDER BY client_id
  `).all(), [
    { client_id: "client-1", is_primary_contact: 0 },
    { client_id: "client-2", is_primary_contact: 1 },
  ]);

  assert.deepEqual(database.prepare(`
    SELECT action, actor_type, actor_name, metadata
    FROM activity_logs
    WHERE project_id = 'project-1'
  `).get(), {
    action: "project.primary_client_updated",
    actor_type: "agent",
    actor_name: "The Reeses Studio Agent",
    metadata: JSON.stringify({
      previousPrimaryClientId: "client-1",
      nextPrimaryClientId: "client-2",
    }),
  });

  await assert.rejects(
    () => setProjectPrimaryClient({ projectId: "project-1", clientId: "missing-client" }),
    /Client is not linked to this project/,
  );

  console.log("project primary client tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
