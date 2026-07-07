import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 20 — structured meeting/consult notes (docs/specs/phase-20-meeting-notes.md §4).
// Covers tests 1-5 and 7 (migration additive, canon guard unaffected, requireBookingBelongsToProject,
// create-time linkage validation, the create-time allowlist clamp (B-5), and the B-1/D4 update-path
// authority guard). Test 6 (MCP schema drift guard) lives in studio-mcp.test.ts; test 8 (getProject
// bookings-query gating matrix) lives in crm.test.ts; tests 9-18 (page rendering, redirect routing)
// live in their respective page/route test files.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-meeting-notes-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const {
    createProjectCommunicationFromAgent,
    createProjectCommunicationFromForm,
    createProjectCommunicationFromSystem,
    requireBookingBelongsToProject,
    updateProjectCommunicationFromAgent,
    updateProjectCommunicationFromForm,
  } = await import("./project-communications");
  const database = rawDb();
  const now = "2026-07-01T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-mn-1', 'Meeting Notes Wedding', 'wedding', 'inquiry', 'active', ?, ?),
      ('project-mn-2', 'Other Meeting Notes Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-mn-1', 'Jamie', 'Reese', 'jamie@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-mn-1', 'project-mn-1', 'client-mn-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (id, slug, name, duration_minutes, buffer_minutes, created_at, updated_at)
    VALUES ('meeting-type-mn-1', 'mn-consult', 'Discovery Call', 30, 15, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, attendee_name, attendee_email, start_at, end_at, created_at, updated_at
    ) VALUES
      ('booking-mn-1', 'meeting-type-mn-1', 'project-mn-1', 'Jamie Reese', 'jamie@example.com',
       '2026-07-05T14:00:00.000Z', '2026-07-05T14:30:00.000Z', ?, ?),
      ('booking-mn-other', 'meeting-type-mn-1', 'project-mn-2', 'Other Client', 'other@example.com',
       '2026-07-06T14:00:00.000Z', '2026-07-06T14:30:00.000Z', ?, ?)
  `).run(now, now, now, now);

  // ---------------------------------------------------------------------------------------------
  // Test 1 — migration additive: booking_id is a nullable column; a pre-existing (no-bookingId) row
  // reads back with bookingId: null, unchanged.
  // ---------------------------------------------------------------------------------------------
  const columns = new Set(
    (database.prepare("PRAGMA table_info(project_communications)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  assert.ok(columns.has("booking_id"), "project_communications gains a nullable booking_id column");

  const plainFormData = new FormData();
  plainFormData.set("channel", "note");
  plainFormData.set("body", "A general project note, not tied to any meeting.");
  const plainNote = await createProjectCommunicationFromForm("project-mn-1", plainFormData);
  assert.equal(plainNote.bookingId, null, "a note created with no bookingId stores null");
  assert.deepEqual(
    database.prepare("SELECT booking_id FROM project_communications WHERE id = ?").get(plainNote.id),
    { booking_id: null },
  );
  console.log("test 1 (migration additive) passed");

  // ---------------------------------------------------------------------------------------------
  // Test 2 — canon guard unaffected: inserting/updating rows with booking_id present or absent,
  // otherwise-canonical field combinations, still pass migration 0060's triggers (a regression
  // guard — booking_id isn't referenced by any trigger WHEN clause, so it never blocks a write).
  // ---------------------------------------------------------------------------------------------
  const linkedFormData = new FormData();
  linkedFormData.set("channel", "note");
  linkedFormData.set("body", "Discussed:\n\nDecisions:\n\nFollow-ups:\n");
  linkedFormData.set("bookingId", "booking-mn-1");
  const linkedNote = await createProjectCommunicationFromForm("project-mn-1", linkedFormData);
  assert.equal(linkedNote.bookingId, "booking-mn-1", "an admin-authored note with a valid same-project bookingId stores it (canon triggers unaffected)");
  console.log("test 2 (canon guard unaffected) passed");

  // ---------------------------------------------------------------------------------------------
  // Test 3 — requireBookingBelongsToProject: throws when missing, throws on project mismatch,
  // returns the booking row when it matches.
  // ---------------------------------------------------------------------------------------------
  await assert.rejects(
    () => requireBookingBelongsToProject("project-mn-1", "booking-does-not-exist"),
    /Booking not found/,
  );
  await assert.rejects(
    () => requireBookingBelongsToProject("project-mn-2", "booking-mn-1"),
    /Booking not found/,
    "a booking that belongs to a DIFFERENT project throws",
  );
  const matched = await requireBookingBelongsToProject("project-mn-1", "booking-mn-1");
  assert.equal(matched.id, "booking-mn-1");
  console.log("test 3 (requireBookingBelongsToProject) passed");

  // ---------------------------------------------------------------------------------------------
  // Test 4 — linkage validation on create: an admin-actor create with a bookingId for the SAME
  // project stores booking_id (already shown above, linkedNote); the identical call scoped to a
  // DIFFERENT project's booking throws, and no row is written.
  // ---------------------------------------------------------------------------------------------
  const countBefore = (database.prepare("SELECT COUNT(*) AS count FROM project_communications").get() as { count: number }).count;
  const crossProjectFormData = new FormData();
  crossProjectFormData.set("channel", "note");
  crossProjectFormData.set("body", "This should not save — wrong project's booking.");
  crossProjectFormData.set("bookingId", "booking-mn-other");
  await assert.rejects(
    () => createProjectCommunicationFromForm("project-mn-1", crossProjectFormData),
    /Booking not found/,
  );
  const countAfter = (database.prepare("SELECT COUNT(*) AS count FROM project_communications").get() as { count: number }).count;
  assert.equal(countAfter, countBefore, "no row is written when the bookingId belongs to a different project");
  console.log("test 4 (linkage validation on create) passed");

  // ---------------------------------------------------------------------------------------------
  // Test 5 — create-time clamp on bookingId is an ALLOWLIST (B-5): an agent create with a bookingId
  // that WOULD validate (real booking, same project) still stores bookingId: null — proving the
  // clamp is an actor-type gate, not a fallback from a failed lookup. The system actor gets the
  // same null, proving the guard is `actorType === "admin" ? ... : null`, not
  // `actorType === "agent" ? null : ...` (which would let system/future actor types through).
  // ---------------------------------------------------------------------------------------------
  const agentLinked = await createProjectCommunicationFromAgent("project-mn-1", {
    channel: "note",
    body: "An agent-authored note that tries to claim a real booking link.",
    bookingId: "booking-mn-1",
  });
  assert.equal(agentLinked.bookingId, null, "agent create clamps bookingId to null even for a valid same-project booking");
  assert.deepEqual(
    database.prepare("SELECT booking_id FROM project_communications WHERE id = ?").get(agentLinked.id),
    { booking_id: null },
  );

  const systemLinked = await createProjectCommunicationFromSystem("project-mn-1", {
    channel: "note",
    body: "A sequence-runner note that also tries to claim a real booking link.",
    bookingId: "booking-mn-1",
  });
  assert.equal(systemLinked.bookingId, null, "system actor create also clamps bookingId to null (allowlist, not a denylist naming only 'agent')");
  console.log("test 5 (create-time clamp is an allowlist) passed");

  // ---------------------------------------------------------------------------------------------
  // Test 7(a) — update-path immutability: bookingId in the form/JSON body has ZERO effect on an
  // UNLINKED row — the update input type doesn't parse the field at all.
  // ---------------------------------------------------------------------------------------------
  const unlinkedForUpdate = await createProjectCommunicationFromForm("project-mn-1", (() => {
    const fd = new FormData();
    fd.set("channel", "note");
    fd.set("body", "An unlinked note used to prove update-time bookingId is inert.");
    return fd;
  })());
  assert.equal(unlinkedForUpdate.bookingId, null);

  const agentAttemptFormData = { bookingId: "booking-mn-1", body: "Agent tries to relink via update." };
  const agentUpdateResult = await updateProjectCommunicationFromAgent("project-mn-1", unlinkedForUpdate.id, agentAttemptFormData);
  assert.equal(agentUpdateResult.bookingId, null, "an agent update supplying bookingId has zero effect on an unlinked row");
  assert.deepEqual(
    database.prepare("SELECT booking_id, body FROM project_communications WHERE id = ?").get(unlinkedForUpdate.id),
    { booking_id: null, body: "Agent tries to relink via update." },
  );

  const formUpdateData = new FormData();
  formUpdateData.set("bookingId", "booking-mn-1");
  formUpdateData.set("body", "Admin form also tries to relink via update.");
  const formUpdateResult = await updateProjectCommunicationFromForm("project-mn-1", unlinkedForUpdate.id, formUpdateData);
  assert.equal(formUpdateResult.bookingId, null, "an admin form update supplying bookingId also has zero effect — relinking isn't supported in v1 (D4)");
  console.log("test 7a (update-path bookingId immutability) passed");

  // ---------------------------------------------------------------------------------------------
  // Test 7(b) — the B-1/D4 authority guard: updateProjectCommunicationFromAgent against an
  // EXISTING booking-linked row (created by the admin actor) with a changed body/status THROWS,
  // and the stored row is byte-for-byte unchanged afterward.
  // ---------------------------------------------------------------------------------------------
  const beforeAttack = database.prepare(`
    SELECT id, project_id, client_id, direction, channel, status, subject, body, recipient_name,
           recipient_email, scheduled_for, sent_at, source_type, source_id, booking_id, created_by,
           created_at, updated_at
    FROM project_communications WHERE id = ?
  `).get(linkedNote.id);

  await assert.rejects(
    () => updateProjectCommunicationFromAgent("project-mn-1", linkedNote.id, {
      body: "Forged: the agent claims Tyler decided something else on this call.",
      status: "sent",
    }),
    /Agents cannot modify a booking-linked meeting note\./,
  );

  const afterAttack = database.prepare(`
    SELECT id, project_id, client_id, direction, channel, status, subject, body, recipient_name,
           recipient_email, scheduled_for, sent_at, source_type, source_id, booking_id, created_by,
           created_at, updated_at
    FROM project_communications WHERE id = ?
  `).get(linkedNote.id);

  assert.deepEqual(afterAttack, beforeAttack, "an agent update to an existing booking-linked row is rejected and the row is byte-for-byte unchanged");
  console.log("test 7b (agent update to a booking-linked row throws, row unchanged) passed");

  // ---------------------------------------------------------------------------------------------
  // Test 7(c) — the identical call via the admin form succeeds normally, proving the guard is
  // agent-specific, not a blanket lock on linked rows.
  // ---------------------------------------------------------------------------------------------
  const adminUpdateFormData = new FormData();
  adminUpdateFormData.set("body", "Tyler's real update to his own booking-linked meeting note.");
  const adminUpdated = await updateProjectCommunicationFromForm("project-mn-1", linkedNote.id, adminUpdateFormData);
  assert.equal(adminUpdated.body, "Tyler's real update to his own booking-linked meeting note.");
  assert.equal(adminUpdated.bookingId, "booking-mn-1", "the linkage itself is untouched by the update (D4 — create-time only)");
  console.log("test 7c (admin form update to a booking-linked row succeeds) passed");

  console.log("meeting notes tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
