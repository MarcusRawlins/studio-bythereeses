import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-project-update-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";

function request(url: string, body: unknown, token = "secret") {
  return new Request(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?),
      ('client-2', 'Jordan', 'Taylor', 'jordan@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO projects (
      id, name, type, stage, status, event_date, venue_name, venue_address, city, state,
      budget_cents, notes, calendar_sync_status, created_at, updated_at
    ) VALUES (
      'project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', '2026-09-19',
      'Old Venue', '1 Old Street', 'Hudson', 'NY',
      900000, 'Original notes.', 'needs_google_connection', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-2', 'Other Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-1', 'project-1', 'client-1', 'primary', 1, ?),
      ('participant-2', 'project-1', 'client-2', 'partner', 0, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_events (
      id, project_id, type, title, event_date, venue_name, venue_address, city, state,
      calendar_sync_status, created_at, updated_at
    ) VALUES (
      'event-1', 'project-1', 'wedding', 'Wedding day', '2026-09-19',
      'Old Venue', '1 Old Street', 'Hudson', 'NY',
      'needs_google_connection', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, source_type, source_id, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'discovery_call', 'Discovery call notes',
      'Client confirmed the new venue and budget.', 'call_transcript', 'call-1', ?, ?
    ), (
      'source-2', 'project-2', 'discovery_call', 'Wrong project call',
      'This belongs elsewhere.', 'call_transcript', 'call-2', ?, ?
    )
  `).run(now, now, now, now);

  const unauthorized = await route.PATCH(new Request("https://studio.bythereeses.com/api/agent/projects/project-1", {
    method: "PATCH",
    body: JSON.stringify({ stage: "planning" }),
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(unauthorized.status, 401);

  const response = await route.PATCH(request("https://studio.bythereeses.com/api/agent/projects/project-1", {
    name: "Alex and Jordan Wedding",
    stage: "planning",
    venueName: "The Garden House",
    venueAddress: "22 Garden Lane",
    city: "Rhinebeck",
    state: "NY",
    budgetCents: 950000,
    notes: "Updated from discovery call source.",
    primaryClientId: "client-2",
    sourceType: "project_source",
    sourceId: "source-1",
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.project.id, "project-1");
  assert.equal(body.project.name, "Alex and Jordan Wedding");
  assert.equal(body.project.stage, "planning");
  assert.equal(body.project.venueName, "The Garden House");
  assert.equal(body.project.sourceType, "project_source");
  assert.equal(body.project.sourceId, "source-1");
  assert.equal(body.project.primaryClientId, "client-2");

  assert.deepEqual(database.prepare(`
    SELECT name, stage, event_date, venue_name, venue_address, city, state, budget_cents, notes
    FROM projects
    WHERE id = 'project-1'
  `).get(), {
    name: "Alex and Jordan Wedding",
    stage: "planning",
    event_date: "2026-09-19",
    venue_name: "The Garden House",
    venue_address: "22 Garden Lane",
    city: "Rhinebeck",
    state: "NY",
    budget_cents: 950000,
    notes: "Updated from discovery call source.",
  });

  assert.deepEqual(database.prepare(`
    SELECT event_date, venue_name, venue_address, city, state
    FROM project_events
    WHERE id = 'event-1'
  `).get(), {
    event_date: "2026-09-19",
    venue_name: "The Garden House",
    venue_address: "22 Garden Lane",
    city: "Rhinebeck",
    state: "NY",
  });
  assert.deepEqual(database.prepare(`
    SELECT client_id, is_primary_contact
    FROM project_participants
    WHERE project_id = 'project-1'
    ORDER BY client_id
  `).all(), [
    { client_id: "client-1", is_primary_contact: 0 },
    { client_id: "client-2", is_primary_contact: 1 },
  ]);

  const activity = database.prepare("SELECT action, actor_type, actor_name, metadata FROM activity_logs ORDER BY created_at DESC LIMIT 1").get() as {
    action: string;
    actor_type: string;
    actor_name: string;
    metadata: string;
  };
  assert.equal(activity.action, "project.updated_by_agent");
  assert.equal(activity.actor_type, "agent");
  assert.equal(activity.actor_name, "The Reeses Studio Agent");
  assert.deepEqual(JSON.parse(activity.metadata).sourceId, "source-1");

  const dateChange = await route.PATCH(request("https://studio.bythereeses.com/api/agent/projects/project-1", {
    eventDate: "2026-10-03",
    sourceType: "project_source",
    sourceId: "source-1",
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(dateChange.status, 400);
  assert.match((await dateChange.json()).error, /Only Tyler can change the wedding date/);
  assert.deepEqual(database.prepare("SELECT event_date FROM projects WHERE id = 'project-1'").get(), {
    event_date: "2026-09-19",
  });

  const wrongSource = await route.PATCH(request("https://studio.bythereeses.com/api/agent/projects/project-1", {
    stage: "retainer_paid",
    sourceType: "project_source",
    sourceId: "source-2",
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(wrongSource.status, 400);
  assert.match((await wrongSource.json()).error, /Project source not found/);

  console.log("agent project update route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
