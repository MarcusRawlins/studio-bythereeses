import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-timeline-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "timeline-token";

async function main() {
  const { rawDb } = await import("@/db/client");
  const { PATCH, POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'discovery_call', 'Timeline discovery call',
      'Client wants a relaxed documentary day.', 'Timeline drafting source', 'Studio UI', ?, ?
    )
  `).run(now, now);

  const response = await POST(new Request("https://studio.test/api/agent/projects/project-1/timeline", {
    method: "POST",
    headers: {
      authorization: "Bearer timeline-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sourceType: "project_source",
      sourceId: "source-1",
      timelineItems: [
        {
          title: "Family portraits",
          description: "Immediate family portraits by the garden.",
          startAt: "2026-09-19T21:00:00.000Z",
          endAt: "2026-09-19T21:30:00.000Z",
        },
        {
          title: "Reception coverage",
          description: "Toasts, first dance, and open dancing.",
          startAt: "2026-09-20T00:00:00.000Z",
          endAt: "2026-09-20T03:00:00.000Z",
        },
      ],
    }),
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.timelineItems.length, 2);
  assert.deepEqual(body.timelineItems.map((item: {
    title: string;
    sortOrder: number;
    sourceType: string;
    sourceId: string;
  }) => ({
    title: item.title,
    sortOrder: item.sortOrder,
    sourceType: item.sourceType,
    sourceId: item.sourceId,
  })), [
    { title: "Family portraits", sortOrder: 0, sourceType: "project_source", sourceId: "source-1" },
    { title: "Reception coverage", sortOrder: 1, sourceType: "project_source", sourceId: "source-1" },
  ]);

  const rows = database.prepare(`
    SELECT id, title, source_type, source_id
    FROM project_timeline_items
    ORDER BY sort_order
  `).all();
  assert.deepEqual(rows.map(({ title, source_type, source_id }: {
    title: string;
    source_type: string;
    source_id: string;
  }) => ({ title, source_type, source_id })), [
    { title: "Family portraits", source_type: "project_source", source_id: "source-1" },
    { title: "Reception coverage", source_type: "project_source", source_id: "source-1" },
  ]);

  const patchResponse = await PATCH(new Request("https://studio.test/api/agent/projects/project-1/timeline", {
    method: "PATCH",
    headers: {
      authorization: "Bearer timeline-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      timelineItemId: rows[0].id,
      title: "Family portraits and wedding party",
      description: "Immediate family and wedding party portraits by the garden.",
      startAt: "2026-09-19T21:10:00.000Z",
      endAt: "2026-09-19T21:45:00.000Z",
      sortOrder: 3,
    }),
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(patchResponse.status, 200);
  const patchBody = await patchResponse.json();
  assert.equal(patchBody.timelineItem.id, rows[0].id);
  assert.equal(patchBody.timelineItem.title, "Family portraits and wedding party");
  assert.equal(patchBody.timelineItem.sourceType, "project_source");
  assert.equal(patchBody.timelineItem.sourceId, "source-1");

  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM project_timeline_items
  `).get(), { count: 2 });

  assert.deepEqual(database.prepare(`
    SELECT title, description, start_at, end_at, sort_order
    FROM project_timeline_items
    WHERE id = ?
  `).get(rows[0].id), {
    title: "Family portraits and wedding party",
    description: "Immediate family and wedding party portraits by the garden.",
    start_at: "2026-09-19T21:10:00.000Z",
    end_at: "2026-09-19T21:45:00.000Z",
    sort_order: 3,
  });

  const replaceResponse = await POST(new Request("https://studio.test/api/agent/projects/project-1/timeline", {
    method: "POST",
    headers: {
      authorization: "Bearer timeline-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sourceType: "project_source",
      sourceId: "source-1",
      replaceExistingForSource: true,
      timelineItems: [
        {
          title: "Corrected family portraits",
          description: "Updated from revised discovery call.",
          startAt: "2026-09-19T21:15:00.000Z",
          endAt: "2026-09-19T21:50:00.000Z",
        },
      ],
    }),
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(replaceResponse.status, 201);
  const replaceBody = await replaceResponse.json();
  assert.equal(replaceBody.timelineItems.length, 1);
  assert.equal(replaceBody.timelineItems[0].title, "Corrected family portraits");

  assert.deepEqual(database.prepare(`
    SELECT title, source_type, source_id
    FROM project_timeline_items
    ORDER BY sort_order
  `).all(), [
    { title: "Corrected family portraits", source_type: "project_source", source_id: "source-1" },
  ]);

  const unauthorized = await POST(new Request("https://studio.test/api/agent/projects/project-1/timeline", {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ timelineItems: [{ title: "Nope" }] }),
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(unauthorized.status, 401);

  console.log("agent timeline route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
