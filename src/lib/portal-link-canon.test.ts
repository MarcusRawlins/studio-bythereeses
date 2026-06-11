import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-portal-link-canon-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

function portalForm(projectId: string, clientId?: string) {
  const formData = new FormData();
  formData.set("projectId", projectId);
  if (clientId) formData.set("clientId", clientId);
  return formData;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { createPortalLinkFromForm, revokePortalTokenFromForm } = await import("./crm");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Portal Link Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Other Portal Link Wedding', 'wedding', 'planning', 'active', ?, ?)
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

  await assert.rejects(
    () => createPortalLinkFromForm(portalForm("missing-project", "client-1")),
    /Project not found/,
  );

  await assert.rejects(
    () => createPortalLinkFromForm(portalForm("project-1", "client-2")),
    /Portal client is not linked to this project/,
  );

  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM portal_access_tokens").get(), { count: 0 });
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM activity_logs").get(), { count: 0 });

  const result = await createPortalLinkFromForm(portalForm("project-1", "client-1"));
  assert.equal(result.projectId, "project-1");
  assert.match(result.url, /\/p\//);

  assert.deepEqual(database.prepare(`
    SELECT project_id, client_id, label
    FROM portal_access_tokens
  `).get(), {
    project_id: "project-1",
    client_id: "client-1",
    label: "Client portal link",
  });
  assert.deepEqual(database.prepare(`
    SELECT action, project_id, client_id
    FROM activity_logs
  `).get(), {
    action: "portal_token.generated",
    project_id: "project-1",
    client_id: "client-1",
  });

  const tokenRow = database.prepare("SELECT id FROM portal_access_tokens WHERE project_id = 'project-1'").get() as { id: string };
  const revokeFormData = new FormData();
  revokeFormData.set("projectId", "project-1");
  revokeFormData.set("tokenId", tokenRow.id);

  await revokePortalTokenFromForm(revokeFormData);
  const firstRevokedAt = (database.prepare("SELECT revoked_at FROM portal_access_tokens WHERE id = ?").get(tokenRow.id) as { revoked_at: string }).revoked_at;
  await revokePortalTokenFromForm(revokeFormData);

  assert.equal(
    (database.prepare("SELECT revoked_at FROM portal_access_tokens WHERE id = ?").get(tokenRow.id) as { revoked_at: string }).revoked_at,
    firstRevokedAt,
  );
  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM activity_logs
    WHERE action = 'portal_token.revoked'
  `).get(), { count: 1 });

  console.log("portal link canon tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
