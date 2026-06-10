import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-client-merge-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { mergeClients } = await import("./crm");
  const database = rawDb();
  const now = "2026-05-31T13:00:00.000Z";
  const proposalTokenHash = "a".repeat(64);
  const portalTokenHash = "b".repeat(64);

  database.prepare(`
    INSERT INTO clients (
      id, first_name, last_name, email, phone, preferred_name,
      instagram_handle, communication_preference, referral_source, notes,
      created_at, updated_at
    ) VALUES (
      'client-survivor', 'Alex', 'Taylor', 'alex@example.com', NULL, 'Alex',
      '@alex', NULL, NULL, 'Keep this note.',
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (
      id, first_name, last_name, email, phone, preferred_name,
      instagram_handle, communication_preference, referral_source, notes,
      created_at, updated_at
    ) VALUES (
      'client-duplicate', 'Alexandra', 'Taylor', 'alex.duplicate@example.com', '555-0199', NULL,
      '@duplicate', 'Text for logistics.', 'HoneyBook import', 'Imported duplicate note.',
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-shared', 'Shared Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-duplicate-only', 'Duplicate Only Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-survivor-shared', 'project-shared', 'client-survivor', 'partner', 0, ?),
      ('participant-duplicate-shared', 'project-shared', 'client-duplicate', 'bride', 1, ?),
      ('participant-duplicate-only', 'project-duplicate-only', 'client-duplicate', 'primary', 1, ?)
  `).run(now, now, now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (id, slug, name, duration_minutes, buffer_minutes, created_at, updated_at)
    VALUES ('meeting-1', 'discovery', 'Discovery', 45, 15, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, client_id, attendee_name, attendee_email,
      start_at, end_at, status, source, created_at, updated_at
    ) VALUES (
      'booking-duplicate', 'meeting-1', 'project-duplicate-only', 'client-duplicate', 'Alex Taylor', 'alex.duplicate@example.com',
      '2026-06-01T14:00:00.000Z', '2026-06-01T14:45:00.000Z', 'confirmed', 'booking_link', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaires (id, title, status, created_at, updated_at)
    VALUES ('questionnaire-1', 'Timeline', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaire_responses (
      id, questionnaire_id, project_id, client_id, respondent_name, respondent_email,
      submitted_at, answers_json, created_at, updated_at
    ) VALUES (
      'response-duplicate', 'questionnaire-1', 'project-duplicate-only', 'client-duplicate',
      'Alex Taylor', 'alex.duplicate@example.com', NULL, '[]', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposals (id, project_id, title, status, total_cents, created_at, updated_at)
    VALUES ('proposal-1', 'project-duplicate-only', 'Proposal', 'sent', 100000, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposal_access_tokens (
      id, proposal_id, project_id, client_id, token_hash, label, expires_at, created_at
    ) VALUES (
      'proposal-token-duplicate', 'proposal-1', 'project-duplicate-only', 'client-duplicate',
      ?, 'Duplicate token', '2026-12-31T00:00:00.000Z', ?
    )
  `).run(proposalTokenHash, now);
  database.prepare(`
    INSERT INTO portal_access_tokens (
      id, project_id, client_id, token_hash, label, expires_at, created_at
    ) VALUES (
      'portal-token-duplicate', 'project-duplicate-only', 'client-duplicate',
      ?, 'Duplicate portal', '2026-12-31T00:00:00.000Z', ?
    )
  `).run(portalTokenHash, now);
  database.prepare(`
    INSERT INTO project_communications (
      id, project_id, client_id, direction, channel, status, body, created_at, updated_at
    ) VALUES (
      'communication-duplicate', 'project-duplicate-only', 'client-duplicate',
      'outbound', 'email', 'sent', 'Hello duplicate', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO activity_logs (id, project_id, client_id, action, actor_type, actor_name, metadata, created_at)
    VALUES ('activity-duplicate', NULL, 'client-duplicate', 'client.updated', 'admin', 'Tyler', '{}', ?)
  `).run(now);

  const result = await mergeClients({
    survivorClientId: "client-survivor",
    duplicateClientId: "client-duplicate",
    actorName: "Tyler",
  });

  assert.equal(result.survivorClientId, "client-survivor");
  assert.equal(result.duplicateClientId, "client-duplicate");
  assert.deepEqual(new Set(result.linkedProjectIds), new Set(["project-shared", "project-duplicate-only"]));

  assert.equal(database.prepare("SELECT count(*) AS count FROM clients WHERE id = 'client-duplicate'").get().count, 0);
  assert.deepEqual(database.prepare(`
    SELECT email, phone, preferred_name, instagram_handle, communication_preference, referral_source, notes
    FROM clients
    WHERE id = 'client-survivor'
  `).get(), {
    email: "alex@example.com",
    phone: "555-0199",
    preferred_name: "Alex",
    instagram_handle: "@alex",
    communication_preference: "Text for logistics.",
    referral_source: "HoneyBook import",
    notes: "Keep this note.\n\nMerged from Alexandra Taylor <alex.duplicate@example.com>:\nImported duplicate note.",
  });

  assert.deepEqual(database.prepare(`
    SELECT project_id, client_id, role, is_primary_contact
    FROM project_participants
    ORDER BY project_id
  `).all(), [
    { project_id: "project-duplicate-only", client_id: "client-survivor", role: "primary", is_primary_contact: 1 },
    { project_id: "project-shared", client_id: "client-survivor", role: "partner", is_primary_contact: 1 },
  ]);

  for (const table of [
    "scheduler_bookings",
    "questionnaire_responses",
    "proposal_access_tokens",
    "portal_access_tokens",
    "project_communications",
    "activity_logs",
  ]) {
    const duplicateCount = database.prepare(`SELECT count(*) AS count FROM ${table} WHERE client_id = 'client-duplicate'`).get().count;
    assert.equal(duplicateCount, 0, `${table} should not keep duplicate client_id references`);
    const survivorCount = database.prepare(`SELECT count(*) AS count FROM ${table} WHERE client_id = 'client-survivor'`).get().count;
    assert.ok(survivorCount > 0, `${table} should point to the survivor`);
  }

  const mergeActivity = database.prepare(`
    SELECT action, actor_type, actor_name, client_id, metadata
    FROM activity_logs
    WHERE action = 'client.merged'
  `).get() as { action: string; actor_type: string; actor_name: string; client_id: string; metadata: string };
  assert.equal(mergeActivity.client_id, "client-survivor");
  assert.equal(mergeActivity.actor_type, "admin");
  assert.equal(mergeActivity.actor_name, "Tyler");
  const metadata = JSON.parse(mergeActivity.metadata) as { duplicateClientId: string; movedProjectIds: string[] };
  assert.equal(metadata.duplicateClientId, "client-duplicate");
  assert.deepEqual(new Set(metadata.movedProjectIds), new Set(["project-shared", "project-duplicate-only"]));

  console.log("client merge tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
