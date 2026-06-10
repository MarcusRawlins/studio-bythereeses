import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-engagement-sessions-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const {
    createProjectFromForm,
    ensureEngagementPlaceholder,
    removeEngagementPlaceholderIfUnscheduled,
    updateProjectDetailsFromForm,
  } = await import("./crm");
  const { listPendingEngagementSessions } = await import("./dashboard");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?),
      ('client-2', 'Morgan', 'Lee', 'morgan@example.com', ?, ?),
      ('client-3', 'Riley', 'Stone', 'riley@example.com', ?, ?)
  `).run(now, now, now, now, now, now);
  database.prepare(`
    INSERT INTO projects (
      id, name, type, stage, status, event_date, created_at, updated_at
    ) VALUES
      ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', '2026-08-01', ?, ?),
      ('project-2', 'Morgan Wedding', 'wedding', 'planning', 'active', '2026-07-01', ?, ?),
      ('project-3', 'Riley Wedding', 'wedding', 'planning', 'archived', '2026-06-01', ?, ?),
      ('project-4', 'No Date Wedding', 'wedding', 'planning', 'active', NULL, ?, ?)
  `).run(now, now, now, now, now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-1', 'project-1', 'client-1', 'primary', 1, ?),
      ('participant-2', 'project-2', 'client-2', 'primary', 1, ?),
      ('participant-3', 'project-3', 'client-3', 'primary', 1, ?)
  `).run(now, now, now);

  const placeholderId = await ensureEngagementPlaceholder("project-1");
  assert.ok(placeholderId, "ensuring engagement should return the canonical placeholder id");
  const secondPlaceholderId = await ensureEngagementPlaceholder("project-1");
  assert.equal(secondPlaceholderId, placeholderId, "ensuring engagement should be idempotent");

  let projectOneEvents = database.prepare(`
    SELECT id, type, title, event_date, calendar_sync_status
    FROM project_events
    WHERE project_id = 'project-1' AND type = 'engagement'
  `).all() as Array<{
    id: string;
    type: string;
    title: string;
    event_date: string | null;
    calendar_sync_status: string;
  }>;
  assert.deepEqual(projectOneEvents, [{
    id: placeholderId,
    type: "engagement",
    title: "Engagement session",
    event_date: null,
    calendar_sync_status: "not_connected",
  }]);

  await ensureEngagementPlaceholder("project-2");
  await ensureEngagementPlaceholder("project-3");
  await ensureEngagementPlaceholder("project-4");

  const pending = await listPendingEngagementSessions();
  assert.deepEqual(pending.map((item) => ({
    projectId: item.projectId,
    projectName: item.projectName,
    weddingDate: item.weddingDate,
    clientName: item.clientName,
  })), [
    {
      projectId: "project-2",
      projectName: "Morgan Wedding",
      weddingDate: "2026-07-01",
      clientName: "Morgan Lee",
    },
    {
      projectId: "project-1",
      projectName: "Alex Wedding",
      weddingDate: "2026-08-01",
      clientName: "Alex Taylor",
    },
    {
      projectId: "project-4",
      projectName: "No Date Wedding",
      weddingDate: null,
      clientName: null,
    },
  ]);

  await removeEngagementPlaceholderIfUnscheduled("project-1");
  projectOneEvents = database.prepare(`
    SELECT id
    FROM project_events
    WHERE project_id = 'project-1' AND type = 'engagement'
  `).all() as Array<{ id: string }>;
  assert.equal(projectOneEvents.length, 0, "removing an unscheduled placeholder should delete only the placeholder row");

  database.prepare(`
    INSERT INTO project_events (
      id, project_id, type, title, event_date, calendar_sync_status, created_at, updated_at
    ) VALUES (
      'dated-engagement', 'project-1', 'engagement', 'Engagement session',
      '2026-06-10', 'needs_google_connection', ?, ?
    )
  `).run(now, now);
  await removeEngagementPlaceholderIfUnscheduled("project-1");
  const datedEvents = database.prepare(`
    SELECT id, event_date
    FROM project_events
    WHERE project_id = 'project-1' AND type = 'engagement'
  `).all() as Array<{ id: string; event_date: string | null }>;
  assert.deepEqual(datedEvents, [{
    id: "dated-engagement",
    event_date: "2026-06-10",
  }], "removing the checkbox should preserve scheduled engagement history");

  const createForm = new FormData();
  createForm.set("projectName", "Manual Engagement Wedding");
  createForm.set("firstName", "Jamie");
  createForm.set("email", "jamie@example.com");
  createForm.set("type", "wedding");
  createForm.set("engagementSessionIncluded", "on");

  const manualProjectId = await createProjectFromForm(createForm);
  const manualPlaceholder = database.prepare(`
    SELECT type, title, event_date
    FROM project_events
    WHERE project_id = ? AND type = 'engagement'
  `).get(manualProjectId);
  assert.deepEqual(manualPlaceholder, {
    type: "engagement",
    title: "Engagement session",
    event_date: null,
  }, "creating a project with the manual checkbox should create the unscheduled engagement placeholder");

  const removeManualForm = new FormData();
  removeManualForm.set("projectId", manualProjectId);
  removeManualForm.set("type", "wedding");
  removeManualForm.set("eventDate", "");
  removeManualForm.set("venueName", "");
  removeManualForm.set("venueAddress", "");
  removeManualForm.set("city", "");
  removeManualForm.set("state", "");
  removeManualForm.set("notes", "");
  await updateProjectDetailsFromForm(removeManualForm);
  assert.deepEqual(database.prepare(`
    SELECT count(*) AS count
    FROM project_events
    WHERE project_id = ? AND type = 'engagement'
  `).get(manualProjectId), {
    count: 0,
  }, "unchecking the manual checkbox should remove only the unscheduled engagement placeholder");

  const restoreManualForm = new FormData();
  restoreManualForm.set("projectId", manualProjectId);
  restoreManualForm.set("type", "wedding");
  restoreManualForm.set("eventDate", "");
  restoreManualForm.set("venueName", "");
  restoreManualForm.set("venueAddress", "");
  restoreManualForm.set("city", "");
  restoreManualForm.set("state", "");
  restoreManualForm.set("notes", "");
  restoreManualForm.set("engagementSessionIncluded", "on");
  await updateProjectDetailsFromForm(restoreManualForm);
  assert.deepEqual(database.prepare(`
    SELECT count(*) AS count
    FROM project_events
    WHERE project_id = ? AND type = 'engagement' AND event_date IS NULL
  `).get(manualProjectId), {
    count: 1,
  }, "checking the manual checkbox on edit should restore one unscheduled engagement placeholder");

  console.log("engagement session tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
