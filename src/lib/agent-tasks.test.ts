import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-tasks-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { claimNextAgentTask, createAgentTask, createProjectAgentTaskFromForm, getAgentTaskInbox, hydrateAgentTaskLinkedSource, updateProjectAgentTaskFromForm, updateAgentTaskFromForm, updateAgentTaskStatus } = await import("./agent-tasks");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?),
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
      'source-1', 'project-1', 'discovery_call', 'Discovery call source',
      'Call notes for timeline and proposal generation.', 'Discovery summary', 'Studio UI',
      'studio_project', 'manual-source-1', ?, ?
    )
  `).run("2026-05-29T12:01:00.000Z", "2026-05-29T12:01:00.000Z");
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, source_type, source_id, created_at, updated_at
    ) VALUES (
      'source-other', 'project-2', 'discovery_call', 'Other discovery call source',
      'Other project source body.', 'Other summary', 'Studio UI',
      'studio_project', 'manual-source-other', ?, ?
    )
  `).run(now, now);
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
    INSERT INTO proposals (id, project_id, title, status, total_cents, created_at, updated_at)
    VALUES
      ('proposal-1', 'project-1', 'Alex Proposal', 'draft', 900000, ?, ?),
      ('proposal-other', 'project-2', 'Other Proposal', 'draft', 500000, ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoices (id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents, created_at, updated_at)
    VALUES
      ('invoice-1', 'project-1', 'proposal-1', 'INV-AGENT-TASK', 'draft', 900000, 0, ?, ?),
      ('invoice-other', 'project-2', NULL, 'INV-OTHER-TASK', 'draft', 500000, 0, ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
    VALUES
      ('invoice-payment-1', 'invoice-1', 'Retainer', 300000, '2026-06-01', 'paid', ?, ?),
      ('invoice-payment-other', 'invoice-other', 'Retainer', 200000, '2026-06-02', 'paid', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_timeline_items (id, project_id, title, sort_order, created_by, created_at, updated_at)
    VALUES
      ('timeline-1', 'project-1', 'Draft family photo timeline', 0, 'agent', ?, ?),
      ('timeline-other', 'project-2', 'Other project timeline', 0, 'agent', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_events (id, project_id, type, title, event_date, created_at, updated_at)
    VALUES
      ('event-1', 'project-1', 'engagement', 'Engagement session', '2026-07-10', ?, ?),
      ('event-other', 'project-2', 'engagement', 'Other engagement session', '2026-07-11', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_locations (id, project_id, type, name, created_at, updated_at)
    VALUES
      ('location-1', 'project-1', 'portrait', 'Garden portrait path', ?, ?),
      ('location-other', 'project-2', 'portrait', 'Other portrait path', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_communications (id, project_id, direction, channel, status, subject, body, created_by, created_at, updated_at)
    VALUES
      ('communication-1', 'project-1', 'outbound', 'email', 'draft', 'Alex follow-up', 'Draft follow-up email.', 'agent', ?, ?),
      ('communication-other', 'project-2', 'outbound', 'email', 'draft', 'Other follow-up', 'Other project email.', 'agent', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO expenses (id, project_id, category, description, amount_cents, status, created_at, updated_at)
    VALUES
      ('expense-1', 'project-1', 'software', 'Timeline assistant subscription', 4900, 'paid', ?, ?),
      ('expense-other', 'project-2', 'software', 'Other project subscription', 2900, 'paid', ?, ?)
  `).run(now, now, now, now);

  const task = await createAgentTask({
    projectId: "project-1",
    title: "Create proposal from discovery call",
    instructions: "Use the discovery transcript to draft package, scope, invoice, and next steps.",
    requestedBy: "Tyler",
    sourceType: "discovery_call",
    sourceId: "call-1",
  });

  assert.equal(task.projectId, "project-1");
  assert.equal(task.status, "queued");
  assert.equal(task.title, "Create proposal from discovery call");
  assert.equal(task.instructions, "Use the discovery transcript to draft package, scope, invoice, and next steps.");

  const createdRow = database.prepare(`
    SELECT project_id, title, status, requested_by, source_type, source_id
    FROM agent_tasks
    WHERE id = ?
  `).get(task.id);
  assert.deepEqual(createdRow, {
    project_id: "project-1",
    title: "Create proposal from discovery call",
    status: "queued",
    requested_by: "Tyler",
    source_type: "discovery_call",
    source_id: "call-1",
  });

  const updated = await updateAgentTaskStatus(task.id, {
    status: "completed",
    resultSummary: "Proposal and invoice were drafted from the discovery call.",
    outputJson: { proposalId: "proposal-1", invoiceId: "invoice-1" },
  });

  assert.equal(updated.status, "completed");
  assert.equal(updated.completedAt !== null, true);
  assert.equal(updated.sourceType, "discovery_call");
  assert.equal(updated.sourceId, "call-1");

  const updatedRow = database.prepare(`
    SELECT status, result_summary, output_json, completed_at, source_type, source_id
    FROM agent_tasks
    WHERE id = ?
  `).get(task.id) as {
    status: string;
    result_summary: string;
    output_json: string;
    completed_at: string | null;
    source_type: string | null;
    source_id: string | null;
  };
  assert.equal(updatedRow.status, "completed");
  assert.equal(updatedRow.result_summary, "Proposal and invoice were drafted from the discovery call.");
  assert.deepEqual(JSON.parse(updatedRow.output_json), { proposalId: "proposal-1", invoiceId: "invoice-1" });
  assert.equal(typeof updatedRow.completed_at, "string");
  assert.equal(updatedRow.source_type, "discovery_call");
  assert.equal(updatedRow.source_id, "call-1");

  const activity = database.prepare("SELECT action, actor_type FROM activity_logs WHERE action LIKE 'agent.task.%' ORDER BY created_at").all();
  assert.deepEqual(activity, [
    { action: "agent.task.created", actor_type: "agent" },
    { action: "agent.task.updated", actor_type: "agent" },
  ]);

  const inbox = await getAgentTaskInbox();
  assert.equal(inbox.counts.completed, 1);
  assert.equal(inbox.counts.queued, 0);
  assert.deepEqual(inbox.tasks.map((row) => ({
    title: row.task.title,
    status: row.task.status,
    projectName: row.project?.name,
  })), [
    {
      title: "Create proposal from discovery call",
      status: "completed",
      projectName: "Alex Wedding",
    },
  ]);

  assert.throws(
    () => database.prepare(`
      INSERT INTO agent_tasks (
        id, project_id, title, status, priority, assigned_agent, source_type, source_id, created_at, updated_at
      ) VALUES (
        'task-drifted-source', 'project-1', 'Legacy task with drifted source link', 'queued', 'normal',
        'The Reeses Studio Agent', 'project_source', 'source-other', ?, ?
      )
    `).run("2026-05-29T12:01:00.000Z", "2026-05-29T12:01:00.000Z"),
    /agent task project_source links must point to a source in the same project/,
  );
  const hydratedMissingTask = await hydrateAgentTaskLinkedSource(null);
  assert.equal(hydratedMissingTask, null);

  await assert.rejects(
    () => createAgentTask({ projectId: "missing-project", title: "Missing project" }),
    /Project not found/,
  );
  await assert.rejects(
    () => createAgentTask({
      projectId: "project-1",
      title: "Half-linked source task",
      sourceId: "source-1",
    }),
    /Agent task source links require sourceType and sourceId together/,
  );
  await assert.rejects(
    () => updateAgentTaskStatus(task.id, { status: "not-a-status" }),
    /Unsupported agent task status/,
  );
  await assert.rejects(
    () => updateAgentTaskStatus(task.id, { status: "queued" }),
    /Completed agent tasks cannot be reopened/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, result_summary, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(task.id), {
    status: "completed",
    result_summary: "Proposal and invoice were drafted from the discovery call.",
    output_json: JSON.stringify({ proposalId: "proposal-1", invoiceId: "invoice-1" }),
    completed_at: updated.completedAt,
  });
  const repeatedComplete = await updateAgentTaskStatus(task.id, { status: "completed" });
  assert.equal(repeatedComplete.completedAt, updated.completedAt);
  assert.equal(repeatedComplete.resultSummary, "Proposal and invoice were drafted from the discovery call.");
  assert.equal(repeatedComplete.outputJson, JSON.stringify({ proposalId: "proposal-1", invoiceId: "invoice-1" }));

  const formData = new FormData();
  formData.set("title", "Draft family photo timeline");
  formData.set("instructions", "Use the questionnaire responses and project notes.");
  formData.set("priority", "high");
  formData.set("assignedAgent", "Timeline Agent");

  const formTask = await createProjectAgentTaskFromForm("project-1", formData);
  assert.equal(formTask.projectId, "project-1");
  assert.equal(formTask.title, "Draft family photo timeline");
  assert.equal(formTask.instructions, "Use the questionnaire responses and project notes.");
  assert.equal(formTask.priority, "high");
  assert.equal(formTask.assignedAgent, "Timeline Agent");
  assert.equal(formTask.requestedBy, "Studio UI");
  assert.equal(formTask.sourceType, "studio_project");

  const relinkedFormTask = await updateAgentTaskStatus(formTask.id, {
    status: "queued",
    assignedAgent: "Timeline Agent",
    sourceType: "project_source",
    sourceId: "source-1",
  });
  assert.equal(relinkedFormTask.sourceType, "project_source");
  assert.equal(relinkedFormTask.sourceId, "source-1");
  assert.deepEqual(database.prepare(`
    SELECT source_type, source_id
    FROM agent_tasks
    WHERE id = ?
  `).get(formTask.id), {
    source_type: "project_source",
    source_id: "source-1",
  });
  const hydratedRelinkedFormTask = await hydrateAgentTaskLinkedSource(relinkedFormTask);
  assert.equal(hydratedRelinkedFormTask.linkedSource?.id, "source-1");
  await assert.rejects(
    () => updateAgentTaskStatus(formTask.id, {
      status: "queued",
      assignedAgent: "Timeline Agent",
      sourceType: "project_source",
      sourceId: "source-other",
    }),
    /Project source not found/,
  );
  await assert.rejects(
    () => updateAgentTaskStatus(formTask.id, {
      status: "queued",
      assignedAgent: "Timeline Agent",
      sourceType: null,
      sourceId: "source-1",
    }),
    /Agent task source links require sourceType and sourceId together/,
  );

  const sourceFormData = new FormData();
  sourceFormData.set("title", "Draft proposal from selected discovery call");
  sourceFormData.set("instructions", "Use the selected source record.");
  sourceFormData.set("priority", "high");
  sourceFormData.set("assignedAgent", "Proposal Agent");
  sourceFormData.set("projectSourceId", "source-1");

  const sourceFormTask = await createProjectAgentTaskFromForm("project-1", sourceFormData);
  assert.equal(sourceFormTask.title, "Draft proposal from selected discovery call");
  assert.equal(sourceFormTask.sourceType, "project_source");
  assert.equal(sourceFormTask.sourceId, "source-1");

  const duplicateSourceFormTask = await createProjectAgentTaskFromForm("project-1", sourceFormData);
  assert.equal(duplicateSourceFormTask.id, sourceFormTask.id);
  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM agent_tasks
    WHERE project_id = 'project-1'
      AND title = 'Draft proposal from selected discovery call'
      AND source_type = 'project_source'
      AND source_id = 'source-1'
      AND status IN ('queued', 'in_progress')
  `).get(), { count: 1 });

  const proposalOnlyTask = await createAgentTask({
    projectId: "project-2",
    title: "Proposal specialist task",
    assignedAgent: "Proposal Agent",
  });
  const timelineOnlyTask = await createAgentTask({
    projectId: "project-2",
    title: "Timeline specialist task",
    assignedAgent: "Timeline Agent",
  });
  const specialistClaimed = await claimNextAgentTask({
    projectId: "project-2",
    assignedAgent: "Timeline Agent",
  });
  assert.equal(specialistClaimed?.id, timelineOnlyTask.id);
  assert.equal(specialistClaimed?.assignedAgent, "Timeline Agent");
  assert.deepEqual(database.prepare(`
    SELECT status, assigned_agent
    FROM agent_tasks
    WHERE id = ?
  `).get(proposalOnlyTask.id), {
    status: "queued",
    assigned_agent: "Proposal Agent",
  });

  const wrongOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with wrong project output",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(wrongOutputTask.id, {
      status: "completed",
      outputJson: { proposalId: "proposal-other" },
    }),
    /Agent task output proposal does not belong to this project/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(wrongOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });
  const uncitedSourceOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete source-linked task with uncited proposal",
    sourceType: "project_source",
    sourceId: "source-1",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(uncitedSourceOutputTask.id, {
      status: "completed",
      outputJson: { proposalId: "proposal-1" },
    }),
    /Agent task output proposal must cite the task project source/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(uncitedSourceOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });
  database.prepare(`
    UPDATE proposals
    SET source_type = 'project_source', source_id = 'source-1'
    WHERE id = 'proposal-1'
  `).run();
  const citedSourceOutput = await updateAgentTaskStatus(uncitedSourceOutputTask.id, {
    status: "completed",
    outputJson: { proposalId: "proposal-1" },
  });
  assert.equal(citedSourceOutput.status, "completed");
  assert.deepEqual(JSON.parse(citedSourceOutput.outputJson ?? "{}"), { proposalId: "proposal-1" });
  const malformedOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with malformed output",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(malformedOutputTask.id, {
      status: "completed",
      outputJson: ["proposal-1"],
    }),
    /Agent task output must be a structured object/,
  );
  await assert.rejects(
    () => updateAgentTaskStatus(malformedOutputTask.id, {
      status: "completed",
      outputJson: "proposal-1",
    }),
    /Agent task output must be a structured object/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(malformedOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });
  const malformedReferenceOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with malformed reference ids",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(malformedReferenceOutputTask.id, {
      status: "completed",
      outputJson: { proposalIds: ["proposal-1", 42] },
    }),
    /Agent task output references must be non-empty string ids/,
  );
  await assert.rejects(
    () => updateAgentTaskStatus(malformedReferenceOutputTask.id, {
      status: "completed",
      outputJson: { proposalId: 42 },
    }),
    /Agent task output references must be non-empty string ids/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(malformedReferenceOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });
  const wrongProjectOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with wrong project id output",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(wrongProjectOutputTask.id, {
      status: "completed",
      outputJson: { projectId: "project-2" },
    }),
    /Agent task output project does not match this task/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(wrongProjectOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });
  const wrongProjectArrayOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with wrong project id array output",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(wrongProjectArrayOutputTask.id, {
      status: "completed",
      outputJson: { projectIds: ["project-1", "project-2"] },
    }),
    /Agent task output project does not match this task/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(wrongProjectArrayOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });
  const wrongCommunicationOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with wrong project communication output",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(wrongCommunicationOutputTask.id, {
      status: "completed",
      outputJson: { communicationId: "communication-other" },
    }),
    /Agent task output communication does not belong to this project/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(wrongCommunicationOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const wrongExpenseOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with wrong project expense output",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(wrongExpenseOutputTask.id, {
      status: "completed",
      outputJson: { expenseId: "expense-other" },
    }),
    /Agent task output expense does not belong to this project/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(wrongExpenseOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const wrongArrayOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with wrong project array outputs",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(wrongArrayOutputTask.id, {
      status: "completed",
      outputJson: {
        proposalIds: ["proposal-1", "proposal-other"],
        timelineIds: ["timeline-1", "timeline-other"],
      },
    }),
    /Agent task output proposal does not belong to this project/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(wrongArrayOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const wrongLogisticsOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with wrong project event and location outputs",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(wrongLogisticsOutputTask.id, {
      status: "completed",
      outputJson: {
        eventIds: ["event-1", "event-other"],
        locationIds: ["location-1", "location-other"],
      },
    }),
    /Agent task output project event does not belong to this project/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(wrongLogisticsOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });
  const wrongInvoicePaymentOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with wrong invoice payment output",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(wrongInvoicePaymentOutputTask.id, {
      status: "completed",
      outputJson: {
        invoicePaymentIds: ["invoice-payment-1", "invoice-payment-other"],
      },
    }),
    /Agent task output invoice payment does not belong to this project/,
  );
  await assert.rejects(
    () => updateAgentTaskStatus(wrongInvoicePaymentOutputTask.id, {
      status: "completed",
      outputJson: {
        paymentIds: ["invoice-payment-1", "invoice-payment-other"],
      },
    }),
    /Agent task output invoice payment does not belong to this project/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(wrongInvoicePaymentOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const wrongClientOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with wrong project client output",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(wrongClientOutputTask.id, {
      status: "completed",
      outputJson: {
        clientIds: ["client-1", "client-other"],
      },
    }),
    /Agent task output client does not belong to this project/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(wrongClientOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });
  const wrongActivityOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with wrong project activity output",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(wrongActivityOutputTask.id, {
      status: "completed",
      outputJson: {
        activityLogIds: ["activity-1", "activity-other"],
      },
    }),
    /Agent task output activity log does not belong to this project/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(wrongActivityOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });
  const wrongLocationOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with wrong project location output",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(wrongLocationOutputTask.id, {
      status: "completed",
      outputJson: {
        eventIds: ["event-1"],
        locationIds: ["location-1", "location-other"],
      },
    }),
    /Agent task output project location does not belong to this project/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(wrongLocationOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const wrongSourceOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with wrong project source outputs",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(wrongSourceOutputTask.id, {
      status: "completed",
      outputJson: { projectSourceIds: ["source-1", "source-other"] },
    }),
    /Agent task output project source does not belong to this project/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(wrongSourceOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  const wrongIntakeOutputTask = await createAgentTask({
    projectId: "project-1",
    title: "Complete with wrong questionnaire and booking outputs",
  });
  await assert.rejects(
    () => updateAgentTaskStatus(wrongIntakeOutputTask.id, {
      status: "completed",
      outputJson: {
        questionnaireResponseIds: ["questionnaire-response-1", "questionnaire-response-other"],
        schedulerBookingIds: ["booking-1", "booking-other"],
      },
    }),
    /Agent task output questionnaire response does not belong to this project/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(wrongIntakeOutputTask.id), {
    status: "queued",
    output_json: null,
    completed_at: null,
  });

  for (let index = 0; index < 3; index += 1) {
    await createAgentTask({
      projectId: "project-1",
      title: `Queued task ${index + 1}`,
    });
  }

  const claimed = await claimNextAgentTask({
    projectId: "project-1",
    assignedAgent: "Timeline Agent",
  });
  assert.equal(claimed?.title, "Draft family photo timeline");
  assert.equal(claimed?.status, "in_progress");
  assert.equal(claimed?.assignedAgent, "Timeline Agent");
  assert.equal(typeof claimed?.startedAt, "string");

  const claimedRow = database.prepare(`
    SELECT status, assigned_agent, started_at
    FROM agent_tasks
    WHERE id = ?
  `).get(claimed?.id) as { status: string; assigned_agent: string; started_at: string | null };
  assert.deepEqual({
    status: claimedRow.status,
    assignedAgent: claimedRow.assigned_agent,
    startedAtType: typeof claimedRow.started_at,
  }, {
    status: "in_progress",
    assignedAgent: "Timeline Agent",
    startedAtType: "string",
  });

  const nextClaimed = await claimNextAgentTask({ projectId: "project-1", assignedAgent: "Proposal Agent" });
  assert.equal(nextClaimed?.title, "Draft proposal from selected discovery call");
  assert.equal(nextClaimed?.assignedAgent, "Proposal Agent");
  assert.equal(nextClaimed?.sourceType, "project_source");
  assert.equal(nextClaimed?.sourceId, "source-1");

  const limitedInbox = await getAgentTaskInbox(1);
  assert.equal(limitedInbox.tasks.length, 1);
  assert.equal(limitedInbox.counts.queued, 19);
  assert.equal(limitedInbox.counts.inProgress, 3);
  assert.equal(limitedInbox.counts.completed, 2);

  await createAgentTask({
    projectId: "project-1",
    title: "Inbox filter proposal task",
    instructions: "Visible in the Proposal Agent filtered inbox.",
    assignedAgent: "Proposal Agent",
  });
  const proposalInbox = await getAgentTaskInbox({ status: "queued", assignedAgent: "Proposal Agent", limit: 10 });
  assert.equal(proposalInbox.tasks.every((row) => row.task.status === "queued"), true);
  assert.equal(proposalInbox.tasks.some((row) => row.task.title === "Inbox filter proposal task"), true);
  assert.equal(proposalInbox.tasks.some((row) => row.task.assignedAgent === "Timeline Agent"), false);
  assert.equal(proposalInbox.counts.queued > 0, true);
  assert.equal(proposalInbox.counts.inProgress > 0, true);

  database.prepare(`
    UPDATE project_timeline_items
    SET source_type = 'project_source', source_id = 'source-1'
    WHERE id = 'timeline-1'
  `).run();

  const updateFormData = new FormData();
  updateFormData.set("status", "completed");
  updateFormData.set("resultSummary", "Studio reviewed the generated timeline and marked it ready.");
  updateFormData.set("outputJson", JSON.stringify({ timelineId: "timeline-1", reviewedBy: "Studio" }));

  const studioUpdated = await updateAgentTaskFromForm(formTask.id, updateFormData);
  assert.equal(studioUpdated.id, formTask.id);
  assert.equal(studioUpdated.status, "completed");
  assert.equal(studioUpdated.resultSummary, "Studio reviewed the generated timeline and marked it ready.");
  assert.equal(studioUpdated.completedAt !== null, true);

  assert.deepEqual(database.prepare(`
    SELECT status, result_summary, output_json, completed_at
    FROM agent_tasks
    WHERE id = ?
  `).get(formTask.id), {
    status: "completed",
    result_summary: "Studio reviewed the generated timeline and marked it ready.",
    output_json: JSON.stringify({ timelineId: "timeline-1", reviewedBy: "Studio" }),
    completed_at: studioUpdated.completedAt,
  });

  assert.deepEqual(database.prepare(`
    SELECT action, actor_type, actor_name
    FROM activity_logs
    WHERE action = 'agent.task.updated_by_admin'
  `).get(), {
    action: "agent.task.updated_by_admin",
    actor_type: "admin",
    actor_name: "The Reeses Studio",
  });

  await assert.rejects(
    () => updateProjectAgentTaskFromForm("project-2", formTask.id, updateFormData),
    /Agent task not found/,
  );

  console.log("agent task tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
