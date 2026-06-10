import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-client-merge-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "agent-token";

function jsonRequest(url: string, body: unknown, token = "agent-token") {
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
  const now = "2026-06-01T00:20:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, notes, created_at, updated_at)
    VALUES
      ('client-survivor', 'Alex', 'Taylor', 'alex@example.com', NULL, 'Keep this note.', ?, ?),
      ('client-duplicate', 'Alexandra', 'Taylor', 'alex.duplicate@example.com', '555-0199', 'Imported duplicate note.', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-duplicate', 'project-1', 'client-duplicate', 'primary', 1, ?)
  `).run(now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blockedOrigin = await route.POST(jsonRequest("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/agent/clients/client-survivor/merge", {
    duplicateClientId: "client-duplicate",
  }), { params: Promise.resolve({ id: "client-survivor" }) });
  assert.equal(blockedOrigin.status, 404);

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/clients/client-survivor/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ duplicateClientId: "client-duplicate" }),
  }), { params: Promise.resolve({ id: "client-survivor" }) });
  assert.equal(unauthorized.status, 401);

  const response = await route.POST(jsonRequest("https://studio.bythereeses.com/api/agent/clients/client-survivor/merge", {
    duplicateClientId: "client-duplicate",
  }), { params: Promise.resolve({ id: "client-survivor" }) });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    merge: {
      survivorClientId: "client-survivor",
      duplicateClientId: "client-duplicate",
      linkedProjectIds: ["project-1"],
    },
  });

  assert.equal(database.prepare("SELECT count(*) AS count FROM clients WHERE id = 'client-duplicate'").get().count, 0);
  assert.deepEqual(database.prepare(`
    SELECT client_id, role, is_primary_contact
    FROM project_participants
    WHERE project_id = 'project-1'
  `).get(), {
    client_id: "client-survivor",
    role: "primary",
    is_primary_contact: 1,
  });
  assert.deepEqual(database.prepare(`
    SELECT phone, notes
    FROM clients
    WHERE id = 'client-survivor'
  `).get(), {
    phone: "555-0199",
    notes: "Keep this note.\n\nMerged from Alexandra Taylor <alex.duplicate@example.com>:\nImported duplicate note.",
  });

  const activity = database.prepare("SELECT action, actor_type, actor_name, client_id FROM activity_logs WHERE action = 'client.merged'").get() as {
    action: string;
    actor_type: string;
    actor_name: string;
    client_id: string;
  };
  assert.equal(activity.client_id, "client-survivor");
  assert.equal(activity.actor_type, "agent");
  assert.equal(activity.actor_name, "The Reeses Studio Agent");

  console.log("agent client merge route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
