import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-locations-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "agent-token";

function authedRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: {
      authorization: "Bearer agent-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Agent Location Route Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'planning_call', 'Planning call',
      'Portrait garden source notes.', ?, ?
    )
  `).run(now, now);

  const createResponse = await route.POST(authedRequest("https://studio.bythereeses.com/api/agent/projects/project-1/locations", {
    type: "portrait",
    name: "Portrait garden",
    address: "12 Garden Lane",
    city: "Hudson",
    state: "NY",
    sourceType: "project_source",
    sourceId: "source-1",
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(createResponse.status, 201);
  const createBody = await createResponse.json() as {
    location: {
      id: string;
      projectId: string;
      name: string;
      sourceType: string | null;
      sourceId: string | null;
    };
  };
  assert.equal(createBody.location.projectId, "project-1");
  assert.equal(createBody.location.name, "Portrait garden");
  assert.equal(createBody.location.sourceType, "project_source");
  assert.equal(createBody.location.sourceId, "source-1");

  const updateResponse = await route.PATCH(authedRequest(`https://studio.bythereeses.com/api/agent/projects/project-1/locations?id=${createBody.location.id}`, {
    name: "Portrait garden west path",
    notes: "Updated from agent logistics pass.",
  }, "PATCH"), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(updateResponse.status, 200);
  const updateBody = await updateResponse.json() as {
    location: {
      id: string;
      name: string;
      notes: string | null;
      sourceType: string | null;
      sourceId: string | null;
    };
  };
  assert.equal(updateBody.location.id, createBody.location.id);
  assert.equal(updateBody.location.name, "Portrait garden west path");
  assert.equal(updateBody.location.notes, "Updated from agent logistics pass.");
  assert.equal(updateBody.location.sourceType, "project_source");
  assert.equal(updateBody.location.sourceId, "source-1");

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects/project-1/locations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Nope" }),
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(unauthorized.status, 401);

  console.log("agent location route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
