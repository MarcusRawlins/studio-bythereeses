import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-crm-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

// Phase 20 (meeting/consult notes) — Test 8: `getProject`'s bookings-query gating matrix
// (crm.ts:563, D6). Spies on the underlying sqlite `prepare` calls whose SQL joins
// scheduler_bookings to scheduler_meeting_types — that join is unique to this one query in
// getProject — to prove the query is issued exactly 0 times with both flags off and exactly once
// with either flag alone on (never twice, independent of the other flag).
function countBookingsQueryCalls(database: { prepare: (sql: string) => unknown }, fn: () => Promise<unknown>) {
  const original = database.prepare.bind(database);
  let calls = 0;
  database.prepare = ((sql: string) => {
    if (sql.includes("scheduler_bookings") && sql.includes("scheduler_meeting_types")) {
      calls += 1;
    }
    return original(sql);
  }) as typeof database.prepare;

  return fn().then((result) => {
    database.prepare = original;
    return { result, calls };
  });
}

async function main() {
  delete process.env.PROJECT_PROGRESS_TIMELINE;
  delete process.env.MEETING_NOTES_ENABLED;

  const { rawDb } = await import("@/db/client");
  const { getProject } = await import("./crm");
  const database = rawDb();
  const now = "2026-07-01T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-crm-1', 'Bookings Gating Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-crm-1', 'Jordan', 'Reese', 'jordan@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-crm-1', 'project-crm-1', 'client-crm-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (id, slug, name, duration_minutes, buffer_minutes, created_at, updated_at)
    VALUES ('meeting-crm-1', 'crm-consult', 'Discovery Call', 30, 15, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, attendee_name, attendee_email, start_at, end_at, created_at, updated_at
    ) VALUES (
      'booking-crm-1', 'meeting-crm-1', 'project-crm-1', 'Jordan Reese', 'jordan@example.com',
      '2026-07-05T14:00:00.000Z', '2026-07-05T14:30:00.000Z', ?, ?
    )
  `).run(now, now);

  // Both flags off: `bookings: []`, zero bookings queries issued.
  const offRun = await countBookingsQueryCalls(database, () => getProject("project-crm-1"));
  assert.deepEqual((offRun.result as { bookings: unknown[] }).bookings, [], "bookings is [] when both flags are off");
  assert.equal(offRun.calls, 0, "the bookings query is never issued when both flags are off");

  // PROJECT_PROGRESS_TIMELINE alone on: query runs exactly once.
  process.env.PROJECT_PROGRESS_TIMELINE = "1";
  const timelineRun = await countBookingsQueryCalls(database, () => getProject("project-crm-1"));
  assert.equal(timelineRun.calls, 1, "the bookings query runs exactly once when PROJECT_PROGRESS_TIMELINE alone is on");
  assert.equal((timelineRun.result as { bookings: Array<{ id: string }> }).bookings.length, 1);
  assert.equal((timelineRun.result as { bookings: Array<{ id: string }> }).bookings[0].id, "booking-crm-1");
  delete process.env.PROJECT_PROGRESS_TIMELINE;

  // MEETING_NOTES_ENABLED alone on: same query, same rows, still exactly once (D6 — one shared
  // gate, not a second query).
  process.env.MEETING_NOTES_ENABLED = "1";
  const meetingNotesRun = await countBookingsQueryCalls(database, () => getProject("project-crm-1"));
  assert.equal(meetingNotesRun.calls, 1, "the bookings query runs exactly once when MEETING_NOTES_ENABLED alone is on");
  assert.equal((meetingNotesRun.result as { bookings: Array<{ id: string }> }).bookings.length, 1);
  assert.equal((meetingNotesRun.result as { bookings: Array<{ id: string }> }).bookings[0].id, "booking-crm-1");
  delete process.env.MEETING_NOTES_ENABLED;

  // Both flags on: still exactly once — independent flags, not a double query.
  process.env.PROJECT_PROGRESS_TIMELINE = "1";
  process.env.MEETING_NOTES_ENABLED = "1";
  const bothRun = await countBookingsQueryCalls(database, () => getProject("project-crm-1"));
  assert.equal(bothRun.calls, 1, "the bookings query runs exactly once when both flags are on");
  delete process.env.PROJECT_PROGRESS_TIMELINE;
  delete process.env.MEETING_NOTES_ENABLED;

  console.log("crm getProject bookings-gating tests passed (test 8)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
