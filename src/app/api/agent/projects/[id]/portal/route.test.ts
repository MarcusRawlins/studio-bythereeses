import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-portal-link-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";
process.env.NEXT_PUBLIC_APP_URL = "https://studio.bythereeses.com";

function request(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Agent Portal Link Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Other Agent Portal Link Wedding', 'wedding', 'planning', 'active', ?, ?)
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

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects/project-1/portal", {
    method: "POST",
    body: JSON.stringify({ clientId: "client-1" }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(unauthorized.status, 401);

  process.env.ORIGIN_PROXY_SECRET = "proxy-secret";
  const blockedWorker = await route.POST(request("https://reese-photography-crm.example.workers.dev/api/agent/projects/project-1/portal", {
    method: "POST",
    body: JSON.stringify({ clientId: "client-1" }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(blockedWorker.status, 404);
  delete process.env.ORIGIN_PROXY_SECRET;

  const wrongClient = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/portal", {
    method: "POST",
    body: JSON.stringify({ clientId: "client-2" }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(wrongClient.status, 400);
  assert.deepEqual(await wrongClient.json(), { error: "Portal client is not linked to this project." });
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM portal_access_tokens").get(), { count: 0 });

  const response = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/portal", {
    method: "POST",
    body: JSON.stringify({
      clientId: "client-1",
      label: "Agent-created client portal link",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.link.projectId, "project-1");
  assert.equal(body.link.clientId, "client-1");
  assert.equal(body.link.label, "Agent-created client portal link");
  assert.match(body.link.url, /^https:\/\/studio\.bythereeses\.com\/p\//);
  assert.equal(typeof body.link.tokenId, "string");
  assert.match(body.link.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(database.prepare(`
    SELECT project_id, client_id, label, length(token_hash) AS hash_length, revoked_at
    FROM portal_access_tokens
  `).get(), {
    project_id: "project-1",
    client_id: "client-1",
    label: "Agent-created client portal link",
    hash_length: 64,
    revoked_at: null,
  });
  const activity = database.prepare("SELECT action, actor_type, actor_name FROM activity_logs ORDER BY created_at DESC LIMIT 1").get();
  assert.deepEqual(activity, {
    action: "portal_token.generated",
    actor_type: "agent",
    actor_name: "The Reeses Studio Agent",
  });

  console.log("agent portal link route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
