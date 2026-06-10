import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-client-link-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T18:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-bailey', 'Bailey', 'Bickley', 'bailey@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-bailey', 'Bailey & Parker Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blockedOrigin = await route.POST(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/clients/client-bailey/links", {
    method: "POST",
    body: new FormData(),
  }), { params: Promise.resolve({ id: "client-bailey" }) });
  assert.equal(blockedOrigin.status, 404);

  const formData = new FormData();
  formData.set("projectId", "project-bailey");
  formData.set("role", "bride");

  const response = await route.POST(new Request("https://studio.bythereeses.com/api/clients/client-bailey/links", {
    method: "POST",
    headers: { "x-reese-origin-secret": "origin-secret" },
    body: formData,
  }), { params: Promise.resolve({ id: "client-bailey" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.bythereeses.com/clients/client-bailey?saved=project-link");

  assert.deepEqual(database.prepare(`
    SELECT project_id, client_id, role, is_primary_contact
    FROM project_participants
    WHERE project_id = 'project-bailey' AND client_id = 'client-bailey'
  `).get(), {
    project_id: "project-bailey",
    client_id: "client-bailey",
    role: "bride",
    is_primary_contact: 0,
  });

  const activity = database.prepare("SELECT action, actor_type, actor_name, metadata FROM activity_logs ORDER BY created_at DESC LIMIT 1").get() as {
    action: string;
    actor_type: string;
    actor_name: string;
    metadata: string;
  };
  assert.equal(activity.action, "client.linked_to_project");
  assert.equal(activity.actor_type, "admin");
  assert.equal(activity.actor_name, "The Reeses Studio");
  assert.deepEqual(JSON.parse(activity.metadata), { role: "bride" });

  console.log("client link route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
