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

  console.log("project communication route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
