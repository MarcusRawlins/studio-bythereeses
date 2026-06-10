import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-portal-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

function form(clientId: string) {
  const formData = new FormData();
  formData.set("clientId", clientId);
  return formData;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Portal Route Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Wrong Portal Route Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-1', 'Avery', 'Stone', 'avery@example.com', ?, ?),
      ('client-2', 'Wrong', 'Client', 'wrong@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-1', 'project-1', 'client-1', 'primary', 1, ?),
      ('participant-2', 'project-2', 'client-2', 'primary', 1, ?)
  `).run(now, now);

  const originalConsoleError = console.error;
  console.error = () => {};
  const wrongResponse = await POST(new Request("https://studio.test/api/projects/project-1/portal", {
    method: "POST",
    body: form("client-2"),
  }), { params: Promise.resolve({ id: "project-1" }) }).finally(() => {
    console.error = originalConsoleError;
  });

  assert.equal(wrongResponse.status, 400);
  assert.deepEqual(await wrongResponse.json(), { error: "Portal client is not linked to this project." });
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM portal_access_tokens").get(), { count: 0 });

  const response = await POST(new Request("https://studio.test/api/projects/project-1/portal", {
    method: "POST",
    body: form("client-1"),
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(response.status, 303);
  const location = response.headers.get("location") ?? "";
  assert.match(location, /^https:\/\/studio\.test\/projects\/project-1\?portalLink=/);
  assert.deepEqual(database.prepare(`
    SELECT project_id, client_id
    FROM portal_access_tokens
  `).get(), {
    project_id: "project-1",
    client_id: "client-1",
  });

  console.log("project portal route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
