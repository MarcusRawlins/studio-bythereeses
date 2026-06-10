import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-communication-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";

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
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?),
      ('project-2', 'Other Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'discovery_call', 'Route communication source',
      'Client asked for proposal next steps.', 'Route source summary', 'Studio UI', ?, ?
    ), (
      'source-2', 'project-1', 'discovery_call', 'Corrected route communication source',
      'Client corrected proposal next steps.', 'Corrected route source summary', 'Studio UI', ?, ?
    ), (
      'other-source', 'project-2', 'discovery_call', 'Other route source',
      'Wrong route source body.', 'Wrong route summary', 'Studio UI', ?, ?
    )
  `).run(now, now, now, now, now, now);

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects/project-1/communications", {
    method: "POST",
    body: JSON.stringify({ body: "No token." }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(unauthorized.status, 401);

  const response = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/communications", {
    method: "POST",
    body: JSON.stringify({
      subject: "Proposal next steps",
      body: "Hi Alex, here is the follow-up from our discovery call.",
      sourceType: "project_source",
      sourceId: "source-1",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.communication.projectId, "project-1");
  assert.equal(body.communication.clientId, "client-1");
  assert.equal(body.communication.recipientEmail, "alex@example.com");
  assert.equal(body.communication.sourceType, "project_source");
  assert.equal(body.communication.sourceId, "source-1");

  assert.deepEqual(database.prepare(`
    SELECT subject, status, source_type, source_id
    FROM project_communications
    WHERE id = ?
  `).get(body.communication.id), {
    subject: "Proposal next steps",
    status: "draft",
    source_type: "project_source",
    source_id: "source-1",
  });

  const updateResponse = await route.PATCH(request(`https://studio.bythereeses.com/api/agent/projects/project-1/communications?id=${body.communication.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "sent",
      sentAt: "2026-05-29T14:00:00.000Z",
      body: "Hi Alex, this follow-up has been sent.",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(updateResponse.status, 200);
  const updateBody = await updateResponse.json();
  assert.equal(updateBody.communication.id, body.communication.id);
  assert.equal(updateBody.communication.status, "sent");
  assert.equal(updateBody.communication.sentAt, "2026-05-29T14:00:00.000Z");

  assert.deepEqual(database.prepare(`
    SELECT status, sent_at, body, source_type, source_id
    FROM project_communications
    WHERE id = ?
  `).get(body.communication.id), {
    status: "sent",
    sent_at: "2026-05-29T14:00:00.000Z",
    body: "Hi Alex, this follow-up has been sent.",
    source_type: "project_source",
    source_id: "source-1",
  });

  const relinkResponse = await route.PATCH(request(`https://studio.bythereeses.com/api/agent/projects/project-1/communications?id=${body.communication.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      sourceType: "project_source",
      sourceId: "source-2",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(relinkResponse.status, 200);
  const relinkBody = await relinkResponse.json();
  assert.equal(relinkBody.communication.id, body.communication.id);
  assert.equal(relinkBody.communication.sourceType, "project_source");
  assert.equal(relinkBody.communication.sourceId, "source-2");

  const wrongUpdateSource = await route.PATCH(request(`https://studio.bythereeses.com/api/agent/projects/project-1/communications?id=${body.communication.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      sourceType: "project_source",
      sourceId: "other-source",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(wrongUpdateSource.status, 400);
  assert.equal((await wrongUpdateSource.json()).error, "Project source not found.");

  const crossProjectUpdate = await route.PATCH(request(`https://studio.bythereeses.com/api/agent/projects/project-2/communications?id=${body.communication.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "archived" }),
  }), {
    params: Promise.resolve({ id: "project-2" }),
  });
  assert.equal(crossProjectUpdate.status, 400);
  assert.equal((await crossProjectUpdate.json()).error, "Communication not found.");

  const wrongSource = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/communications", {
    method: "POST",
    body: JSON.stringify({
      subject: "Wrong source",
      body: "This should not write.",
      sourceType: "project_source",
      sourceId: "other-source",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(wrongSource.status, 400);
  assert.equal((await wrongSource.json()).error, "Project source not found.");

  console.log("agent communication route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
