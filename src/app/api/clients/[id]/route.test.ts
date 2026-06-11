import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-client-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getStudioProjectContext, searchStudioProjects } = await import("@/lib/studio-mcp");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, preferred_name, notes, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', '555-0100', 'Alex', 'Old note', ?, ?)
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

  const formData = new FormData();
  formData.set("firstName", "Alexandra");
  formData.set("lastName", "Reese");
  formData.set("preferredName", "Lex");
  formData.set("email", "LEX@EXAMPLE.COM");
  formData.set("phone", "555-0199");
  formData.set("notes", "Updated once, visible everywhere.");

  const response = await route.POST(new Request("https://studio.bythereeses.com/api/clients/client-1", {
    method: "POST",
    body: formData,
  }), {
    params: Promise.resolve({ id: "client-1" }),
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.bythereeses.com/clients/client-1?saved=client");

  assert.deepEqual(database.prepare(`
    SELECT first_name, last_name, preferred_name, email, phone, notes
    FROM clients
    WHERE id = 'client-1'
  `).get(), {
    first_name: "Alexandra",
    last_name: "Reese",
    preferred_name: "Lex",
    email: "lex@example.com",
    phone: "555-0199",
    notes: "Updated once, visible everywhere.",
  });

  const projectContext = await getStudioProjectContext("project-1");
  assert.deepEqual(projectContext.clients[0], {
    id: "client-1",
    firstName: "Alexandra",
    lastName: "Reese",
    email: "lex@example.com",
    phone: "555-0199",
    preferredName: "Lex",
    instagramHandle: null,
    communicationPreference: null,
    referralSource: null,
    role: "primary",
    isPrimaryContact: true,
  });

  const searchResults = await searchStudioProjects({ query: "lex@example.com" });
  assert.equal(searchResults[0].id, "project-1");
  assert.equal(searchResults[0].primaryClient.name, "Alexandra Reese");
  assert.equal(searchResults[0].primaryClient.email, "lex@example.com");

  const activity = database.prepare("SELECT action, metadata FROM activity_logs").get() as {
    action: string;
    metadata: string;
  };
  assert.equal(activity.action, "client.updated");
  const metadata = JSON.parse(activity.metadata) as { clientEmail: string; changedFields: string[] };
  assert.equal(metadata.clientEmail, "lex@example.com");
  assert.deepEqual(new Set(metadata.changedFields), new Set(["firstName", "lastName", "email", "phone", "preferredName", "notes"]));

  const duplicateEmailForm = new FormData();
  duplicateEmailForm.set("firstName", "Jordan");
  duplicateEmailForm.set("lastName", "Taylor");
  duplicateEmailForm.set("email", "LEX@example.com");

  const duplicateEmailResponse = await route.POST(new Request("https://studio.bythereeses.com/api/clients/client-2", {
    method: "POST",
    body: duplicateEmailForm,
  }), {
    params: Promise.resolve({ id: "client-2" }),
  });
  assert.equal(duplicateEmailResponse.status, 400);
  assert.deepEqual(await duplicateEmailResponse.json(), {
    error: "Another client already uses this email.",
  });
  assert.deepEqual(database.prepare(`
    SELECT email
    FROM clients
    WHERE id = 'client-2'
  `).get(), {
    email: "jordan@example.com",
  });

  console.log("client route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
