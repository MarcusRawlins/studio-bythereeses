import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-locations-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { createProjectLocationFromAgent, getProject, updateProjectLocationFromAgent } = await import("./crm");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Agent Location Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Other Agent Location Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'planning_call', 'Planning call',
      'First look should happen in the greenhouse.', 'Planning call summary', 'Studio UI', ?, ?
    ), (
      'source-2', 'project-2', 'planning_call', 'Other planning call',
      'Wrong project.', 'Wrong source', 'Studio UI', ?, ?
    )
  `).run(now, now, now, now);

  const created = await createProjectLocationFromAgent("project-1", {
    type: "portrait",
    name: "Greenhouse first look",
    address: "12 Garden Lane",
    city: "Hudson",
    state: "NY",
    notes: "Agent extracted this from planning call notes.",
    sourceType: "project_source",
    sourceId: "source-1",
  });

  assert.equal(created.projectId, "project-1");
  assert.equal(created.type, "portrait");
  assert.equal(created.name, "Greenhouse first look");
  assert.equal(created.sourceType, "project_source");
  assert.equal(created.sourceId, "source-1");
  assert.deepEqual(database.prepare(`
    SELECT source_type, source_id
    FROM project_locations
    WHERE id = ?
  `).get(created.id), {
    source_type: "project_source",
    source_id: "source-1",
  });

  const updated = await updateProjectLocationFromAgent("project-1", created.id, {
    name: "Greenhouse portraits",
    notes: "Updated after logistics review.",
  });
  assert.equal(updated.name, "Greenhouse portraits");
  assert.equal(updated.notes, "Updated after logistics review.");
  assert.equal(updated.sourceType, "project_source");
  assert.equal(updated.sourceId, "source-1");

  const project = await getProject("project-1");
  assert.ok(project);
  assert.deepEqual(project.locations.map((location) => ({
    id: location.id,
    name: location.name,
    sourceType: location.sourceType,
    sourceId: location.sourceId,
  })), [{
    id: created.id,
    name: "Greenhouse portraits",
    sourceType: "project_source",
    sourceId: "source-1",
  }]);

  const activity = database.prepare("SELECT action, actor_type, metadata FROM activity_logs ORDER BY created_at").all() as Array<{
    action: string;
    actor_type: string;
    metadata: string;
  }>;
  assert.deepEqual(activity.map((row) => row.action), [
    "project.location_created_by_agent",
    "project.location_updated_by_agent",
  ]);
  assert.equal(activity[0].actor_type, "agent");
  assert.equal(JSON.parse(activity[0].metadata).sourceId, "source-1");

  await assert.rejects(
    () => createProjectLocationFromAgent("project-1", {
      name: "Wrong source location",
      sourceType: "project_source",
      sourceId: "source-2",
    }),
    /Project source not found/,
  );
  await assert.rejects(
    () => createProjectLocationFromAgent("project-1", {
      name: "Half-linked source location",
      sourceId: "source-1",
    }),
    /Project location source links require sourceType when sourceId is set/,
  );
  await assert.rejects(
    () => updateProjectLocationFromAgent("project-2", created.id, {
      name: "Wrong project edit",
    }),
    /Project location not found/,
  );

  console.log("agent location tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
