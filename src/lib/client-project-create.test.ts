import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-client-project-create-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { createProjectForExistingClientFromForm } = await import("./crm");
  const database = rawDb();
  const now = "2026-05-31T15:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-bailey', 'Bailey', 'Bickley', 'bailey@example.com', ?, ?)
  `).run(now, now);

  const formData = new FormData();
  formData.set("clientId", "client-bailey");
  formData.set("projectName", "Bailey & Parker Wedding");
  formData.set("type", "wedding");
  formData.set("stage", "inquiry");
  formData.set("eventDate", "2027-05-15");
  formData.set("venueName", "The Foundry");
  formData.set("budget", "7500");
  formData.set("primaryClientRole", "bride");

  const result = await createProjectForExistingClientFromForm(formData);

  assert.equal(result.clientId, "client-bailey");
  assert.equal(result.project.name, "Bailey & Parker Wedding");
  assert.equal(result.project.eventDate, "2027-05-15");
  assert.equal(result.project.budgetCents, 750000);

  const participant = database.prepare(`
    SELECT project_id, client_id, role, is_primary_contact
    FROM project_participants
    WHERE client_id = 'client-bailey'
  `).get() as { project_id: string; client_id: string; role: string; is_primary_contact: number };
  assert.equal(participant.project_id, result.project.id);
  assert.equal(participant.role, "bride");
  assert.equal(participant.is_primary_contact, 1);

  const activity = database.prepare(`
    SELECT project_id, client_id, action, metadata
    FROM activity_logs
    WHERE action = 'project.created_from_existing_client'
  `).get() as { project_id: string; client_id: string; action: string; metadata: string };
  assert.equal(activity.project_id, result.project.id);
  assert.equal(activity.client_id, "client-bailey");
  assert.deepEqual(JSON.parse(activity.metadata), {
    projectName: "Bailey & Parker Wedding",
    clientEmail: "bailey@example.com",
  });

  console.log("client project create tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
