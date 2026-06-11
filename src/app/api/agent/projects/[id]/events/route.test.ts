import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-events-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "agent-token";

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getAgenda } = await import("@/lib/agenda");
  const route = await import("./route");
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
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'planning_call', 'Planning call',
      'Engagement session source notes.', ?, ?
    )
  `).run(now, now);

  const createResponse = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects/project-1/events", {
    method: "POST",
    headers: {
      authorization: "Bearer agent-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "engagement",
      title: "Engagement session",
      eventDate: "2026-06-10",
      venueName: "Downtown",
      city: "Charleston",
      state: "SC",
      sourceType: "project_source",
      sourceId: "source-1",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });

  assert.equal(createResponse.status, 201);
  const createBody = await createResponse.json() as {
    event: {
      id: string;
      title: string;
      eventDate: string | null;
      calendarSyncStatus: string;
      sourceType: string | null;
      sourceId: string | null;
    };
  };
  assert.equal(createBody.event.title, "Engagement session");
  assert.equal(createBody.event.eventDate, "2026-06-10");
  assert.equal(createBody.event.calendarSyncStatus, "needs_google_connection");
  assert.equal(createBody.event.sourceType, "project_source");
  assert.equal(createBody.event.sourceId, "source-1");

  const updateResponse = await route.PATCH(new Request(`https://studio.bythereeses.com/api/agent/projects/project-1/events?id=${createBody.event.id}`, {
    method: "PATCH",
    headers: {
      authorization: "Bearer agent-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "Engagement portraits",
      venueName: "Rainbow Row",
    }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });

  assert.equal(updateResponse.status, 200);
  const updateBody = await updateResponse.json() as {
    event: {
      id: string;
      title: string;
      venueName: string | null;
      sourceType: string | null;
      sourceId: string | null;
    };
  };
  assert.equal(updateBody.event.id, createBody.event.id);
  assert.equal(updateBody.event.title, "Engagement portraits");
  assert.equal(updateBody.event.venueName, "Rainbow Row");
  assert.equal(updateBody.event.sourceType, "project_source");
  assert.equal(updateBody.event.sourceId, "source-1");

  const agenda = await getAgenda({ fromDate: "2026-06-01", toDate: "2026-06-30" });
  assert.deepEqual(agenda.items.map((item) => [item.id, item.title, item.venueLabel]), [
    [createBody.event.id, "Engagement portraits", "Rainbow Row, Charleston, SC"],
  ]);

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects/project-1/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Nope" }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(unauthorized.status, 401);

  console.log("agent event route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
