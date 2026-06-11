import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-agent-task-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Other Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_timeline_items (id, project_id, title, sort_order, created_by, created_at, updated_at)
    VALUES ('timeline-1', 'project-1', 'Ceremony timeline', 0, 'agent', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, source_type, source_id, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'discovery_call', 'Discovery call with Alex and Jordan',
      'Discovery notes for proposal and timeline work.', 'studio_project', 'manual-source-1', ?, ?
    )
  `).run(now, now);

  const createForm = new FormData();
  createForm.set("title", "Draft ceremony timeline");
  createForm.set("instructions", "Use project notes and questionnaire answers.");
  createForm.set("priority", "high");
  createForm.set("assignedAgent", "Timeline Agent");

  const createResponse = await route.POST(new Request("https://studio.bythereeses.com/api/projects/project-1/agent-tasks", {
    method: "POST",
    body: createForm,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(createResponse.status, 303);
  assert.equal(createResponse.headers.get("location"), "https://studio.bythereeses.com/projects/project-1?saved=agent-task");

  const created = database.prepare(`
    SELECT id, project_id, title, status, requested_by
    FROM agent_tasks
    WHERE project_id = 'project-1'
  `).get() as { id: string };

  assert.deepEqual({ ...created, id: "task-id" }, {
    id: "task-id",
    project_id: "project-1",
    title: "Draft ceremony timeline",
    status: "queued",
    requested_by: "Studio UI",
  });

  const sourceTaskForm = new FormData();
  sourceTaskForm.set("title", "Create proposal from Discovery call with Alex and Jordan");
  sourceTaskForm.set("instructions", "Use this saved source to create a proposal.");
  sourceTaskForm.set("priority", "high");
  sourceTaskForm.set("assignedAgent", "Proposal Agent");
  sourceTaskForm.set("projectSourceId", "source-1");

  const sourceTaskResponse = await route.POST(new Request("https://studio.bythereeses.com/api/projects/project-1/agent-tasks", {
    method: "POST",
    body: sourceTaskForm,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(sourceTaskResponse.status, 303);
  assert.deepEqual(database.prepare(`
    SELECT title, status, priority, assigned_agent, source_type, source_id
    FROM agent_tasks
    WHERE project_id = 'project-1'
      AND title = 'Create proposal from Discovery call with Alex and Jordan'
  `).get(), {
    title: "Create proposal from Discovery call with Alex and Jordan",
    status: "queued",
    priority: "high",
    assigned_agent: "Proposal Agent",
    source_type: "project_source",
    source_id: "source-1",
  });

  const invoiceTaskForm = new FormData();
  invoiceTaskForm.set("title", "Create invoice from Discovery call with Alex and Jordan");
  invoiceTaskForm.set("instructions", "Use this saved source to create an invoice.");
  invoiceTaskForm.set("priority", "high");
  invoiceTaskForm.set("assignedAgent", "Billing Agent");
  invoiceTaskForm.set("projectSourceId", "source-1");

  const invoiceTaskResponse = await route.POST(new Request("https://studio.bythereeses.com/api/projects/project-1/agent-tasks", {
    method: "POST",
    body: invoiceTaskForm,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(invoiceTaskResponse.status, 303);
  assert.deepEqual(database.prepare(`
    SELECT title, status, priority, assigned_agent, source_type, source_id
    FROM agent_tasks
    WHERE project_id = 'project-1'
      AND title = 'Create invoice from Discovery call with Alex and Jordan'
  `).get(), {
    title: "Create invoice from Discovery call with Alex and Jordan",
    status: "queued",
    priority: "high",
    assigned_agent: "Billing Agent",
    source_type: "project_source",
    source_id: "source-1",
  });

  const expenseTaskForm = new FormData();
  expenseTaskForm.set("title", "Create expense from Discovery call with Alex and Jordan");
  expenseTaskForm.set("instructions", "Use this saved source to create an expense.");
  expenseTaskForm.set("priority", "high");
  expenseTaskForm.set("assignedAgent", "Bookkeeping Agent");
  expenseTaskForm.set("projectSourceId", "source-1");

  const expenseTaskResponse = await route.POST(new Request("https://studio.bythereeses.com/api/projects/project-1/agent-tasks", {
    method: "POST",
    body: expenseTaskForm,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(expenseTaskResponse.status, 303);
  assert.deepEqual(database.prepare(`
    SELECT title, status, priority, assigned_agent, source_type, source_id
    FROM agent_tasks
    WHERE project_id = 'project-1'
      AND title = 'Create expense from Discovery call with Alex and Jordan'
  `).get(), {
    title: "Create expense from Discovery call with Alex and Jordan",
    status: "queued",
    priority: "high",
    assigned_agent: "Bookkeeping Agent",
    source_type: "project_source",
    source_id: "source-1",
  });

  const followUpTaskForm = new FormData();
  followUpTaskForm.set("title", "Create follow-up from Discovery call with Alex and Jordan");
  followUpTaskForm.set("instructions", "Use this saved source to create a client follow-up.");
  followUpTaskForm.set("priority", "high");
  followUpTaskForm.set("assignedAgent", "Communications Agent");
  followUpTaskForm.set("projectSourceId", "source-1");

  const followUpTaskResponse = await route.POST(new Request("https://studio.bythereeses.com/api/projects/project-1/agent-tasks", {
    method: "POST",
    body: followUpTaskForm,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(followUpTaskResponse.status, 303);
  assert.deepEqual(database.prepare(`
    SELECT title, status, priority, assigned_agent, source_type, source_id
    FROM agent_tasks
    WHERE project_id = 'project-1'
      AND title = 'Create follow-up from Discovery call with Alex and Jordan'
  `).get(), {
    title: "Create follow-up from Discovery call with Alex and Jordan",
    status: "queued",
    priority: "high",
    assigned_agent: "Communications Agent",
    source_type: "project_source",
    source_id: "source-1",
  });

  const updateForm = new FormData();
  updateForm.set("taskId", created.id);
  updateForm.set("status", "completed");
  updateForm.set("resultSummary", "Timeline reviewed and ready for client prep.");
  updateForm.set("outputJson", JSON.stringify({ timelineId: "timeline-1" }));

  const updateResponse = await route.POST(new Request("https://studio.bythereeses.com/api/projects/project-1/agent-tasks", {
    method: "POST",
    body: updateForm,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(updateResponse.status, 303);
  assert.equal(updateResponse.headers.get("location"), "https://studio.bythereeses.com/projects/project-1?saved=agent-task");

  assert.deepEqual(database.prepare(`
    SELECT status, result_summary, output_json
    FROM agent_tasks
    WHERE id = ?
  `).get(created.id), {
    status: "completed",
    result_summary: "Timeline reviewed and ready for client prep.",
    output_json: JSON.stringify({ timelineId: "timeline-1" }),
  });

  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM agent_tasks
    WHERE project_id = 'project-1'
  `).get(), { count: 5 });

  const crossProjectForm = new FormData();
  crossProjectForm.set("taskId", created.id);
  crossProjectForm.set("status", "cancelled");
  crossProjectForm.set("resultSummary", "Wrong project should not update.");

  const crossProjectResponse = await route.POST(new Request("https://studio.bythereeses.com/api/projects/project-2/agent-tasks", {
    method: "POST",
    body: crossProjectForm,
  }), { params: Promise.resolve({ id: "project-2" }) });

  assert.equal(crossProjectResponse.status, 400);
  assert.deepEqual(database.prepare(`
    SELECT status, result_summary
    FROM agent_tasks
    WHERE id = ?
  `).get(created.id), {
    status: "completed",
    result_summary: "Timeline reviewed and ready for client prep.",
  });

  console.log("project agent task route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
