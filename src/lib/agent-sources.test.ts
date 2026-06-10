import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-sources-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { createProjectSourceFromAgent, createProjectSourceFromForm, listProjectSources, updateProjectSourceFromAgent } = await import("./agent-sources");
  const { createAgentTask } = await import("./agent-tasks");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);

  const source = await createProjectSourceFromAgent("project-1", {
    kind: "discovery_call",
    title: "Discovery call with Alex and Jordan",
    body: "They care about documentary coverage, family candids, and a calm timeline.",
    summary: "Discovery call notes for proposal and timeline drafting.",
    occurredAt: "2026-05-28T19:00:00.000Z",
    externalUrl: "https://example.com/calls/alex-jordan",
    capturedBy: "Call Notes Agent",
    sourceType: "call_transcript",
    sourceId: "call-1",
    metadata: { durationMinutes: 42, platform: "Zoom" },
  });

  assert.equal(source.projectId, "project-1");
  assert.equal(source.kind, "discovery_call");
  assert.equal(source.title, "Discovery call with Alex and Jordan");
  assert.equal(source.body, "They care about documentary coverage, family candids, and a calm timeline.");
  assert.equal(source.capturedBy, "Call Notes Agent");

  const stored = database.prepare(`
    SELECT project_id, kind, title, body, summary, occurred_at, external_url, captured_by, source_type, source_id, metadata_json
    FROM project_sources
    WHERE id = ?
  `).get(source.id) as {
    project_id: string;
    kind: string;
    title: string;
    body: string;
    summary: string;
    occurred_at: string;
    external_url: string;
    captured_by: string;
    source_type: string;
    source_id: string;
    metadata_json: string;
  };

  assert.deepEqual({
    projectId: stored.project_id,
    kind: stored.kind,
    title: stored.title,
    body: stored.body,
    summary: stored.summary,
    occurredAt: stored.occurred_at,
    externalUrl: stored.external_url,
    capturedBy: stored.captured_by,
    sourceType: stored.source_type,
    sourceId: stored.source_id,
    metadata: JSON.parse(stored.metadata_json),
  }, {
    projectId: "project-1",
    kind: "discovery_call",
    title: "Discovery call with Alex and Jordan",
    body: "They care about documentary coverage, family candids, and a calm timeline.",
    summary: "Discovery call notes for proposal and timeline drafting.",
    occurredAt: "2026-05-28T19:00:00.000Z",
    externalUrl: "https://example.com/calls/alex-jordan",
    capturedBy: "Call Notes Agent",
    sourceType: "call_transcript",
    sourceId: "call-1",
    metadata: { durationMinutes: 42, platform: "Zoom" },
  });

  const updatedSource = await createProjectSourceFromAgent("project-1", {
    kind: "discovery_call",
    title: "Discovery call with Alex and Jordan - cleaned transcript",
    body: "Updated transcript summary with final proposal direction and timeline preferences.",
    summary: "Cleaned discovery call notes for proposal drafting.",
    occurredAt: "2026-05-28T19:30:00.000Z",
    externalUrl: "https://example.com/calls/alex-jordan-clean",
    capturedBy: "Call Notes Agent",
    sourceType: "call_transcript",
    sourceId: "call-1",
    metadata: { durationMinutes: 43, platform: "Zoom", cleaned: true },
  });

  assert.equal(updatedSource.id, source.id, "re-ingesting the same external source should update the canonical source row");
  assert.equal(updatedSource.title, "Discovery call with Alex and Jordan - cleaned transcript");
  assert.equal(updatedSource.body, "Updated transcript summary with final proposal direction and timeline preferences.");
  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM project_sources
    WHERE project_id = 'project-1' AND source_type = 'call_transcript' AND source_id = 'call-1'
  `).get(), { count: 1 });

  const revisedCanonicalSource = await updateProjectSourceFromAgent("project-1", source.id, {
    title: "Discovery call with Alex and Jordan - final cleaned source",
    body: "Final cleaned call source with exact package notes and timeline assumptions.",
    summary: "Final source for proposal, invoice, and timeline work.",
    metadata: { durationMinutes: 43, platform: "Zoom", cleaned: true, final: true },
  });

  assert.equal(revisedCanonicalSource.id, source.id);
  assert.equal(revisedCanonicalSource.title, "Discovery call with Alex and Jordan - final cleaned source");
  assert.equal(revisedCanonicalSource.body, "Final cleaned call source with exact package notes and timeline assumptions.");
  assert.deepEqual(database.prepare(`
    SELECT title, body, summary, source_type, source_id, metadata_json
    FROM project_sources
    WHERE id = ?
  `).get(source.id), {
    title: "Discovery call with Alex and Jordan - final cleaned source",
    body: "Final cleaned call source with exact package notes and timeline assumptions.",
    summary: "Final source for proposal, invoice, and timeline work.",
    source_type: "call_transcript",
    source_id: "call-1",
    metadata_json: JSON.stringify({ durationMinutes: 43, platform: "Zoom", cleaned: true, final: true }),
  });

  const sources = await listProjectSources("project-1");
  assert.deepEqual(sources.map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    sourceType: item.sourceType,
    sourceId: item.sourceId,
  })), [
    {
      id: source.id,
      kind: "discovery_call",
      title: "Discovery call with Alex and Jordan - final cleaned source",
      sourceType: "call_transcript",
      sourceId: "call-1",
    },
  ]);

  const task = await createAgentTask({
    projectId: "project-1",
    title: "Create proposal from discovery source",
    instructions: "Use the canonical source record and return proposal assumptions.",
    sourceType: "project_source",
    sourceId: source.id,
  });
  assert.equal(task.sourceType, "project_source");
  assert.equal(task.sourceId, source.id);

  const formData = new FormData();
  formData.set("kind", "planning_note");
  formData.set("title", "Admin planning note");
  formData.set("body", "Tyler added a planning note from the project page.");
  formData.set("summary", "Human-entered planning context.");
  formData.set("occurredAt", "2026-05-29T13:00:00.000Z");
  formData.set("externalUrl", "https://example.com/admin-note");
  formData.set("sourceType", "studio_project");
  formData.set("sourceId", "manual-note-1");

  const adminSource = await createProjectSourceFromForm("project-1", formData);
  assert.equal(adminSource.projectId, "project-1");
  assert.equal(adminSource.kind, "planning_note");
  assert.equal(adminSource.title, "Admin planning note");
  assert.equal(adminSource.capturedBy, "Studio UI");

  const adminActivity = database.prepare(`
    SELECT action, actor_type, actor_name
    FROM activity_logs
    WHERE action = 'project.source.created'
    ORDER BY created_at DESC
    LIMIT 1
  `).get() as { action: string; actor_type: string; actor_name: string };
  assert.deepEqual(adminActivity, {
    action: "project.source.created",
    actor_type: "admin",
    actor_name: "Studio UI",
  });

  await assert.rejects(
    () => createProjectSourceFromAgent("missing-project", {
      kind: "discovery_call",
      title: "Missing project source",
      body: "Should fail.",
    }),
    /Project not found/,
  );
  await assert.rejects(
    () => createProjectSourceFromAgent("project-1", {
      kind: "discovery_call",
      title: "Half-linked source identity",
      body: "This imported source has an id but no type.",
      sourceId: "call-half-link",
    }),
    /Project source identity requires sourceType when sourceId is set/,
  );
  await assert.rejects(
    () => updateProjectSourceFromAgent("project-1", adminSource.id, {
      sourceType: null,
      sourceId: "manual-note-1",
    }),
    /Project source identity requires sourceType when sourceId is set/,
  );
  await assert.rejects(
    () => updateProjectSourceFromAgent("project-1", "missing-source", {
      title: "Missing source",
    }),
    /Project source not found/,
  );
  await assert.rejects(
    () => updateProjectSourceFromAgent("missing-project", source.id, {
      title: "Wrong project",
    }),
    /Project not found/,
  );

  await assert.rejects(
    () => createAgentTask({
      projectId: "project-1",
      title: "Task linked to missing source",
      sourceType: "project_source",
      sourceId: "missing-source",
    }),
    /Project source not found/,
  );

  console.log("agent source tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
