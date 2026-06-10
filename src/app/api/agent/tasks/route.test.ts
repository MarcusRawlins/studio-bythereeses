import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-tasks-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";

function request(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const tasksRoute = await import("./route");
  const taskRoute = await import("./[id]/route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Other Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?),
      ('client-other', 'Other', 'Client', 'other-client@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-1', 'project-1', 'client-1', 'primary', 1, ?),
      ('participant-other', 'project-2', 'client-other', 'primary', 1, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO activity_logs (id, project_id, action, actor_type, actor_name, metadata, created_at)
    VALUES
      ('activity-1', 'project-1', 'invoice.reminder_logged_by_agent', 'agent', 'The Reeses Studio Agent', '{}', ?),
      ('activity-other', 'project-2', 'invoice.reminder_logged_by_agent', 'agent', 'The Reeses Studio Agent', '{}', ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, source_type, source_id, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'discovery_call', 'Route discovery source',
      'Route discovery source body for the agent.', 'Route source summary', 'Studio UI',
      'studio_project', 'route-source-1', ?, ?
    ), (
      'source-other', 'project-2', 'discovery_call', 'Other route source',
      'Other route source body.', 'Other source summary', 'Studio UI',
      'studio_project', 'route-source-other', ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO questionnaires (id, title, description, status, created_at, updated_at)
    VALUES ('questionnaire-1', 'Timeline Questionnaire', 'Planning form', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaire_responses (
      id, questionnaire_id, project_id, answers_json, created_at, updated_at
    ) VALUES
      ('questionnaire-response-1', 'questionnaire-1', 'project-1', '[]', ?, ?),
      ('questionnaire-response-other', 'questionnaire-1', 'project-2', '[]', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, created_at, updated_at
    ) VALUES ('meeting-1', 'discovery', 'Discovery Call', 30, 15, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, attendee_name, attendee_email,
      start_at, end_at, status, source, created_at, updated_at
    ) VALUES
      (
        'booking-1', 'meeting-1', 'project-1', 'Alex Taylor', 'alex@example.com',
        '2026-09-01T14:00:00.000Z', '2026-09-01T14:30:00.000Z',
        'confirmed', 'booking_link', ?, ?
      ),
      (
        'booking-other', 'meeting-1', 'project-2', 'Other Client', 'other@example.com',
        '2026-09-02T14:00:00.000Z', '2026-09-02T14:30:00.000Z',
        'confirmed', 'booking_link', ?, ?
      )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO proposals (id, project_id, title, status, total_cents, source_type, source_id, created_at, updated_at)
    VALUES
      ('proposal-1', 'project-1', 'Route Proposal', 'draft', 900000, 'project_source', 'source-1', ?, ?),
      ('proposal-other', 'project-2', 'Other Proposal', 'draft', 500000, 'project_source', 'source-other', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoices (id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents, created_at, updated_at)
    VALUES
      ('invoice-1', 'project-1', 'proposal-1', 'INV-TASK-ROUTE', 'draft', 900000, 0, ?, ?),
      ('invoice-other', 'project-2', 'proposal-other', 'INV-TASK-OTHER', 'draft', 500000, 0, ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
    VALUES
      ('invoice-payment-1', 'invoice-1', 'Retainer', 300000, '2026-06-01', 'paid', ?, ?),
      ('invoice-payment-other', 'invoice-other', 'Retainer', 200000, '2026-06-02', 'paid', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_events (id, project_id, type, title, event_date, created_at, updated_at)
    VALUES
      ('event-1', 'project-1', 'engagement', 'Route engagement session', '2026-07-10', ?, ?),
      ('event-other', 'project-2', 'engagement', 'Other route engagement session', '2026-07-11', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_locations (id, project_id, type, name, created_at, updated_at)
    VALUES
      ('location-1', 'project-1', 'portrait', 'Route portrait path', ?, ?),
      ('location-other', 'project-2', 'portrait', 'Other route portrait path', ?, ?)
  `).run(now, now, now, now);

  const unauthorized = await tasksRoute.GET(new Request("https://studio.bythereeses.com/api/agent/tasks"));
  assert.equal(unauthorized.status, 401);

  const created = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Create proposal from discovery call",
      instructions: "Draft package, timeline, and invoice.",
      priority: "high",
      requestedBy: "Tyler",
      sourceType: "project_source",
      sourceId: "source-1",
    }),
  }));

  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.agentTask.projectId, "project-1");
  assert.equal(createdBody.agentTask.status, "queued");
  assert.equal(createdBody.agentTask.priority, "high");

  const listed = await tasksRoute.GET(request("https://studio.bythereeses.com/api/agent/tasks?projectId=project-1&status=queued&limit=5"));
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.equal(listedBody.agentTasks.length, 1);
  assert.equal(listedBody.agentTasks[0].title, "Create proposal from discovery call");
  assert.deepEqual(listedBody.agentTasks[0].linkedSource, {
    id: "source-1",
    kind: "discovery_call",
    title: "Route discovery source",
    body: "Route discovery source body for the agent.",
    summary: "Route source summary",
    occurredAt: null,
    externalUrl: null,
    capturedBy: "Studio UI",
    sourceType: "studio_project",
    sourceId: "route-source-1",
  });

  const proposalSpecificTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Proposal specialist queue",
      assignedAgent: "Proposal Agent",
    }),
  }));
  assert.equal(proposalSpecificTask.status, 201);
  const timelineSpecificTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Timeline specialist queue",
      assignedAgent: "Timeline Agent",
    }),
  }));
  assert.equal(timelineSpecificTask.status, 201);

  const proposalQueue = await tasksRoute.GET(request("https://studio.bythereeses.com/api/agent/tasks?projectId=project-1&status=queued&assignedAgent=Proposal%20Agent&limit=10"));
  assert.equal(proposalQueue.status, 200);
  const proposalQueueBody = await proposalQueue.json();
  assert.deepEqual(
    proposalQueueBody.agentTasks.map((task: { title: string }) => task.title),
    ["Create proposal from discovery call", "Proposal specialist queue"],
  );
  const proposalQueueTitles = proposalQueueBody.agentTasks.map((task: { title: string }) => task.title).sort();
  assert.deepEqual(proposalQueueTitles, [
    "Create proposal from discovery call",
    "Proposal specialist queue",
  ]);

  const proposalSpecificTaskBody = await proposalSpecificTask.json();
  const claimedSpecific = await tasksRoute.PATCH(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "PATCH",
    body: JSON.stringify({
      taskId: proposalSpecificTaskBody.agentTask.id,
      projectId: "project-1",
      assignedAgent: "Proposal Agent",
    }),
  }));
  assert.equal(claimedSpecific.status, 200);
  const claimedSpecificBody = await claimedSpecific.json();
  assert.equal(claimedSpecificBody.agentTask.id, proposalSpecificTaskBody.agentTask.id);
  assert.equal(claimedSpecificBody.agentTask.title, "Proposal specialist queue");
  assert.equal(claimedSpecificBody.agentTask.status, "in_progress");
  assert.equal(claimedSpecificBody.agentTask.assignedAgent, "Proposal Agent");
  const claimActivity = database.prepare(`
    SELECT actor_name, metadata
    FROM activity_logs
    WHERE action = 'agent.task.claimed'
      AND json_extract(metadata, '$.agentTaskId') = ?
    ORDER BY created_at DESC
  `).get(proposalSpecificTaskBody.agentTask.id) as { actor_name: string; metadata: string };
  assert.equal(claimActivity.actor_name, "Proposal Agent");
  assert.deepEqual(JSON.parse(claimActivity.metadata), {
    agentTaskId: proposalSpecificTaskBody.agentTask.id,
    status: "in_progress",
    assignedAgent: "Proposal Agent",
    sourceType: null,
    sourceId: null,
  });

  const wrongSpecialistUpdate = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${proposalSpecificTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      assignedAgent: "Timeline Agent",
      resultSummary: "Timeline agent should not complete proposal work.",
    }),
  }), {
    params: Promise.resolve({ id: proposalSpecificTaskBody.agentTask.id }),
  });
  assert.equal(wrongSpecialistUpdate.status, 400);
  assert.match((await wrongSpecialistUpdate.json()).error, /Agent task is assigned to a different agent/);
  assert.deepEqual(database.prepare(`
    SELECT status, assigned_agent, result_summary, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(proposalSpecificTaskBody.agentTask.id), {
    status: "in_progress",
    assigned_agent: "Proposal Agent",
    result_summary: null,
    completed_at: null,
  });

  const correctSpecialistUpdate = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${proposalSpecificTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "in_progress",
      assignedAgent: "Proposal Agent",
      resultSummary: "Proposal specialist is working the queued proposal task.",
    }),
  }), {
    params: Promise.resolve({ id: proposalSpecificTaskBody.agentTask.id }),
  });
  assert.equal(correctSpecialistUpdate.status, 200);
  const specialistActivity = database.prepare(`
    SELECT actor_name, metadata
    FROM activity_logs
    WHERE action = 'agent.task.updated'
      AND json_extract(metadata, '$.agentTaskId') = ?
    ORDER BY created_at DESC
  `).get(proposalSpecificTaskBody.agentTask.id) as { actor_name: string; metadata: string };
  assert.equal(specialistActivity.actor_name, "Proposal Agent");
  assert.equal(JSON.parse(specialistActivity.metadata).assignedAgent, "Proposal Agent");

  const claimed = await tasksRoute.PATCH(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "PATCH",
    body: JSON.stringify({
      projectId: "project-1",
      assignedAgent: "Proposal Agent",
    }),
  }));
  assert.equal(claimed.status, 200);
  const claimedBody = await claimed.json();
  assert.equal(claimedBody.agentTask.id, createdBody.agentTask.id);
  assert.equal(claimedBody.agentTask.status, "in_progress");
  assert.equal(claimedBody.agentTask.assignedAgent, "Proposal Agent");
  assert.equal(claimedBody.agentTask.linkedSource.title, "Route discovery source");
  const sourceClaimActivity = database.prepare(`
    SELECT actor_name, metadata
    FROM activity_logs
    WHERE action = 'agent.task.claimed'
      AND json_extract(metadata, '$.agentTaskId') = ?
    ORDER BY created_at DESC
  `).get(createdBody.agentTask.id) as { actor_name: string; metadata: string };
  assert.equal(sourceClaimActivity.actor_name, "Proposal Agent");
  assert.deepEqual(JSON.parse(sourceClaimActivity.metadata), {
    agentTaskId: createdBody.agentTask.id,
    status: "in_progress",
    assignedAgent: "Proposal Agent",
    sourceType: "project_source",
    sourceId: "source-1",
  });

  const missingSpecialistUpdate = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${createdBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      resultSummary: "Anonymous update should not complete specialist work.",
      outputJson: { proposalId: "proposal-1" },
    }),
  }), {
    params: Promise.resolve({ id: createdBody.agentTask.id }),
  });
  assert.equal(missingSpecialistUpdate.status, 400);
  assert.match((await missingSpecialistUpdate.json()).error, /Agent task updates for specialist-owned tasks require assignedAgent/);

  const relinkTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Relink task to canonical source",
      sourceType: "studio_project",
      sourceId: "route-source-1",
    }),
  }));
  assert.equal(relinkTask.status, 201);
  const relinkTaskBody = await relinkTask.json();
  const relinked = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${relinkTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "queued",
      sourceType: "project_source",
      sourceId: "source-1",
    }),
  }), {
    params: Promise.resolve({ id: relinkTaskBody.agentTask.id }),
  });
  assert.equal(relinked.status, 200);
  const relinkedBody = await relinked.json();
  assert.equal(relinkedBody.agentTask.sourceType, "project_source");
  assert.equal(relinkedBody.agentTask.sourceId, "source-1");
  assert.equal(relinkedBody.agentTask.linkedSource.id, "source-1");

  const genericSpecialistTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Generic task completed by specialist",
    }),
  }));
  assert.equal(genericSpecialistTask.status, 201);
  const genericSpecialistTaskBody = await genericSpecialistTask.json();
  assert.equal(genericSpecialistTaskBody.agentTask.assignedAgent, "The Reeses Studio Agent");
  const genericSpecialistUpdate = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${genericSpecialistTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "in_progress",
      assignedAgent: "Proposal Agent",
      resultSummary: "Proposal Agent picked up generic work.",
    }),
  }), {
    params: Promise.resolve({ id: genericSpecialistTaskBody.agentTask.id }),
  });
  assert.equal(genericSpecialistUpdate.status, 200);
  const genericSpecialistUpdateBody = await genericSpecialistUpdate.json();
  assert.equal(genericSpecialistUpdateBody.agentTask.assignedAgent, "Proposal Agent");
  assert.deepEqual(database.prepare(`
    SELECT assigned_agent
    FROM agent_tasks
    WHERE id = ?
  `).get(genericSpecialistTaskBody.agentTask.id), {
    assigned_agent: "Proposal Agent",
  });

  const wrongRelink = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${relinkTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "queued",
      sourceType: "project_source",
      sourceId: "source-other",
    }),
  }), {
    params: Promise.resolve({ id: relinkTaskBody.agentTask.id }),
  });
  assert.equal(wrongRelink.status, 400);
  assert.match((await wrongRelink.json()).error, /Project source not found/);

  const updated = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${createdBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      assignedAgent: "Proposal Agent",
      resultSummary: "Proposal draft created.",
      outputJson: { proposalId: "proposal-1" },
    }),
  }), {
    params: Promise.resolve({ id: createdBody.agentTask.id }),
  });

  assert.equal(updated.status, 200);
  const updatedBody = await updated.json();
  assert.equal(updatedBody.agentTask.status, "completed");
  assert.equal(updatedBody.agentTask.assignedAgent, "Proposal Agent");
  assert.equal(updatedBody.agentTask.resultSummary, "Proposal draft created.");
  assert.equal(updatedBody.agentTask.sourceType, "project_source");
  assert.equal(updatedBody.agentTask.sourceId, "source-1");
  assert.deepEqual(JSON.parse(updatedBody.agentTask.outputJson), { proposalId: "proposal-1" });
  assert.deepEqual(database.prepare(`
    SELECT assigned_agent
    FROM agent_tasks
    WHERE id = ?
  `).get(createdBody.agentTask.id), {
    assigned_agent: "Proposal Agent",
  });

  const malformedOutputTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Complete with malformed route output",
    }),
  }));
  assert.equal(malformedOutputTask.status, 201);
  const malformedOutputTaskBody = await malformedOutputTask.json();
  const badMalformedOutput = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${malformedOutputTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      outputJson: ["proposal-1"],
    }),
  }), {
    params: Promise.resolve({ id: malformedOutputTaskBody.agentTask.id }),
  });
  assert.equal(badMalformedOutput.status, 400);
  assert.match((await badMalformedOutput.json()).error, /Agent task output must be a structured object/);
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(malformedOutputTaskBody.agentTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const completed = await tasksRoute.GET(request("https://studio.bythereeses.com/api/agent/tasks?status=completed"));
  const completedBody = await completed.json();
  assert.equal(completedBody.agentTasks.length, 1);
  assert.equal(completedBody.agentTasks[0].id, createdBody.agentTask.id);

  const arrayOutputTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Complete with proposal array outputs",
    }),
  }));
  assert.equal(arrayOutputTask.status, 201);
  const arrayOutputTaskBody = await arrayOutputTask.json();

  const badArrayOutput = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${arrayOutputTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      outputJson: { proposalIds: ["proposal-1", "proposal-other"] },
    }),
  }), {
    params: Promise.resolve({ id: arrayOutputTaskBody.agentTask.id }),
  });
  assert.equal(badArrayOutput.status, 400);
  assert.match((await badArrayOutput.json()).error, /Agent task output proposal does not belong to this project/);
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(arrayOutputTaskBody.agentTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const logisticsOutputTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Complete with event and location outputs",
    }),
  }));
  assert.equal(logisticsOutputTask.status, 201);
  const logisticsOutputTaskBody = await logisticsOutputTask.json();

  const badLogisticsOutput = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${logisticsOutputTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      outputJson: {
        eventIds: ["event-1", "event-other"],
        locationIds: ["location-1", "location-other"],
      },
    }),
  }), {
    params: Promise.resolve({ id: logisticsOutputTaskBody.agentTask.id }),
  });
  assert.equal(badLogisticsOutput.status, 400);
  assert.match((await badLogisticsOutput.json()).error, /Agent task output project event does not belong to this project/);
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(logisticsOutputTaskBody.agentTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const locationOutputTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Complete with location outputs",
    }),
  }));
  assert.equal(locationOutputTask.status, 201);
  const locationOutputTaskBody = await locationOutputTask.json();

  const badLocationOutput = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${locationOutputTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      outputJson: {
        eventIds: ["event-1"],
        locationIds: ["location-1", "location-other"],
      },
    }),
  }), {
    params: Promise.resolve({ id: locationOutputTaskBody.agentTask.id }),
  });
  assert.equal(badLocationOutput.status, 400);
  assert.match((await badLocationOutput.json()).error, /Agent task output project location does not belong to this project/);
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(locationOutputTaskBody.agentTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const invoicePaymentOutputTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Complete with invoice payment outputs",
    }),
  }));
  assert.equal(invoicePaymentOutputTask.status, 201);
  const invoicePaymentOutputTaskBody = await invoicePaymentOutputTask.json();

  const badInvoicePaymentOutput = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${invoicePaymentOutputTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      outputJson: {
        invoicePaymentIds: ["invoice-payment-1", "invoice-payment-other"],
      },
    }),
  }), {
    params: Promise.resolve({ id: invoicePaymentOutputTaskBody.agentTask.id }),
  });
  assert.equal(badInvoicePaymentOutput.status, 400);
  assert.match((await badInvoicePaymentOutput.json()).error, /Agent task output invoice payment does not belong to this project/);
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(invoicePaymentOutputTaskBody.agentTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const malformedReferenceOutputTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Complete with malformed payment output references",
    }),
  }));
  assert.equal(malformedReferenceOutputTask.status, 201);
  const malformedReferenceOutputTaskBody = await malformedReferenceOutputTask.json();

  const malformedReferenceOutput = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${malformedReferenceOutputTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      outputJson: {
        paymentIds: ["invoice-payment-1", 42],
      },
    }),
  }), {
    params: Promise.resolve({ id: malformedReferenceOutputTaskBody.agentTask.id }),
  });
  assert.equal(malformedReferenceOutput.status, 400);
  assert.match((await malformedReferenceOutput.json()).error, /Agent task output references must be non-empty string ids/);
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(malformedReferenceOutputTaskBody.agentTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const clientOutputTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Complete with client outputs",
    }),
  }));
  assert.equal(clientOutputTask.status, 201);
  const clientOutputTaskBody = await clientOutputTask.json();

  const badClientOutput = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${clientOutputTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      outputJson: {
        clientIds: ["client-1", "client-other"],
      },
    }),
  }), {
    params: Promise.resolve({ id: clientOutputTaskBody.agentTask.id }),
  });
  assert.equal(badClientOutput.status, 400);
  assert.match((await badClientOutput.json()).error, /Agent task output client does not belong to this project/);
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(clientOutputTaskBody.agentTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const completeBundleTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Complete with valid canonical output bundle",
    }),
  }));
  assert.equal(completeBundleTask.status, 201);
  const completeBundleTaskBody = await completeBundleTask.json();

  const outputBundle = {
    projectId: "project-1",
    clientIds: ["client-1"],
    activityLogIds: ["activity-1"],
    proposalIds: ["proposal-1"],
    invoiceIds: ["invoice-1"],
    paymentIds: ["invoice-payment-1"],
    eventIds: ["event-1"],
    locationIds: ["location-1"],
    projectSourceIds: ["source-1"],
    questionnaireResponseIds: ["questionnaire-response-1"],
    schedulerBookingIds: ["booking-1"],
  };
  const completedBundle = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${completeBundleTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      resultSummary: "Agent completed every canonical output reference for this project.",
      outputJson: outputBundle,
    }),
  }), {
    params: Promise.resolve({ id: completeBundleTaskBody.agentTask.id }),
  });
  assert.equal(completedBundle.status, 200);
  const completedBundleBody = await completedBundle.json();
  assert.equal(completedBundleBody.agentTask.status, "completed");
  assert.deepEqual(JSON.parse(completedBundleBody.agentTask.outputJson), outputBundle);

  const activityOutputTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Complete with activity outputs",
    }),
  }));
  assert.equal(activityOutputTask.status, 201);
  const activityOutputTaskBody = await activityOutputTask.json();

  const badActivityOutput = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${activityOutputTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      outputJson: {
        activityLogIds: ["activity-1", "activity-other"],
      },
    }),
  }), {
    params: Promise.resolve({ id: activityOutputTaskBody.agentTask.id }),
  });
  assert.equal(badActivityOutput.status, 400);
  assert.match((await badActivityOutput.json()).error, /Agent task output activity log does not belong to this project/);
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(activityOutputTaskBody.agentTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const sourceOutputTask = await tasksRoute.POST(request("https://studio.bythereeses.com/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: "project-1",
      title: "Complete with source and intake outputs",
    }),
  }));
  assert.equal(sourceOutputTask.status, 201);
  const sourceOutputTaskBody = await sourceOutputTask.json();

  const badSourceOutput = await taskRoute.PATCH(request(`https://studio.bythereeses.com/api/agent/tasks/${sourceOutputTaskBody.agentTask.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      outputJson: {
        projectSourceIds: ["source-1", "source-other"],
        questionnaireResponseIds: ["questionnaire-response-1", "questionnaire-response-other"],
        schedulerBookingIds: ["booking-1", "booking-other"],
      },
    }),
  }), {
    params: Promise.resolve({ id: sourceOutputTaskBody.agentTask.id }),
  });
  assert.equal(badSourceOutput.status, 400);
  assert.match((await badSourceOutput.json()).error, /Agent task output project source does not belong to this project/);
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(sourceOutputTaskBody.agentTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  console.log("agent task route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
