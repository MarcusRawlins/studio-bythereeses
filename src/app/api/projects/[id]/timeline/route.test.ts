import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-timeline-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_timeline_items (
      id, project_id, title, description, start_at, end_at, sort_order, source_type, source_id, created_by, created_at, updated_at
    ) VALUES (
      'timeline-1', 'project-1', 'Golden hour portraits', 'Couple portraits near the garden.',
      '2026-09-19T22:30:00.000Z', '2026-09-19T23:00:00.000Z', 0, 'agent', 'task-1', 'agent', ?, ?
    )
  `).run(now, now);

  const formData = new FormData();
  formData.set("timelineItemId", "timeline-1");
  formData.set("title", "Golden hour portraits with family");
  formData.set("description", "Couple portraits and quick family grouping near the garden.");
  formData.set("startAt", "2026-09-19T22:45:00.000Z");
  formData.set("endAt", "2026-09-19T23:15:00.000Z");
  formData.set("sortOrder", "2");

  const response = await POST(new Request("https://studio.test/api/projects/project-1/timeline", {
    method: "POST",
    body: formData,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.test/projects/project-1?saved=timeline");

  assert.deepEqual(database.prepare(`
    SELECT title, description, start_at, end_at, sort_order, source_type, source_id
    FROM project_timeline_items
    WHERE id = 'timeline-1'
  `).get(), {
    title: "Golden hour portraits with family",
    description: "Couple portraits and quick family grouping near the garden.",
    start_at: "2026-09-19T22:45:00.000Z",
    end_at: "2026-09-19T23:15:00.000Z",
    sort_order: 2,
    source_type: "agent",
    source_id: "task-1",
  });

  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM project_timeline_items
  `).get(), { count: 1 });

  assert.deepEqual(database.prepare(`
    SELECT action, actor_type
    FROM activity_logs
    WHERE action = 'project.timeline_item.updated'
  `).get(), {
    action: "project.timeline_item.updated",
    actor_type: "admin",
  });

  console.log("project timeline route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
