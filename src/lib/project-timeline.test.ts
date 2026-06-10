import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-timeline-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { createProjectTimelineItem, createProjectTimelineItemsFromAgent, updateProjectTimelineItem } = await import("./project-timeline");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, source_type, source_id, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'discovery_call', 'Discovery call notes',
      'Client wants a calm documentary timeline.', 'Timeline source summary', 'Studio UI',
      'call_transcript', 'call-1', ?, ?
    )
  `).run(now, now);

  const item = await createProjectTimelineItem("project-1", {
    title: "Golden hour portraits",
    description: "Couple portraits near the garden.",
    startAt: "2026-09-19T22:30:00.000Z",
    endAt: "2026-09-19T23:00:00.000Z",
    sourceType: "agent",
    sourceId: "task-1",
  });

  assert.equal(item.projectId, "project-1");
  assert.equal(item.title, "Golden hour portraits");
  assert.equal(item.sortOrder, 0);

  const rows = database.prepare("SELECT title, source_type, source_id FROM project_timeline_items").all();
  assert.deepEqual(rows, [{ title: "Golden hour portraits", source_type: "agent", source_id: "task-1" }]);

  const activity = database.prepare("SELECT action, actor_type FROM activity_logs").all();
  assert.deepEqual(activity, [{ action: "project.timeline_item.created", actor_type: "agent" }]);

  const batch = await createProjectTimelineItemsFromAgent("project-1", {
    sourceType: "project_source",
    sourceId: "source-1",
    timelineItems: [
      {
        title: "Getting ready",
        description: "Document final prep and detail photos.",
        startAt: "2026-09-19T16:00:00.000Z",
        endAt: "2026-09-19T17:00:00.000Z",
      },
      {
        title: "Ceremony",
        description: "Outdoor garden ceremony.",
        startAt: "2026-09-19T20:00:00.000Z",
        endAt: "2026-09-19T20:30:00.000Z",
      },
    ],
  });

  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map((item) => ({
    title: item.title,
    sortOrder: item.sortOrder,
    sourceType: item.sourceType,
    sourceId: item.sourceId,
  })), [
    { title: "Getting ready", sortOrder: 1, sourceType: "project_source", sourceId: "source-1" },
    { title: "Ceremony", sortOrder: 2, sourceType: "project_source", sourceId: "source-1" },
  ]);

  const batchRows = database.prepare(`
    SELECT title, sort_order, source_type, source_id
    FROM project_timeline_items
    WHERE source_type = 'project_source'
    ORDER BY sort_order
  `).all();
  assert.deepEqual(batchRows, [
    { title: "Getting ready", sort_order: 1, source_type: "project_source", source_id: "source-1" },
    { title: "Ceremony", sort_order: 2, source_type: "project_source", source_id: "source-1" },
  ]);

  const replacementBatch = await createProjectTimelineItemsFromAgent("project-1", {
    sourceType: "project_source",
    sourceId: "source-1",
    replaceExistingForSource: true,
    timelineItems: [
      {
        title: "Details and flat lays",
        description: "Corrected plan from updated discovery call notes.",
        startAt: "2026-09-19T15:30:00.000Z",
        endAt: "2026-09-19T16:15:00.000Z",
      },
      {
        title: "Ceremony with audio check",
        description: "Outdoor garden ceremony plus lav/audio check.",
        startAt: "2026-09-19T19:45:00.000Z",
        endAt: "2026-09-19T20:35:00.000Z",
      },
    ],
  });

  assert.deepEqual(replacementBatch.map((item) => ({
    title: item.title,
    sourceType: item.sourceType,
    sourceId: item.sourceId,
  })), [
    { title: "Details and flat lays", sourceType: "project_source", sourceId: "source-1" },
    { title: "Ceremony with audio check", sourceType: "project_source", sourceId: "source-1" },
  ]);

  const replacedRows = database.prepare(`
    SELECT title, source_type, source_id
    FROM project_timeline_items
    ORDER BY sort_order
  `).all();
  assert.deepEqual(replacedRows, [
    { title: "Golden hour portraits", source_type: "agent", source_id: "task-1" },
    { title: "Details and flat lays", source_type: "project_source", source_id: "source-1" },
    { title: "Ceremony with audio check", source_type: "project_source", source_id: "source-1" },
  ]);

  await assert.rejects(
    () => createProjectTimelineItemsFromAgent("project-1", {
      replaceExistingForSource: true,
      timelineItems: [{ title: "Ambiguous replacement" }],
    }),
    /Source type and source id are required/,
  );

  const updatedItem = await updateProjectTimelineItem("project-1", item.id, {
    title: "Golden hour portraits with family",
    description: "Couple portraits and a quick family grouping near the garden.",
    startAt: "2026-09-19T22:45:00.000Z",
    endAt: "2026-09-19T23:15:00.000Z",
    sortOrder: 4,
  }, "admin");

  assert.equal(updatedItem.id, item.id);
  assert.equal(updatedItem.title, "Golden hour portraits with family");
  assert.equal(updatedItem.sortOrder, 4);
  assert.equal(updatedItem.sourceType, "agent");
  assert.equal(updatedItem.sourceId, "task-1");

  assert.deepEqual(database.prepare(`
    SELECT title, description, start_at, end_at, sort_order, source_type, source_id
    FROM project_timeline_items
    WHERE id = ?
  `).get(item.id), {
    title: "Golden hour portraits with family",
    description: "Couple portraits and a quick family grouping near the garden.",
    start_at: "2026-09-19T22:45:00.000Z",
    end_at: "2026-09-19T23:15:00.000Z",
    sort_order: 4,
    source_type: "agent",
    source_id: "task-1",
  });

  const updateActivity = database.prepare(`
    SELECT action, actor_type
    FROM activity_logs
    WHERE action = 'project.timeline_item.updated'
  `).get();
  assert.deepEqual(updateActivity, { action: "project.timeline_item.updated", actor_type: "admin" });

  await assert.rejects(
    () => updateProjectTimelineItem("missing-project", item.id, { title: "No project" }, "agent"),
    /Project not found/,
  );

  await assert.rejects(
    () => updateProjectTimelineItem("project-1", "missing-item", { title: "No item" }, "agent"),
    /Timeline item not found/,
  );

  await assert.rejects(
    () => updateProjectTimelineItem("project-1", item.id, {
      title: "Bad source",
      sourceType: "project_source",
      sourceId: "missing-source",
    }, "agent"),
    /Project source not found/,
  );

  await assert.rejects(
    () => createProjectTimelineItem("project-1", {
      title: "Half-linked timeline item",
      sourceId: "source-1",
    }),
    /Project timeline source links require sourceType when sourceId is set/,
  );

  await assert.rejects(
    () => createProjectTimelineItemsFromAgent("project-1", {
      sourceId: "source-1",
      timelineItems: [{ title: "Half-linked batch item" }],
    }),
    /Project timeline source links require sourceType when sourceId is set/,
  );

  await assert.rejects(
    () => updateProjectTimelineItem("project-1", item.id, {
      sourceType: null,
      sourceId: "source-1",
    }, "agent"),
    /Project timeline source links require sourceType when sourceId is set/,
  );

  await assert.rejects(
    () => createProjectTimelineItemsFromAgent("project-1", {
      sourceType: "project_source",
      sourceId: "missing-source",
      timelineItems: [{ title: "No source" }],
    }),
    /Project source not found/,
  );

  await assert.rejects(
    () => createProjectTimelineItem("missing-project", { title: "Missing" }),
    /Project not found/,
  );

  console.log("project timeline tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
