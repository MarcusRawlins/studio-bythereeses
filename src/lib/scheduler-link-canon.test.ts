import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-scheduler-link-canon-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

function linkForm(projectId: string) {
  const formData = new FormData();
  formData.set("bookingId", "booking-1");
  formData.set("projectId", projectId);
  return formData;
}

function secondaryLinkForm(projectId: string) {
  const formData = new FormData();
  formData.set("bookingId", "booking-2");
  formData.set("projectId", projectId);
  return formData;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { linkBookingToProjectAction } = await import("./scheduler");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-1', 'Avery', 'Stone', 'avery@example.com', ?, ?),
      ('client-2', 'Jordan', 'Stone', 'jordan@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Scheduler Link Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, created_at, updated_at
    ) VALUES (
      'meeting-1', 'discovery-call', 'Discovery Call', 45, 15, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, client_id, attendee_name, attendee_email, start_at, end_at, status, source, created_at, updated_at
    ) VALUES
      (
        'booking-1', 'meeting-1', 'client-1', 'Avery Stone', 'avery@example.com',
        '2026-06-01T14:00:00.000Z', '2026-06-01T14:45:00.000Z', 'confirmed', 'admin', ?, ?
      ),
      (
        'booking-2', 'meeting-1', 'client-2', 'Jordan Stone', 'jordan@example.com',
        '2026-06-02T14:00:00.000Z', '2026-06-02T14:45:00.000Z', 'confirmed', 'admin', ?, ?
      )
  `).run(now, now, now, now);

  await assert.rejects(
    () => linkBookingToProjectAction(linkForm("missing-project")),
    /Project not found/,
  );

  assert.deepEqual(database.prepare(`
    SELECT project_id
    FROM scheduler_bookings
    WHERE id = 'booking-1'
  `).get(), { project_id: null });
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM project_participants").get(), { count: 0 });
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM activity_logs").get(), { count: 0 });

  await assert.rejects(
    () => linkBookingToProjectAction(linkForm("project-1")),
    /NEXT_REDIRECT/,
  );

  assert.deepEqual(database.prepare(`
    SELECT project_id
    FROM scheduler_bookings
    WHERE id = 'booking-1'
  `).get(), { project_id: "project-1" });
  assert.deepEqual(database.prepare(`
    SELECT project_id, client_id, role, is_primary_contact
    FROM project_participants
    WHERE client_id = 'client-1'
  `).get(), {
    project_id: "project-1",
    client_id: "client-1",
    role: "primary",
    is_primary_contact: 1,
  });
  await assert.rejects(
    () => linkBookingToProjectAction(secondaryLinkForm("project-1")),
    /NEXT_REDIRECT/,
  );
  assert.deepEqual(database.prepare(`
    SELECT project_id, client_id, role, is_primary_contact
    FROM project_participants
    WHERE client_id = 'client-2'
  `).get(), {
    project_id: "project-1",
    client_id: "client-2",
    role: "scheduler",
    is_primary_contact: 0,
  });
  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM project_participants
    WHERE project_id = 'project-1' AND is_primary_contact = 1
  `).get(), { count: 1 });
  assert.deepEqual(database.prepare(`
    SELECT action, project_id, client_id
    FROM activity_logs
    ORDER BY created_at, rowid
  `).all(), [{
    action: "scheduler.booking_linked_to_project",
    project_id: "project-1",
    client_id: "client-1",
  }, {
    action: "scheduler.booking_linked_to_project",
    project_id: "project-1",
    client_id: "client-2",
  }]);

  console.log("scheduler link canon tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
