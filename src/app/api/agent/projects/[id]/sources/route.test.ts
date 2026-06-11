import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-source-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "test-token";

async function main() {
  const { rawDb } = await import("@/db/client");
  const { GET, POST, PATCH } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);

  const postResponse = await POST(new Request("https://studio.test/api/agent/projects/project-1/sources", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kind: "discovery_call",
      title: "Discovery call transcript",
      body: "Client wants proposal, timeline, and payment plan from the call.",
      summary: "Discovery notes for agent drafting.",
      occurredAt: "2026-05-28T19:00:00.000Z",
      sourceType: "call_transcript",
      sourceId: "call-route-1",
    }),
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(postResponse.status, 201);
  const postBody = await postResponse.json();
  assert.equal(postBody.projectSource.projectId, "project-1");
  assert.equal(postBody.projectSource.kind, "discovery_call");
  assert.equal(postBody.projectSource.title, "Discovery call transcript");

  const patchResponse = await PATCH(new Request(`https://studio.test/api/agent/projects/project-1/sources?id=${postBody.projectSource.id}`, {
    method: "PATCH",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "Discovery call transcript - corrected",
      body: "Corrected source text for proposal, invoice, and timeline drafting.",
      summary: "Corrected discovery notes.",
      metadata: { final: true },
    }),
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(patchResponse.status, 200);
  const patchBody = await patchResponse.json();
  assert.equal(patchBody.projectSource.id, postBody.projectSource.id);
  assert.equal(patchBody.projectSource.title, "Discovery call transcript - corrected");
  assert.equal(patchBody.projectSource.body, "Corrected source text for proposal, invoice, and timeline drafting.");

  const getResponse = await GET(new Request("https://studio.test/api/agent/projects/project-1/sources", {
    headers: { authorization: "Bearer test-token" },
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(getResponse.status, 200);
  const getBody = await getResponse.json();
  assert.deepEqual(getBody.projectSources.map((source: { id: string; kind: string; title: string }) => ({
    id: source.id,
    kind: source.kind,
    title: source.title,
  })), [
    {
      id: postBody.projectSource.id,
      kind: "discovery_call",
      title: "Discovery call transcript - corrected",
    },
  ]);

  const missingSourceId = await PATCH(new Request("https://studio.test/api/agent/projects/project-1/sources", {
    method: "PATCH",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "Missing id" }),
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(missingSourceId.status, 400);
  assert.deepEqual(await missingSourceId.json(), { error: "Project source id is required." });

  const unauthorized = await POST(new Request("https://studio.test/api/agent/projects/project-1/sources", {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ kind: "discovery_call", title: "Nope", body: "Nope" }),
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(unauthorized.status, 401);

  console.log("agent source route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
