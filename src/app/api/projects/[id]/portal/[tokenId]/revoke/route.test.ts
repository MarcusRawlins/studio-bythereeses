import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-portal-revoke-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Portal Revoke Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Wrong Portal Revoke Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, email, created_at, updated_at)
    VALUES ('client-1', 'Avery', 'avery@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO portal_access_tokens (
      id, project_id, client_id, token_hash, label, expires_at, revoked_at, created_at
    ) VALUES
      (
        'token-1', 'project-1', 'client-1',
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        'Client portal link', ?, NULL, ?
      ),
      (
        'token-2', 'project-2', NULL,
        '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        'Wrong portal link', ?, NULL, ?
      )
  `).run("2026-06-29T12:00:00.000Z", now, "2026-06-29T12:00:00.000Z", now);

  const originalConsoleError = console.error;
  console.error = () => {};
  const wrongProjectResponse = await POST(new Request("https://studio.test/api/projects/project-1/portal/token-2/revoke", {
    method: "POST",
    body: new FormData(),
  }), { params: Promise.resolve({ id: "project-1", tokenId: "token-2" }) }).finally(() => {
    console.error = originalConsoleError;
  });

  assert.equal(wrongProjectResponse.status, 400);
  assert.deepEqual(await wrongProjectResponse.json(), { error: "Portal token was not found for this project." });
  assert.deepEqual(database.prepare("SELECT revoked_at FROM portal_access_tokens WHERE id = 'token-2'").get(), {
    revoked_at: null,
  });

  const response = await POST(new Request("https://studio.test/api/projects/project-1/portal/token-1/revoke", {
    method: "POST",
    body: new FormData(),
  }), { params: Promise.resolve({ id: "project-1", tokenId: "token-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.test/projects/project-1");
  const revoked = database.prepare("SELECT revoked_at FROM portal_access_tokens WHERE id = 'token-1'").get() as {
    revoked_at: string | null;
  };
  assert.ok(revoked.revoked_at, "route should revoke the project-scoped portal token");

  assert.deepEqual(database.prepare(`
    SELECT action, project_id, client_id
    FROM activity_logs
    WHERE action = 'portal_token.revoked'
  `).get(), {
    action: "portal_token.revoked",
    project_id: "project-1",
    client_id: "client-1",
  });

  console.log("project portal revoke route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
