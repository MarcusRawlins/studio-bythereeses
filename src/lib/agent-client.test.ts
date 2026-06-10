import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-client-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getStudioProjectContext, searchStudioProjects } = await import("./studio-mcp");
  const { updateClientFromAgent } = await import("./crm");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (
      id, first_name, last_name, email, phone, preferred_name,
      instagram_handle, communication_preference, referral_source, notes,
      created_at, updated_at
    )
    VALUES (
      'client-1', 'Alex', 'Taylor', 'alex@example.com', '555-0100', 'Alex',
      '@oldalex', 'Email only', 'HoneyBook import', 'Old note',
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, preferred_name, notes, created_at, updated_at)
    VALUES ('client-2', 'Jordan', 'Taylor', 'jordan@example.com', '555-0101', 'Jordan', NULL, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);

  const { client, linkedProjectIds } = await updateClientFromAgent("client-1", {
    firstName: "Alexandra",
    lastName: "Reese",
    preferredName: "Lex",
    email: "LEX@EXAMPLE.COM",
    phone: "555-0199",
    instagramHandle: "lex.reese",
    communicationPreference: "Text for quick logistics, email for contracts.",
    referralSource: "Planner referral",
    notes: "Updated from discovery call.",
  });

  assert.equal(client.id, "client-1");
  assert.deepEqual(linkedProjectIds, ["project-1"]);
  assert.equal(client.email, "lex@example.com");
  assert.deepEqual(database.prepare(`
    SELECT
      first_name, last_name, preferred_name, email, phone,
      instagram_handle, communication_preference, referral_source, notes
    FROM clients
    WHERE id = 'client-1'
  `).get(), {
    first_name: "Alexandra",
    last_name: "Reese",
    preferred_name: "Lex",
    email: "lex@example.com",
    phone: "555-0199",
    instagram_handle: "@lex.reese",
    communication_preference: "Text for quick logistics, email for contracts.",
    referral_source: "Planner referral",
    notes: "Updated from discovery call.",
  });

  const projectContext = await getStudioProjectContext("project-1");
  assert.equal(projectContext.clients[0].firstName, "Alexandra");
  assert.equal(projectContext.clients[0].email, "lex@example.com");
  assert.equal(projectContext.clients[0].instagramHandle, "@lex.reese");

  const searchResults = await searchStudioProjects({ query: "lex@example.com" });
  assert.equal(searchResults[0].id, "project-1");
  assert.equal(searchResults[0].primaryClient.email, "lex@example.com");

  const activity = database.prepare("SELECT action, actor_type, actor_name, metadata FROM activity_logs").get() as {
    action: string;
    actor_type: string;
    actor_name: string;
    metadata: string;
  };
  assert.equal(activity.action, "client.updated_by_agent");
  assert.equal(activity.actor_type, "agent");
  assert.equal(activity.actor_name, "The Reeses Studio Agent");
  const metadata = JSON.parse(activity.metadata) as { clientEmail: string; changedFields: string[] };
  assert.equal(metadata.clientEmail, "lex@example.com");
  assert.deepEqual(new Set(metadata.changedFields), new Set([
    "firstName",
    "lastName",
    "email",
    "phone",
    "preferredName",
    "instagramHandle",
    "communicationPreference",
    "referralSource",
    "notes",
  ]));

  await assert.rejects(
    () => updateClientFromAgent("client-2", { email: "lex@example.com" }),
    /Another client already uses this email/,
  );

  assert.deepEqual(database.prepare("SELECT email FROM clients WHERE id = 'client-2'").get(), {
    email: "jordan@example.com",
  });

  console.log("agent client tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
