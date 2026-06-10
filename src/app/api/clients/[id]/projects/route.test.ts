import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-client-project-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T16:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-bailey', 'Bailey', 'Bickley', 'bailey@example.com', ?, ?)
  `).run(now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blockedOrigin = await route.POST(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/clients/client-bailey/projects", {
    method: "POST",
    body: new FormData(),
  }), { params: Promise.resolve({ id: "client-bailey" }) });
  assert.equal(blockedOrigin.status, 404);

  const formData = new FormData();
  formData.set("projectName", "Bailey & Parker Wedding");
  formData.set("eventDate", "2027-05-15");
  formData.set("primaryClientRole", "bride");

  const response = await route.POST(new Request("https://studio.bythereeses.com/api/clients/client-bailey/projects", {
    method: "POST",
    headers: { "x-reese-origin-secret": "origin-secret" },
    body: formData,
  }), { params: Promise.resolve({ id: "client-bailey" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.bythereeses.com/clients/client-bailey?saved=project");

  const project = database.prepare(`
    SELECT p.name, pp.role, pp.is_primary_contact
    FROM projects p
    INNER JOIN project_participants pp ON pp.project_id = p.id
    WHERE pp.client_id = 'client-bailey'
  `).get() as { name: string; role: string; is_primary_contact: number };
  assert.deepEqual(project, {
    name: "Bailey & Parker Wedding",
    role: "bride",
    is_primary_contact: 1,
  });

  console.log("client project route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
