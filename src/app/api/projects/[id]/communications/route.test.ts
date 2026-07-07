import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-communication-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', '555-0100', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'discovery_call', 'Route source',
      'Client wants direct follow-up.', 'Follow-up source summary', 'Studio UI', ?, ?
    )
  `).run(now, now);

  const formData = new FormData();
  formData.set("clientId", "client-1");
  formData.set("channel", "email");
  formData.set("status", "draft");
  formData.set("subject", "Route-created follow-up");
  formData.set("body", "Hi Alex, this was created by the Studio project page route.");
  formData.set("sourceId", "source-1");

  const response = await route.POST(new Request("https://studio.bythereeses.com/api/projects/project-1/communications", {
    method: "POST",
    body: formData,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.bythereeses.com/projects/project-1?saved=communication");

  const created = database.prepare(`
    SELECT id, project_id, client_id, subject, body, source_type, source_id, created_by
    FROM project_communications
    WHERE project_id = 'project-1'
  `).get() as { id: string };

  assert.deepEqual({ ...created, id: "created-id" }, {
    id: "created-id",
    project_id: "project-1",
    client_id: "client-1",
    subject: "Route-created follow-up",
    body: "Hi Alex, this was created by the Studio project page route.",
    source_type: "project_source",
    source_id: "source-1",
    created_by: "admin",
  });

  const updateFormData = new FormData();
  updateFormData.set("direction", "outbound");
  updateFormData.set("channel", "email");
  updateFormData.set("status", "sent");
  updateFormData.set("subject", "Route-created follow-up");
  updateFormData.set("body", "Hi Alex, this same communication was marked sent.");

  const updateResponse = await route.PATCH(new Request(`https://studio.bythereeses.com/api/projects/project-1/communications?id=${created.id}`, {
    method: "PATCH",
    body: updateFormData,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(updateResponse.status, 303);

  assert.deepEqual(database.prepare(`
    SELECT status, body
    FROM project_communications
    WHERE id = ?
  `).get(created.id), {
    status: "sent",
    body: "Hi Alex, this same communication was marked sent.",
  });

  // =============================================================================================
  // Phase 20 (meeting/consult notes) — Tests 16-17: D10/B-3 redirect routing.
  // =============================================================================================
  database.prepare(`
    INSERT INTO scheduler_meeting_types (id, slug, name, duration_minutes, buffer_minutes, created_at, updated_at)
    VALUES ('meeting-route-1', 'route-consult', 'Discovery Call', 30, 15, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, attendee_name, attendee_email, start_at, end_at, created_at, updated_at
    ) VALUES (
      'booking-route-1', 'meeting-route-1', 'project-1', 'Alex Taylor', 'alex@example.com',
      '2026-06-05T14:00:00.000Z', '2026-06-05T14:30:00.000Z', ?, ?
    )
  `).run(now, now);

  // Test 16 — creating a communication whose resulting row has a non-null bookingId redirects
  // (303) to /scheduler/bookings/{bookingId}?saved=communication, not the project. The plain
  // (bookingId: null) create above already proved the existing /projects/{id} target is unchanged.
  const meetingNoteFormData = new FormData();
  meetingNoteFormData.set("channel", "note");
  meetingNoteFormData.set("direction", "internal");
  meetingNoteFormData.set("body", "Discussed:\n\nDecisions:\n\nFollow-ups:\n");
  meetingNoteFormData.set("bookingId", "booking-route-1");

  const meetingNoteResponse = await route.POST(new Request("https://studio.bythereeses.com/api/projects/project-1/communications", {
    method: "POST",
    body: meetingNoteFormData,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(meetingNoteResponse.status, 303);
  assert.equal(
    meetingNoteResponse.headers.get("location"),
    "https://studio.bythereeses.com/scheduler/bookings/booking-route-1?saved=communication",
    "a create whose row has a non-null bookingId redirects to the booking page, not the project (D10)",
  );

  const meetingNote = database.prepare(`
    SELECT id, booking_id FROM project_communications WHERE project_id = 'project-1' AND booking_id = 'booking-route-1'
  `).get() as { id: string; booking_id: string };
  assert.equal(meetingNote.booking_id, "booking-route-1");

  // Test 17 — updating that SAME booking-linked row (POST with communicationId, and PATCH) still
  // redirects to /projects/{id}, never the booking page — the update branch never branches on
  // bookingId (B-3 regression guard). Exercises both the project page's "Edit communication" form
  // shape (POST + communicationId) and the "Log as sent" shape (PATCH).
  const editLinkedFormData = new FormData();
  editLinkedFormData.set("communicationId", meetingNote.id);
  editLinkedFormData.set("direction", "internal");
  editLinkedFormData.set("channel", "note");
  editLinkedFormData.set("status", "draft");
  editLinkedFormData.set("body", "Edited from the project page's Edit communication form.");

  const editLinkedResponse = await route.POST(new Request("https://studio.bythereeses.com/api/projects/project-1/communications", {
    method: "POST",
    body: editLinkedFormData,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(editLinkedResponse.status, 303);
  assert.equal(
    editLinkedResponse.headers.get("location"),
    "https://studio.bythereeses.com/projects/project-1?saved=communication",
    "updating an existing booking-linked row via POST still redirects to the project, not the booking (D10/B-3)",
  );

  const logAsSentFormData = new FormData();
  logAsSentFormData.set("direction", "internal");
  logAsSentFormData.set("channel", "note");
  logAsSentFormData.set("status", "sent");
  logAsSentFormData.set("body", "Logged as sent from the project page.");
  logAsSentFormData.set("sentAt", "2026-06-06T10:00:00.000Z");

  const logAsSentResponse = await route.PATCH(new Request(`https://studio.bythereeses.com/api/projects/project-1/communications?id=${meetingNote.id}`, {
    method: "PATCH",
    body: logAsSentFormData,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(logAsSentResponse.status, 303);
  assert.equal(
    logAsSentResponse.headers.get("location"),
    "https://studio.bythereeses.com/projects/project-1?saved=communication",
    "PATCH-updating an existing booking-linked row still redirects to the project, not the booking (D10/B-3)",
  );

  console.log("test 16-17 (D10/B-3 redirect routing) passed");

  console.log("project communication route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
