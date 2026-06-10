import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-studio-mcp-events-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getAgenda } = await import("./agenda");
  const { handleStudioMcpMessage } = await import("./studio-mcp");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);

  const list = await handleStudioMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const toolNames = (list?.result?.tools as Array<{ name: string }>).map((tool) => tool.name);
  assert.ok(toolNames.includes("studio_create_project_event"));
  assert.ok(toolNames.includes("studio_update_project_event"));

  const createResponse = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "studio_create_project_event",
      arguments: {
        projectId: "project-1",
        type: "rehearsal",
        title: "Rehearsal dinner",
        eventDate: "2026-06-19",
        venueName: "River House",
        city: "Charleston",
        state: "SC",
      },
    },
  });

  assert.equal(createResponse?.error, undefined);
  const created = (createResponse?.result?.structuredContent as {
    event: { id: string; title: string; eventDate: string | null };
  }).event;
  assert.equal(created.title, "Rehearsal dinner");
  assert.equal(created.eventDate, "2026-06-19");

  const updateResponse = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "studio_update_project_event",
      arguments: {
        projectId: "project-1",
        eventId: created.id,
        title: "Welcome dinner",
        eventDate: "2026-06-18",
      },
    },
  });
  assert.equal(updateResponse?.error, undefined);

  const agenda = await getAgenda({ fromDate: "2026-06-01", toDate: "2026-06-30" });
  assert.deepEqual(agenda.items.map((item) => [item.id, item.title, item.date]), [
    [created.id, "Welcome dinner", "2026-06-18"],
  ]);

  console.log("studio mcp event tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
