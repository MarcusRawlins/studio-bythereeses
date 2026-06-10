import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-project-client-link-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";

function request(url: string, body: unknown, token = "secret") {
  return new Request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T18:15:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-bailey', 'Bailey', 'Bickley', 'bailey@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-bailey', 'Bailey & Parker Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blockedOrigin = await route.POST(request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/agent/projects/project-bailey/clients", {
    clientId: "client-bailey",
    role: "bride",
  }), { params: Promise.resolve({ id: "project-bailey" }) });
  assert.equal(blockedOrigin.status, 404);

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects/project-bailey/clients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "client-bailey", role: "bride" }),
  }), { params: Promise.resolve({ id: "project-bailey" }) });
  assert.equal(unauthorized.status, 401);

  const response = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-bailey/clients", {
    clientId: "client-bailey",
    role: "bride",
  }), { params: Promise.resolve({ id: "project-bailey" }) });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    link: {
      clientId: "client-bailey",
      projectId: "project-bailey",
      linked: true,
      updated: false,
      role: "bride",
    },
  });

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

  const activity = database.prepare("SELECT action, actor_type, actor_name FROM activity_logs ORDER BY created_at DESC LIMIT 1").get() as {
    action: string;
    actor_type: string;
    actor_name: string;
  };
  assert.equal(activity.action, "client.linked_to_project");
  assert.equal(activity.actor_type, "agent");
  assert.equal(activity.actor_name, "The Reeses Studio Agent");

  console.log("agent project client link route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
