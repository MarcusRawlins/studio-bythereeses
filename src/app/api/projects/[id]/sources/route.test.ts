import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-sources-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

function sourceForm(body = "Discovery transcript v1.") {
  const formData = new FormData();
  formData.set("kind", "discovery_call");
  formData.set("title", "Discovery call transcript");
  formData.set("body", body);
  formData.set("summary", "Planning context for proposal and timeline.");
  formData.set("occurredAt", "2026-05-29T14:00");
  formData.set("externalUrl", "https://example.com/discovery-call");
  formData.set("sourceType", "call_recording");
  formData.set("sourceId", "call-123");
  return formData;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Sources Route Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);

  const missingProjectConsoleError = console.error;
  console.error = () => {};
  const missingProjectResponse = await POST(new Request("https://studio.test/api/projects/missing-project/sources", {
    method: "POST",
    body: sourceForm(),
  }), { params: Promise.resolve({ id: "missing-project" }) }).finally(() => {
    console.error = missingProjectConsoleError;
  });

  assert.equal(missingProjectResponse.status, 400);
  assert.deepEqual(await missingProjectResponse.json(), { error: "Project not found." });
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM project_sources").get(), { count: 0 });

  const response = await POST(new Request("https://studio.test/api/projects/project-1/sources", {
    method: "POST",
    body: sourceForm(),
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.test/projects/project-1?saved=source");
  const created = database.prepare(`
    SELECT project_id, kind, title, body, summary, occurred_at, external_url, captured_by, source_type, source_id
    FROM project_sources
  `).get();
  assert.deepEqual(created, {
    project_id: "project-1",
    kind: "discovery_call",
    title: "Discovery call transcript",
    body: "Discovery transcript v1.",
    summary: "Planning context for proposal and timeline.",
    occurred_at: "2026-05-29T14:00",
    external_url: "https://example.com/discovery-call",
    captured_by: "Studio UI",
    source_type: "call_recording",
    source_id: "call-123",
  });

  const retryResponse = await POST(new Request("https://studio.test/api/projects/project-1/sources", {
    method: "POST",
    body: sourceForm("Discovery transcript v2 with corrections."),
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(retryResponse.status, 303);
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM project_sources").get(), { count: 1 });
  assert.deepEqual(database.prepare("SELECT body FROM project_sources").get(), {
    body: "Discovery transcript v2 with corrections.",
  });
  assert.deepEqual(database.prepare(`
    SELECT action, actor_type, actor_name
    FROM activity_logs
    ORDER BY created_at
  `).all(), [
    {
      action: "project.source.created",
      actor_type: "admin",
      actor_name: "Studio UI",
    },
    {
      action: "project.source.updated",
      actor_type: "admin",
      actor_name: "Studio UI",
    },
  ]);

  console.log("project sources route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
