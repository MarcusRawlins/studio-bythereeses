import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-events-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getAgenda } = await import("./agenda");
  const { createProjectEventFromAgent, updateProjectEventFromAgent } = await import("./crm");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
    VALUES
      ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', '2026-06-20', ?, ?),
      ('project-2', 'Other Wedding', 'wedding', 'planning', 'active', null, ?, ?)
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
      'The rehearsal is at River House on June 19.', 'Planning call summary', 'Studio UI', ?, ?
    ), (
      'source-2', 'project-2', 'planning_call', 'Other planning call',
      'Wrong project.', 'Wrong source', 'Studio UI', ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_events (
      id, project_id, type, title, event_date, calendar_sync_status, created_at, updated_at
    ) VALUES (
      'wedding-event-1', 'project-1', 'wedding', 'Wedding day', '2026-06-20', 'needs_google_connection', ?, ?
    )
  `).run(now, now);

  await assert.rejects(
    () => createProjectEventFromAgent("project-1", {
      type: "wedding",
      title: "Wedding day",
      eventDate: "2026-06-21",
      sourceType: "project_source",
      sourceId: "source-1",
    }),
    /Only Tyler can change the wedding date/,
  );
  await assert.rejects(
    () => updateProjectEventFromAgent("project-1", "wedding-event-1", {
      eventDate: "2026-06-21",
      sourceType: "project_source",
      sourceId: "source-1",
    }),
    /Only Tyler can change the wedding date/,
  );
  assert.deepEqual(database.prepare(`
    SELECT event_date
    FROM projects
    WHERE id = 'project-1'
  `).get(), { event_date: "2026-06-20" });

  const created = await createProjectEventFromAgent("project-1", {
    type: "rehearsal",
    title: "Rehearsal dinner",
    eventDate: "2026-06-19",
    venueName: "River House",
    city: "Charleston",
    state: "SC",
    notes: "Confirmed on planning call.",
    sourceType: "project_source",
    sourceId: "source-1",
  });

  assert.equal(created.projectId, "project-1");
  assert.equal(created.type, "rehearsal");
  assert.equal(created.title, "Rehearsal dinner");
  assert.equal(created.calendarSyncStatus, "needs_google_connection");
  assert.equal(created.sourceType, "project_source");
  assert.equal(created.sourceId, "source-1");
  assert.deepEqual(database.prepare(`
    SELECT source_type, source_id
    FROM project_events
    WHERE id = ?
  `).get(created.id), {
    source_type: "project_source",
    source_id: "source-1",
  });

  const agenda = await getAgenda({ fromDate: "2026-06-01", toDate: "2026-06-30" });
  assert.deepEqual(agenda.items.filter((item) => item.id === created.id).map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    date: item.date,
    venueLabel: item.venueLabel,
  })), [{
    id: created.id,
    title: "Rehearsal dinner",
    category: "other",
    date: "2026-06-19",
    venueLabel: "River House, Charleston, SC",
  }]);

  const updated = await updateProjectEventFromAgent("project-1", created.id, {
    title: "Welcome dinner",
    eventDate: "2026-06-18",
    venueName: "Harbor Room",
    sourceType: "project_source",
    sourceId: "source-1",
  });
  assert.equal(updated.title, "Welcome dinner");
  assert.equal(updated.eventDate, "2026-06-18");
  assert.equal(updated.venueName, "Harbor Room");
  assert.equal(updated.sourceType, "project_source");
  assert.equal(updated.sourceId, "source-1");

  const updatedWithoutSource = await updateProjectEventFromAgent("project-1", created.id, {
    title: "Welcome dinner timeline hold",
  });
  assert.equal(updatedWithoutSource.title, "Welcome dinner timeline hold");
  assert.equal(updatedWithoutSource.sourceType, "project_source");
  assert.equal(updatedWithoutSource.sourceId, "source-1");
  assert.deepEqual(database.prepare(`
    SELECT source_type, source_id
    FROM project_events
    WHERE id = ?
  `).get(created.id), {
    source_type: "project_source",
    source_id: "source-1",
  });

  const activity = database.prepare("SELECT action, actor_type, metadata FROM activity_logs ORDER BY created_at").all() as Array<{
    action: string;
    actor_type: string;
    metadata: string;
  }>;
  assert.deepEqual(activity.map((row) => row.action), [
    "project.event_created_by_agent",
    "project.event_updated_by_agent",
    "project.event_updated_by_agent",
  ]);
  assert.equal(activity[0].actor_type, "agent");
  assert.equal(JSON.parse(activity[0].metadata).sourceId, "source-1");

  await assert.rejects(
    () => createProjectEventFromAgent("project-1", {
      title: "Wrong source event",
      sourceType: "project_source",
      sourceId: "source-2",
    }),
    /Project source not found/,
  );
  await assert.rejects(
    () => createProjectEventFromAgent("project-1", {
      title: "Half-linked source event",
      sourceId: "source-1",
    }),
    /Project event source links require sourceType when sourceId is set/,
  );
  await assert.rejects(
    () => updateProjectEventFromAgent("project-1", created.id, {
      sourceType: null,
      sourceId: "source-1",
    }),
    /Project event source links require sourceType when sourceId is set/,
  );

  console.log("agent event tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
