import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-studio-mcp-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STRIPE_SECRET_KEY = "sk_test_studio_mcp";

async function main() {
  const { rawDb } = await import("@/db/client");
  const { handleStudioMcpMessage, getStudioProjectContext } = await import("./studio-mcp");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO app_settings (
      id, business_name, public_brand_name, contact_email, website_url, instagram_url, timezone, payment_methods_json, created_at, updated_at
    ) VALUES ('business', 'The Reeses Studio', 'The Reeses Studio', 'hello@bythereeses.com', 'https://bythereeses.com', 'https://instagram.com/thereeses', 'America/New_York', ?, ?, ?)
  `).run(JSON.stringify({
    stripe: { enabled: true, passFees: true, displayName: "Credit card", instructions: "" },
    zelle: { enabled: true, passFees: false, displayName: "Zelle", instructions: "hello@bythereeses.com" },
    venmo: { enabled: false, passFees: false, displayName: "Venmo", instructions: "" },
    cashCheck: { enabled: false, passFees: false, displayName: "Cash or check", instructions: "" },
  }), now, now);

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, venue_name, city, state, budget_cents, created_at, updated_at)
    VALUES ('project-2', 'Maya Corporate Retreat', 'brand', 'planning', 'active', '2026-10-10', 'The Foundry', 'Brooklyn', 'NY', 1200000, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', '555-0100', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, created_at, updated_at)
    VALUES ('client-2', 'Jordan', 'Taylor', 'jordan@example.com', '555-0101', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-2', 'project-1', 'client-2', 'partner', 0, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, created_at, updated_at)
    VALUES ('client-3', 'Maya', 'Chen', 'maya@example.com', '555-0102', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-orphan', 'Bailey', 'Bickley', 'bailey@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-3', 'project-2', 'client-3', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_events (id, project_id, type, title, event_date, venue_name, city, state, created_at, updated_at)
    VALUES ('event-1', 'project-1', 'wedding', 'Wedding Day', '2026-09-19', 'The Garden House', 'Hudson', 'NY', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      payment_notes, accepted_payment_methods_json, card_fee_policy, card_fee_amount_cents,
      stripe_payment_link, zelle_info, venmo_info, created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-1', 'draft', 100000, 25000,
      'Pay by card or Zelle.', ?, 'client_pays', 2930,
      'https://pay.stripe.com/test_context_invoice', 'hello@bythereeses.com', '@the-reeses', ?, ?
    )
  `).run(JSON.stringify([
    {
      key: "stripe",
      enabled: true,
      passFees: true,
      displayName: "Credit card",
      instructions: "",
    },
    {
      key: "zelle",
      enabled: true,
      passFees: false,
      displayName: "Zelle",
      instructions: "hello@bythereeses.com",
    },
  ]), now, now);
  database.prepare(`
    INSERT INTO proposals (id, project_id, title, status, total_cents, created_at, updated_at)
    VALUES ('proposal-1', 'project-1', 'MCP Existing Proposal', 'draft', 100000, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, external_payment_id, notes, created_at, updated_at
    ) VALUES (
      'payment-1', 'invoice-1', 'Retainer', 25000, '2026-06-01', 'paid', '2026-06-02T10:00:00.000Z', 'stripe',
      25000, 755, 755, 25755,
      25000, 'pi_context_123', 'Paid by card', ?, ?
    ), (
      'payment-2', 'invoice-1', 'Final payment', 75000, '2026-08-19', 'pending', NULL, NULL,
      0, 0, 0, 0,
      0, NULL, NULL, ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, collect_payment, price_cents,
      stripe_payment_link, invitee_questions_json, created_at, updated_at
    ) VALUES (
      'meeting-1', 'paid-consult', 'Paid Consultation', 45, 15, 1, 25000,
      'https://pay.stripe.com/test_mcp_scheduler', ?, ?, ?
    )
  `).run(JSON.stringify([
    {
      id: "coverage_priorities",
      label: "What should we prioritize?",
      type: "textarea",
      required: false,
    },
    {
      id: "must_have_events",
      label: "Must-have events",
      type: "checkbox",
      required: false,
      options: ["First look", "Family formals", "Reception details"],
    },
  ]), now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, client_id, attendee_name, attendee_email,
      invitee_answers_json, start_at, end_at, status, source, created_at, updated_at
    ) VALUES (
      'booking-1', 'meeting-1', 'project-1', 'client-1', 'Alex Taylor', 'alex@example.com',
      ?, '2026-06-01T14:00:00.000Z', '2026-06-01T14:45:00.000Z', 'confirmed', 'booking_link', ?, ?
    )
  `).run(JSON.stringify({
    coverage_priorities: "Family, ceremony emotion, and calm portraits.",
    must_have_events: ["First look", "Family formals"],
  }), now, now);
  database.prepare(`
    INSERT INTO questionnaires (id, title, description, status, created_at, updated_at)
    VALUES ('questionnaire-1', 'Timeline Questionnaire', 'Planning form', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO templates (id, type, name, trigger, subject, body, status, created_at, updated_at)
    VALUES
      ('template-contract', 'contract', 'Wedding Agreement', 'proposal ready', 'Agreement', 'Agreement for {{client.name}}.', 'active', ?, ?),
      ('template-package', 'proposal_package', 'Signature Collection', 'discovery call complete', 'Collection overview', 'Package for {{project.name}}.', 'active', ?, ?),
      ('template-reminder', 'reminder', 'Invoice Follow-up', '3 days before due date', NULL, 'Balance reminder for {{invoice.balanceDue}}.', 'draft', ?, ?)
  `).run(now, now, now, now, now, now);
  database.prepare(`
    INSERT INTO questionnaire_questions (
      id, questionnaire_id, title, description, type, required, sort_order, created_at, updated_at
    ) VALUES (
      'question-timeline-notes', 'questionnaire-1', 'Timeline notes', 'Planning notes from client intake.', 'paragraph', 1, 0, ?, ?
    ), (
      'question-family-priorities', 'questionnaire-1', 'Family priorities', NULL, 'paragraph', 0, 1, ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO questionnaire_responses (
      id, questionnaire_id, project_id, client_id, respondent_name, respondent_email,
      submitted_at, answers_json, created_at, updated_at
    ) VALUES (
      'response-1', 'questionnaire-1', 'project-1', 'client-1', 'Alex Taylor', 'alex@example.com',
      '2026-05-30T12:00:00.000Z', ?, ?, ?
    )
  `).run(JSON.stringify([
    {
      questionId: "timeline-notes",
      title: "Timeline notes",
      type: "paragraph",
      required: true,
      value: "Family formals after first look.",
    },
  ]), now, now);
  database.prepare(`
    INSERT INTO activity_logs (id, project_id, client_id, action, actor_type, actor_name, metadata, created_at)
    VALUES (
      'activity-agent-1', 'project-1', 'client-1', 'invoice.checkout_session_created',
      'agent', 'The Reeses Studio Agent', '{"invoiceId":"invoice-1"}', '2026-05-29T13:00:00.000Z'
    )
  `).run();

  const initialize = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-agent", version: "1.0.0" },
    },
  });

  assert.deepEqual(initialize, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "the-reeses-studio",
        title: "The Reeses Studio MCP",
        version: "0.1.0",
      },
      instructions: "Use these tools to create canonical Studio records. Never invent project ids; call tools only with ids from Studio context.",
    },
  });

  const tools = await handleStudioMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(tools.jsonrpc, "2.0");
  assert.equal(tools.id, 2);
  assert.deepEqual(
    tools.result.tools.map((tool: { name: string }) => tool.name),
    [
      "studio_search_projects",
      "studio_get_project_context",
      "studio_get_client_context",
      "studio_get_agenda",
      "studio_list_activity",
      "studio_get_data_health",
      "studio_get_finance_report",
      "studio_get_business_review",
      "studio_get_daily_brief",
      "studio_get_settings",
      "studio_list_templates",
      "studio_list_questionnaires",
      "studio_list_scheduler_meeting_types",
      "studio_create_project",
      "studio_update_project",
      "studio_link_client_to_project",
      "studio_update_client",
      "studio_merge_clients",
      "studio_list_project_workflow_automations",
      "studio_setup_project_workflow_automation",
      "studio_queue_project_workflow_steps",
      "studio_create_agent_task",
      "studio_create_project_event",
      "studio_update_project_event",
      "studio_create_project_location",
      "studio_update_project_location",
      "studio_attach_gallery_link",
      "studio_create_project_source",
      "studio_update_project_source",
      "studio_claim_agent_task",
      "studio_start_agent_task_run",
      "studio_list_agent_tasks",
      "studio_update_agent_task",
      "studio_submit_workflow_task_result",
      "studio_run_workflow_draft_task",
      "studio_create_questionnaire_link",
      "studio_upsert_questionnaire_response",
      "studio_create_timeline_item",
      "studio_create_timeline_items",
      "studio_update_timeline_item",
      "studio_create_proposal",
      "studio_update_proposal",
      "studio_create_proposal_link",
      "studio_create_portal_link",
      "studio_create_invoice",
      "studio_update_invoice",
      "studio_record_invoice_payment",
      "studio_create_invoice_payment_checkout",
      "studio_update_invoice_payment",
      "studio_log_invoice_reminder",
      "studio_record_scheduler_booking_payment",
      "studio_update_scheduler_booking_payment",
      "studio_create_expense",
      "studio_update_expense",
      "studio_create_communication",
      "studio_update_communication",
      "studio_draft_sms",
      "studio_draft_email",
    ],
  );

  const settingsCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 19,
    method: "tools/call",
    params: {
      name: "studio_get_settings",
      arguments: {},
    },
  });

  assert.equal(settingsCall.result.isError, false);
  assert.deepEqual(settingsCall.result.structuredContent.settings.business, {
    businessName: "The Reeses Studio",
    publicBrandName: "The Reeses Studio",
    contactEmail: "hello@bythereeses.com",
    websiteUrl: "https://bythereeses.com",
    instagramUrl: "https://instagram.com/thereeses",
    timezone: "America/New_York",
  });
  assert.deepEqual(settingsCall.result.structuredContent.settings.paymentMethods, [
    { key: "stripe", displayName: "Credit card", instructions: "", passFees: true },
    { key: "zelle", displayName: "Zelle", instructions: "hello@bythereeses.com", passFees: false },
  ]);
  assert.equal(JSON.stringify(settingsCall.result.structuredContent).includes("token"), false);
  assert.equal(JSON.stringify(settingsCall.result.structuredContent).includes("secret"), false);

  const templateCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 18,
    method: "tools/call",
    params: {
      name: "studio_list_templates",
      arguments: {
        type: "proposal_package",
        includeArchived: false,
      },
    },
  });

  assert.equal(templateCall.result.isError, false);
  assert.deepEqual(templateCall.result.structuredContent.templates, [
    {
      id: "template-package",
      type: "proposal_package",
      name: "Signature Collection",
      trigger: "discovery call complete",
      subject: "Collection overview",
      body: "Package for {{project.name}}.",
      status: "active",
      updatedAt: now,
    },
  ]);

  const questionnaireListCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 21,
    method: "tools/call",
    params: {
      name: "studio_list_questionnaires",
      arguments: {},
    },
  });

  assert.equal(questionnaireListCall.result.isError, false);
  assert.deepEqual(questionnaireListCall.result.structuredContent.questionnaires, [
    {
      id: "questionnaire-1",
      title: "Timeline Questionnaire",
      description: "Planning form",
      status: "active",
      questionCount: 2,
      updatedAt: now,
      questions: [
        {
          id: "question-timeline-notes",
          title: "Timeline notes",
          description: "Planning notes from client intake.",
          type: "paragraph",
          required: true,
          options: [],
          sortOrder: 0,
        },
        {
          id: "question-family-priorities",
          title: "Family priorities",
          description: null,
          type: "paragraph",
          required: false,
          options: [],
          sortOrder: 1,
        },
      ],
    },
  ]);

  const schedulerMeetingTypesCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 22,
    method: "tools/call",
    params: {
      name: "studio_list_scheduler_meeting_types",
      arguments: {
        projectId: "project-1",
        clientId: "client-1",
      },
    },
  });

  assert.equal(schedulerMeetingTypesCall.result.isError, false);
  assert.deepEqual(schedulerMeetingTypesCall.result.structuredContent.meetingTypes.filter((meetingType: {
    id: string;
  }) => meetingType.id === "meeting-1").map((meetingType: {
    id: string;
    slug: string;
    name: string;
    bookingUrl: string;
    projectBookingUrl: string | null;
    collectPayment: boolean;
    priceCents: number | null;
  }) => ({
    id: meetingType.id,
    slug: meetingType.slug,
    name: meetingType.name,
    bookingUrl: meetingType.bookingUrl,
    projectBookingUrl: meetingType.projectBookingUrl?.replace(/\?project=.*/, "?project=<signed>"),
    collectPayment: meetingType.collectPayment,
    priceCents: meetingType.priceCents,
  })), [
    {
      id: "meeting-1",
      slug: "paid-consult",
      name: "Paid Consultation",
      bookingUrl: "http://localhost:3000/book/paid-consult",
      projectBookingUrl: "http://localhost:3000/book/paid-consult?project=<signed>",
      collectPayment: true,
      priceCents: 25000,
    },
  ]);

  const createProposalTool = tools.result.tools.find((tool: { name: string }) => tool.name === "studio_create_proposal");
  const updateProposalTool = tools.result.tools.find((tool: { name: string }) => tool.name === "studio_update_proposal");
  assert.equal(createProposalTool.inputSchema.properties.proposalPackageTemplateId.type, "string");
  assert.equal(updateProposalTool.inputSchema.properties.proposalPackageTemplateId.type, "string");
  assert.equal(createProposalTool.inputSchema.properties.contractTemplateId.type, "string");
  assert.equal(updateProposalTool.inputSchema.properties.contractTemplateId.type, "string");

  const createInvoiceTool = tools.result.tools.find((tool: { name: string }) => tool.name === "studio_create_invoice");
  const recordInvoicePaymentTool = tools.result.tools.find((tool: { name: string }) => tool.name === "studio_record_invoice_payment");
  assert.match(createInvoiceTool.description, /Tyler approval/);
  assert.match(recordInvoicePaymentTool.description, /Tyler approval/);

  const agendaCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: {
      name: "studio_get_agenda",
      arguments: {
        fromDate: "2026-05-29",
        toDate: "2026-10-31",
        types: ["call", "wedding"],
        limit: 10,
        timeZone: "America/New_York",
      },
    },
  });

  assert.equal(agendaCall.result.isError, false);
  assert.deepEqual(agendaCall.result.structuredContent.agenda.items.map((item: {
    id: string;
    category: string;
    kind: string;
    date: string;
    time: string | null;
    title: string;
    projectName: string | null;
    clientName: string | null;
    venueLabel: string | null;
    href: string;
  }) => ({
    id: item.id,
    category: item.category,
    kind: item.kind,
    date: item.date,
    time: item.time,
    title: item.title,
    projectName: item.projectName,
    clientName: item.clientName,
    venueLabel: item.venueLabel,
    href: item.href,
  })), [
    {
      id: "booking-1",
      category: "call",
      kind: "call",
      date: "2026-06-01",
      time: "10:00 AM",
      title: "Paid Consultation",
      projectName: "Alex Wedding",
      clientName: "Alex Taylor",
      venueLabel: null,
      href: "/scheduler/bookings/booking-1",
    },
    {
      id: "event-1",
      category: "wedding",
      kind: "session",
      date: "2026-09-19",
      time: null,
      title: "Wedding Day",
      projectName: "Alex Wedding",
      clientName: "Alex Taylor",
      venueLabel: "The Garden House, Hudson, NY",
      href: "/projects/project-1#events",
    },
    {
      id: "project-2:wedding",
      category: "wedding",
      kind: "session",
      date: "2026-10-10",
      time: null,
      title: "Wedding Day",
      projectName: "Maya Corporate Retreat",
      clientName: "Maya Chen",
      venueLabel: "The Foundry, Brooklyn, NY",
      href: "/projects/project-2",
    },
  ]);

  const activityCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 121,
    method: "tools/call",
    params: {
      name: "studio_list_activity",
      arguments: {
        actorType: "agent",
        projectId: "project-1",
        limit: 10,
      },
    },
  });
  assert.equal(activityCall.result.isError, false);
  assert.deepEqual(activityCall.result.structuredContent.activity.map((item: {
    id: string;
    action: string;
    label: string;
    actorType: string;
    project: { id: string; name: string } | null;
    client: { id: string; name: string; email: string } | null;
    metadata: Record<string, unknown> | null;
  }) => ({
    id: item.id,
    action: item.action,
    label: item.label,
    actorType: item.actorType,
    project: item.project,
    client: item.client,
    metadata: item.metadata,
  })), [
    {
      id: "activity-agent-1",
      action: "invoice.checkout_session_created",
      label: "Invoice checkout session created",
      actorType: "agent",
      project: { id: "project-1", name: "Alex Wedding" },
      client: { id: "client-1", name: "Alex Taylor", email: "alex@example.com" },
      metadata: { invoiceId: "invoice-1" },
    },
  ]);

  const dataHealthCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 122,
    method: "tools/call",
    params: {
      name: "studio_get_data_health",
      arguments: {},
    },
  });
  assert.equal(dataHealthCall.result.isError, false);
  assert.equal(dataHealthCall.result.structuredContent.dataHealth.summary.clientCount, 4);
  assert.deepEqual(dataHealthCall.result.structuredContent.dataHealth.issues.map((issue: { type: string }) => issue.type), ["client_without_project"]);

  const clientContextCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 21,
    method: "tools/call",
    params: {
      name: "studio_get_client_context",
      arguments: { clientId: "client-1" },
    },
  });
  assert.equal(clientContextCall.result.isError, false);
  assert.equal(clientContextCall.result.structuredContent.clientContext.client.id, "client-1");
  assert.deepEqual(
    clientContextCall.result.structuredContent.clientContext.projects.map((row: { project: { id: string } }) => row.project.id),
    ["project-1"],
  );
  assert.deepEqual(
    clientContextCall.result.structuredContent.clientContext.invoices.map((invoice: {
      id: string;
      openBalanceCents: number;
      nextPaymentDueDate: string | null;
    }) => ({
      id: invoice.id,
      openBalanceCents: invoice.openBalanceCents,
      nextPaymentDueDate: invoice.nextPaymentDueDate,
    })),
    [{
      id: "invoice-1",
      openBalanceCents: 77175,
      nextPaymentDueDate: "2026-08-19",
    }],
  );

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, notes, created_at, updated_at)
    VALUES ('client-duplicate', 'Alexandra', 'Taylor', 'alex.duplicate@example.com', '555-0199', 'Imported duplicate note.', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-duplicate', 'project-2', 'client-duplicate', 'planner', 0, ?)
  `).run(now);

  const mergeClientsCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 123,
    method: "tools/call",
    params: {
      name: "studio_merge_clients",
      arguments: {
        survivorClientId: "client-1",
        duplicateClientId: "client-duplicate",
      },
    },
  });
  assert.equal(mergeClientsCall.result.isError, false);
  assert.deepEqual(mergeClientsCall.result.structuredContent.merge, {
    survivorClientId: "client-1",
    duplicateClientId: "client-duplicate",
    linkedProjectIds: ["project-1", "project-2"],
  });
  assert.equal(database.prepare("SELECT count(*) AS count FROM clients WHERE id = 'client-duplicate'").get().count, 0);
  assert.deepEqual(database.prepare(`
    SELECT client_id, role, is_primary_contact
    FROM project_participants
    WHERE project_id = 'project-2'
  `).get(), {
    client_id: "client-1",
    role: "planner",
    is_primary_contact: 0,
  });
  const clientMergeActivity = database.prepare(`
    SELECT actor_type, actor_name, client_id
    FROM activity_logs
    WHERE action = 'client.merged'
  `).get() as { actor_type: string; actor_name: string; client_id: string };
  assert.equal(clientMergeActivity.client_id, "client-1");
  assert.equal(clientMergeActivity.actor_type, "agent");
  assert.equal(clientMergeActivity.actor_name, "The Reeses Studio Agent");

  const alexSearchCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 22,
    method: "tools/call",
    params: {
      name: "studio_search_projects",
      arguments: { query: "alex", limit: 5 },
    },
  });
  assert.equal(alexSearchCall.result.isError, false);
  const alexProjectSearchResult = alexSearchCall.result.structuredContent.projects.find((project: { id: string }) => project.id === "project-1");
  assert.equal(alexProjectSearchResult.openBalanceCents, 77175);

  const searchCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "studio_search_projects",
      arguments: { query: "maya", limit: 5 },
    },
  });

  assert.equal(searchCall.result.isError, false);
  assert.deepEqual(searchCall.result.structuredContent.projects, [
    {
      id: "project-2",
      name: "Maya Corporate Retreat",
      type: "brand",
      stage: "planning",
      status: "active",
      eventDate: "2026-10-10",
      venueName: "The Foundry",
      location: "Brooklyn, NY",
      budgetCents: 1200000,
      primaryClient: {
        id: "client-3",
        name: "Maya Chen",
        email: "maya@example.com",
        instagramHandle: null,
        communicationPreference: null,
        referralSource: null,
      },
      clientCount: 2,
      proposalCount: 0,
      invoiceCount: 0,
      openBalanceCents: 0,
    },
  ]);

  const createProjectCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 80,
    method: "tools/call",
    params: {
      name: "studio_create_project",
      arguments: {
        name: "Morgan and Riley Wedding",
        type: "wedding",
        eventDate: "2026-11-07",
        venueName: "Stone Mill",
        city: "Beacon",
        state: "NY",
        budgetCents: 1200000,
        primaryClient: {
          firstName: "Morgan",
          lastName: "Lee",
          preferredName: "Morgan",
          email: "morgan@example.com",
          phone: "555-0199",
          instagramHandle: "morganlee",
          communicationPreference: "Email for contracts; text for timeline logistics.",
          referralSource: "Planner referral",
          role: "bride",
        },
        intakeSource: {
          kind: "discovery_call",
          title: "Morgan inquiry call",
          body: "Morgan and Riley want a documentary wedding proposal and calm timeline.",
          summary: "Inquiry notes for project intake.",
          sourceType: "call_transcript",
          sourceId: "call-morgan-1",
        },
      },
    },
  });
  assert.equal(createProjectCall.result.isError, false);
  assert.equal(createProjectCall.result.structuredContent.project.name, "Morgan and Riley Wedding");
  assert.equal(createProjectCall.result.structuredContent.project.primaryClient.email, "morgan@example.com");
  assert.equal(createProjectCall.result.structuredContent.project.primaryClient.instagramHandle, "@morganlee");
  assert.equal(createProjectCall.result.structuredContent.project.primaryClient.communicationPreference, "Email for contracts; text for timeline logistics.");
  assert.equal(createProjectCall.result.structuredContent.project.primaryClient.referralSource, "Planner referral");
  assert.equal(createProjectCall.result.structuredContent.project.sourceType, "project_source");
  assert.equal(createProjectCall.result.structuredContent.project.sourceId, createProjectCall.result.structuredContent.project.intakeSource.id);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM projects WHERE name = 'Morgan and Riley Wedding'").get().count,
    1,
  );

  const existingClientProjectCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 801,
    method: "tools/call",
    params: {
      name: "studio_create_project",
      arguments: {
        name: "Bailey and Parker Wedding",
        type: "wedding",
        eventDate: "2027-05-15",
        budgetCents: 750000,
        primaryClient: {
          clientId: "client-orphan",
          role: "bride",
        },
      },
    },
  });
  assert.equal(existingClientProjectCall.result.isError, false);
  assert.equal(existingClientProjectCall.result.structuredContent.project.primaryClient.id, "client-orphan");
  assert.equal(existingClientProjectCall.result.structuredContent.project.primaryClient.email, "bailey@example.com");
  assert.deepEqual(database.prepare(`
    SELECT role, is_primary_contact
    FROM project_participants
    WHERE project_id = ? AND client_id = 'client-orphan'
  `).get(existingClientProjectCall.result.structuredContent.project.id), {
    role: "bride",
    is_primary_contact: 1,
  });

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-unlinked-planner', 'Parker', 'Planner', 'parker@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-link-test', 'Parker Planning Support', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  const linkClientCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 802,
    method: "tools/call",
    params: {
      name: "studio_link_client_to_project",
      arguments: {
        projectId: "project-link-test",
        clientId: "client-unlinked-planner",
        role: "planner",
      },
    },
  });
  assert.equal(linkClientCall.result.isError, false);
  assert.deepEqual(linkClientCall.result.structuredContent.link, {
    clientId: "client-unlinked-planner",
    projectId: "project-link-test",
    linked: true,
    updated: false,
    role: "planner",
  });
  assert.deepEqual(database.prepare(`
    SELECT role, is_primary_contact
    FROM project_participants
    WHERE project_id = 'project-link-test' AND client_id = 'client-unlinked-planner'
  `).get(), {
    role: "planner",
    is_primary_contact: 0,
  });

  const sourceCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 81,
    method: "tools/call",
    params: {
      name: "studio_create_project_source",
      arguments: {
        projectId: "project-1",
        kind: "discovery_call",
        title: "Discovery call notes",
        body: "Alex and Jordan want documentary coverage, a calm family timeline, and a simple payment plan.",
        summary: "Discovery notes for proposal and timeline drafting.",
        occurredAt: "2026-05-28T19:00:00.000Z",
        sourceType: "call_transcript",
        sourceId: "call-1",
      },
    },
  });
  assert.equal(sourceCall.result.isError, false);
  assert.equal(sourceCall.result.structuredContent.projectSource.projectId, "project-1");
  assert.equal(sourceCall.result.structuredContent.projectSource.kind, "discovery_call");

  const sourceUpdateCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 811,
    method: "tools/call",
    params: {
      name: "studio_update_project_source",
      arguments: {
        projectId: "project-1",
        projectSourceId: sourceCall.result.structuredContent.projectSource.id,
        title: "Discovery call notes - final cleaned source",
        body: "Final cleaned source text for proposal, invoice, and timeline drafting.",
        summary: "Final cleaned discovery notes.",
        metadata: { final: true },
      },
    },
  });
  assert.equal(sourceUpdateCall.result.isError, false);
  assert.equal(sourceUpdateCall.result.structuredContent.projectSource.id, sourceCall.result.structuredContent.projectSource.id);
  assert.equal(sourceUpdateCall.result.structuredContent.projectSource.title, "Discovery call notes - final cleaned source");

  const communicationCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 82,
    method: "tools/call",
    params: {
      name: "studio_create_communication",
      arguments: {
        projectId: "project-1",
        // Phase 14 §8: the agent send-clamp now covers email AND sms, so an agent
        // can only mark a call/note "sent" (a log, not a real send). Use a note
        // here to keep exercising the update→sent path the tool supports.
        channel: "note",
        subject: "Proposal next steps",
        body: "Hi Alex, here is the follow-up from our discovery call.",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });
  assert.equal(communicationCall.result.isError, false);
  assert.equal(communicationCall.result.structuredContent.communication.projectId, "project-1");
  assert.equal(communicationCall.result.structuredContent.communication.recipientEmail, "alex@example.com");
  assert.equal(communicationCall.result.structuredContent.communication.sourceType, "project_source");
  assert.equal(communicationCall.result.structuredContent.communication.sourceId, sourceCall.result.structuredContent.projectSource.id);

  const updateCommunicationCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 83,
    method: "tools/call",
    params: {
      name: "studio_update_communication",
      arguments: {
        projectId: "project-1",
        communicationId: communicationCall.result.structuredContent.communication.id,
        status: "sent",
        sentAt: "2026-05-29T14:30:00.000Z",
        body: "Hi Alex, this follow-up has been sent.",
      },
    },
  });
  assert.equal(updateCommunicationCall.result.isError, false);
  assert.equal(updateCommunicationCall.result.structuredContent.communication.id, communicationCall.result.structuredContent.communication.id);
  assert.equal(updateCommunicationCall.result.structuredContent.communication.status, "sent");
  assert.equal(updateCommunicationCall.result.structuredContent.communication.sentAt, "2026-05-29T14:30:00.000Z");

  const workflowListCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 870,
    method: "tools/call",
    params: {
      name: "studio_list_project_workflow_automations",
      arguments: { projectId: "project-1" },
    },
  });
  assert.equal(workflowListCall.result.isError, false);
  assert.equal(workflowListCall.result.structuredContent.availableSteps.length > 5, true);
  assert.deepEqual(workflowListCall.result.structuredContent.workflowRuns, []);

  const workflowSetupCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 871,
    method: "tools/call",
    params: {
      name: "studio_setup_project_workflow_automation",
      arguments: {
        projectId: "project-1",
        stepKeys: ["lead-introduction-text", "proposal-retainer-package"],
      },
    },
  });
  assert.equal(workflowSetupCall.result.isError, false);
  assert.equal(workflowSetupCall.result.structuredContent.workflowRun.workflowKey, "six-figure-maximized-workflow");
  assert.deepEqual(
    workflowSetupCall.result.structuredContent.workflowSteps.map((step: { stepKey: string; status: string }) => ({
      stepKey: step.stepKey,
      status: step.status,
    })),
    [
      { stepKey: "lead-introduction-text", status: "configured" },
      { stepKey: "proposal-retainer-package", status: "configured" },
    ],
  );
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM agent_tasks WHERE source_type = 'project_workflow_step'").get(), { count: 0 });

  const workflowQueueCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 872,
    method: "tools/call",
    params: {
      name: "studio_queue_project_workflow_steps",
      arguments: {
        workflowRunId: workflowSetupCall.result.structuredContent.workflowRun.id,
        stepKeys: ["proposal-retainer-package"],
      },
    },
  });
  assert.equal(workflowQueueCall.result.isError, false);
  assert.deepEqual(
    workflowQueueCall.result.structuredContent.queuedTasks.map((task: { title: string; assignedAgent: string }) => ({
      title: task.title,
      assignedAgent: task.assignedAgent,
    })),
    [{ title: "Create proposal and retainer task", assignedAgent: "Proposal Agent" }],
  );
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM agent_tasks WHERE source_type = 'project_workflow_step'").get(), { count: 1 });

  const taskCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "studio_create_agent_task",
      arguments: {
        projectId: "project-1",
        title: "Create proposal from discovery call",
        instructions: "Draft package, timeline, and invoice from call notes.",
        requestedBy: "Tyler",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });
  assert.equal(taskCall.result.isError, false);
  assert.equal(taskCall.result.structuredContent.agentTask.status, "queued");

  const proposalQueueTaskCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 901,
    method: "tools/call",
    params: {
      name: "studio_create_agent_task",
      arguments: {
        projectId: "project-1",
        title: "Proposal specialist queue",
        assignedAgent: "Proposal Agent",
      },
    },
  });
  assert.equal(proposalQueueTaskCall.result.isError, false);
  const timelineQueueTaskCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 902,
    method: "tools/call",
    params: {
      name: "studio_create_agent_task",
      arguments: {
        projectId: "project-1",
        title: "Timeline specialist queue",
        assignedAgent: "Timeline Agent",
      },
    },
  });
  assert.equal(timelineQueueTaskCall.result.isError, false);

  const proposalQueueCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 903,
    method: "tools/call",
    params: {
      name: "studio_list_agent_tasks",
      arguments: { projectId: "project-1", status: "queued", assignedAgent: "Proposal Agent", limit: 10 },
    },
  });
  assert.equal(proposalQueueCall.result.isError, false);
  assert.deepEqual(
    proposalQueueCall.result.structuredContent.agentTasks.map((task: { title: string }) => task.title).sort(),
    ["Create proposal and retainer task", "Create proposal from discovery call", "Proposal specialist queue"],
  );

  const workflowTaskRunCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 908,
    method: "tools/call",
    params: {
      name: "studio_start_agent_task_run",
      arguments: {
        taskId: workflowQueueCall.result.structuredContent.queuedTasks[0].id,
        projectId: "project-1",
        assignedAgent: "Proposal Agent",
      },
    },
  });
  assert.equal(workflowTaskRunCall.result.isError, false);
  assert.equal(workflowTaskRunCall.result.structuredContent.agentTaskRun.agentTask.status, "in_progress");
  assert.equal(workflowTaskRunCall.result.structuredContent.agentTaskRun.projectContext.project.id, "project-1");
  assert.equal(workflowTaskRunCall.result.structuredContent.agentTaskRun.workflow.step.stepKey, "proposal-retainer-package");
  assert.equal(
    workflowTaskRunCall.result.structuredContent.agentTaskRun.executionContract.completion.mcpTool,
    "studio_submit_workflow_task_result",
  );
  assert.deepEqual(database.prepare(`
    SELECT status
    FROM project_workflow_steps
    WHERE id = ?
  `).get(workflowQueueCall.result.structuredContent.workflowSteps.find((step: { stepKey: string }) => step.stepKey === "proposal-retainer-package").id), {
    status: "in_progress",
  });

  const workflowDraftPreviewCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 909,
    method: "tools/call",
    params: {
      name: "studio_run_workflow_draft_task",
      arguments: {
        taskId: workflowQueueCall.result.structuredContent.queuedTasks[0].id,
        projectId: "project-1",
        assignedAgent: "Proposal Agent",
        previewOnly: true,
      },
    },
  });
  assert.equal(workflowDraftPreviewCall.result.isError, false);
  assert.equal(workflowDraftPreviewCall.result.structuredContent.workflowDraftRun.completed, false);
  assert.match(workflowDraftPreviewCall.result.structuredContent.workflowDraftRun.draft.outputBody, /Proposal handoff/);
  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM project_sources
    WHERE source_type = 'project_workflow_step'
  `).get(), { count: 0 });

  const workflowTaskResultCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 907,
    method: "tools/call",
    params: {
      name: "studio_submit_workflow_task_result",
      arguments: {
        taskId: workflowQueueCall.result.structuredContent.queuedTasks[0].id,
        assignedAgent: "Proposal Agent",
        outputTitle: "Proposal and retainer task brief",
        outputBody: "Draft the proposal package, contract notes, and retainer invoice plan from canonical discovery material.",
        outputSummary: "Stored the workflow task brief as a project source.",
        outputKind: "workflow_draft",
      },
    },
  });
  assert.equal(workflowTaskResultCall.result.isError, false);
  assert.equal(workflowTaskResultCall.result.structuredContent.agentTask.status, "completed");
  assert.equal(workflowTaskResultCall.result.structuredContent.workflowStep.status, "completed");
  assert.equal(workflowTaskResultCall.result.structuredContent.projectSource.sourceType, "project_workflow_step");

  const claimSpecificTaskCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 904,
    method: "tools/call",
    params: {
      name: "studio_claim_agent_task",
      arguments: {
        taskId: proposalQueueTaskCall.result.structuredContent.agentTask.id,
        projectId: "project-1",
        assignedAgent: "Proposal Agent",
      },
    },
  });
  assert.equal(claimSpecificTaskCall.result.isError, false);
  assert.equal(claimSpecificTaskCall.result.structuredContent.agentTask.id, proposalQueueTaskCall.result.structuredContent.agentTask.id);
  assert.equal(claimSpecificTaskCall.result.structuredContent.agentTask.title, "Proposal specialist queue");
  assert.equal(claimSpecificTaskCall.result.structuredContent.agentTask.status, "in_progress");
  assert.equal(claimSpecificTaskCall.result.structuredContent.agentTask.assignedAgent, "Proposal Agent");

  const wrongSpecialistUpdateCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 905,
    method: "tools/call",
    params: {
      name: "studio_update_agent_task",
      arguments: {
        taskId: proposalQueueTaskCall.result.structuredContent.agentTask.id,
        status: "completed",
        assignedAgent: "Timeline Agent",
        resultSummary: "Timeline agent should not complete proposal work.",
      },
    },
  });
  assert.equal(wrongSpecialistUpdateCall.error.code, -32603);
  assert.match(wrongSpecialistUpdateCall.error.message, /Agent task is assigned to a different agent/);

  const missingSpecialistUpdateCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 906,
    method: "tools/call",
    params: {
      name: "studio_update_agent_task",
      arguments: {
        taskId: proposalQueueTaskCall.result.structuredContent.agentTask.id,
        status: "completed",
        resultSummary: "Anonymous update should not complete specialist work.",
      },
    },
  });
  assert.equal(missingSpecialistUpdateCall.error.code, -32603);
  assert.match(missingSpecialistUpdateCall.error.message, /Agent task updates for specialist-owned tasks require assignedAgent/);

  const claimTaskCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 91,
    method: "tools/call",
    params: {
      name: "studio_claim_agent_task",
      arguments: {
        taskId: taskCall.result.structuredContent.agentTask.id,
        projectId: "project-1",
        assignedAgent: "Proposal Agent",
      },
    },
  });
  assert.equal(claimTaskCall.result.isError, false);
  assert.equal(claimTaskCall.result.structuredContent.agentTask.id, taskCall.result.structuredContent.agentTask.id);
  assert.equal(claimTaskCall.result.structuredContent.agentTask.status, "in_progress");
  assert.equal(claimTaskCall.result.structuredContent.agentTask.assignedAgent, "Proposal Agent");
  assert.deepEqual(claimTaskCall.result.structuredContent.agentTask.linkedSource, {
    id: sourceCall.result.structuredContent.projectSource.id,
    kind: "discovery_call",
    title: "Discovery call notes - final cleaned source",
    body: "Final cleaned source text for proposal, invoice, and timeline drafting.",
    summary: "Final cleaned discovery notes.",
    occurredAt: "2026-05-28T19:00:00.000Z",
    externalUrl: null,
    capturedBy: "The Reeses Studio Agent",
    sourceType: "call_transcript",
    sourceId: "call-1",
  });

  const listTasksCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "studio_list_agent_tasks",
      arguments: { projectId: "project-1", status: "in_progress" },
    },
  });
  assert.equal(listTasksCall.result.structuredContent.agentTasks.length, 2);
  assert.deepEqual(
    listTasksCall.result.structuredContent.agentTasks.map((task: { title: string }) => task.title).sort(),
    ["Create proposal from discovery call", "Proposal specialist queue"],
  );
  const discoveryTask = listTasksCall.result.structuredContent.agentTasks.find((task: { title: string }) => task.title === "Create proposal from discovery call");
  assert.equal(discoveryTask.linkedSource.title, "Discovery call notes - final cleaned source");

  const relinkTaskCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 1001,
    method: "tools/call",
    params: {
      name: "studio_create_agent_task",
      arguments: {
        projectId: "project-1",
        title: "Relink task to corrected source",
        sourceType: "studio_project",
        sourceId: "legacy-task-source",
      },
    },
  });
  const relinkTaskUpdateCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 1002,
    method: "tools/call",
    params: {
      name: "studio_update_agent_task",
      arguments: {
        taskId: relinkTaskCall.result.structuredContent.agentTask.id,
        status: "queued",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });
  assert.equal(relinkTaskUpdateCall.result.structuredContent.agentTask.sourceType, "project_source");
  assert.equal(relinkTaskUpdateCall.result.structuredContent.agentTask.sourceId, sourceCall.result.structuredContent.projectSource.id);
  assert.equal(relinkTaskUpdateCall.result.structuredContent.agentTask.linkedSource.id, sourceCall.result.structuredContent.projectSource.id);

  database.prepare(`
    UPDATE proposals
    SET source_type = 'project_source', source_id = ?
    WHERE id = 'proposal-1'
  `).run(sourceCall.result.structuredContent.projectSource.id);

  const updateTaskCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "studio_update_agent_task",
      arguments: {
        taskId: taskCall.result.structuredContent.agentTask.id,
        status: "completed",
        assignedAgent: "Proposal Agent",
        resultSummary: "Proposal and invoice created.",
        outputJson: { proposalId: "proposal-1" },
      },
    },
  });
  assert.equal(updateTaskCall.result.structuredContent.agentTask.status, "completed");
  assert.equal(updateTaskCall.result.structuredContent.agentTask.sourceType, "project_source");
  assert.equal(updateTaskCall.result.structuredContent.agentTask.sourceId, sourceCall.result.structuredContent.projectSource.id);

  const wrongQuestionnaireLinkCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 91,
    method: "tools/call",
    params: {
      name: "studio_create_questionnaire_link",
      arguments: {
        projectId: "project-2",
        questionnaireId: "questionnaire-1",
        clientId: "client-orphan",
      },
    },
  });
  assert.equal(wrongQuestionnaireLinkCall.error.code, -32603);
  assert.match(wrongQuestionnaireLinkCall.error.message, /Questionnaire client is not linked to this project/);

  const questionnaireLinkCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 92,
    method: "tools/call",
    params: {
      name: "studio_create_questionnaire_link",
      arguments: {
        projectId: "project-1",
        questionnaireId: "questionnaire-1",
        clientId: "client-1",
      },
    },
  });
  assert.equal(questionnaireLinkCall.result.isError, false);
  assert.equal(questionnaireLinkCall.result.structuredContent.link.projectId, "project-1");
  assert.equal(questionnaireLinkCall.result.structuredContent.link.clientId, "client-1");
  assert.equal(questionnaireLinkCall.result.structuredContent.link.questionnaireId, "questionnaire-1");
  assert.match(questionnaireLinkCall.result.structuredContent.link.questionnaireUrl, /^http:\/\/localhost:3000\/questionnaires\/questionnaire-1\/preview\?context=/);
  assert.match(questionnaireLinkCall.result.structuredContent.link.timelineCallUrl, /^http:\/\/localhost:3000\/book\/wedding-photography-vision-and-timeline-call\?/);

  const questionnaireResponseCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 93,
    method: "tools/call",
    params: {
      name: "studio_upsert_questionnaire_response",
      arguments: {
        projectId: "project-1",
        questionnaireId: "questionnaire-1",
        clientId: "client-1",
        answers: {
          "question-timeline-notes": "First look, family formals, and ceremony emotion matter most.",
          "question-family-priorities": "Keep grandparents comfortable and photographed early.",
        },
        submit: true,
      },
    },
  });
  assert.equal(questionnaireResponseCall.result.isError, false);
  assert.equal(questionnaireResponseCall.result.structuredContent.questionnaireResponse.id, "response-1");
  assert.equal(questionnaireResponseCall.result.structuredContent.questionnaireResponse.projectId, "project-1");
  assert.equal(questionnaireResponseCall.result.structuredContent.questionnaireResponse.clientId, "client-1");
  assert.equal(questionnaireResponseCall.result.structuredContent.questionnaireResponse.questionnaireId, "questionnaire-1");
  assert.equal(questionnaireResponseCall.result.structuredContent.questionnaireResponse.status, "submitted");
  assert.deepEqual(questionnaireResponseCall.result.structuredContent.questionnaireResponse.answers.map((answer: {
    questionId: string;
    title: string;
    formattedValue: string;
  }) => ({
    questionId: answer.questionId,
    title: answer.title,
    formattedValue: answer.formattedValue,
  })), [
    {
      questionId: "question-timeline-notes",
      title: "Timeline notes",
      formattedValue: "First look, family formals, and ceremony emotion matter most.",
    },
    {
      questionId: "question-family-priorities",
      title: "Family priorities",
      formattedValue: "Keep grandparents comfortable and photographed early.",
    },
  ]);
  const agentQuestionnaireSource = database.prepare(`
    SELECT id, kind, title, body, source_type, source_id
    FROM project_sources
    WHERE source_id = ?
  `).get(questionnaireResponseCall.result.structuredContent.questionnaireResponse.id);
  assert.equal(agentQuestionnaireSource.kind, "questionnaire_response");
  assert.equal(agentQuestionnaireSource.title, "Questionnaire: Timeline Questionnaire");
  assert.match(agentQuestionnaireSource.body, /Keep grandparents comfortable/);
  assert.equal(agentQuestionnaireSource.source_type, "questionnaire_response");

  const timelineCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "studio_create_timeline_item",
      arguments: {
        projectId: "project-1",
        title: "Golden hour portraits",
        description: "Couple portraits near the garden.",
        startAt: "2026-09-19T22:30:00.000Z",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });

  assert.equal(timelineCall.result.isError, false);
  assert.equal(timelineCall.result.structuredContent.timelineItem.title, "Golden hour portraits");
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM project_timeline_items WHERE project_id = 'project-1'").get().count,
    1,
  );

  const timelineUpdateCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 32,
    method: "tools/call",
    params: {
      name: "studio_update_timeline_item",
      arguments: {
        projectId: "project-1",
        timelineItemId: timelineCall.result.structuredContent.timelineItem.id,
        title: "Golden hour portraits with family",
        description: "Couple portraits and quick family grouping near the garden.",
        startAt: "2026-09-19T22:45:00.000Z",
        endAt: "2026-09-19T23:15:00.000Z",
        sortOrder: 5,
      },
    },
  });

  assert.equal(timelineUpdateCall.result.isError, false);
  assert.equal(timelineUpdateCall.result.structuredContent.timelineItem.id, timelineCall.result.structuredContent.timelineItem.id);
  assert.equal(timelineUpdateCall.result.structuredContent.timelineItem.title, "Golden hour portraits with family");
  assert.equal(timelineUpdateCall.result.structuredContent.timelineItem.sourceType, "project_source");
  assert.equal(timelineUpdateCall.result.structuredContent.timelineItem.sourceId, sourceCall.result.structuredContent.projectSource.id);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM project_timeline_items WHERE project_id = 'project-1'").get().count,
    1,
  );

  const locationCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 330,
    method: "tools/call",
    params: {
      name: "studio_create_project_location",
      arguments: {
        projectId: "project-1",
        type: "portrait",
        name: "Garden portrait path",
        address: "12 Garden Lane",
        city: "Hudson",
        state: "NY",
        notes: "Agent pulled this from the discovery call.",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });

  assert.equal(locationCall.result.isError, false);
  assert.equal(locationCall.result.structuredContent.location.projectId, "project-1");
  assert.equal(locationCall.result.structuredContent.location.name, "Garden portrait path");
  assert.equal(locationCall.result.structuredContent.location.sourceType, "project_source");

  const locationUpdateCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 331,
    method: "tools/call",
    params: {
      name: "studio_update_project_location",
      arguments: {
        projectId: "project-1",
        locationId: locationCall.result.structuredContent.location.id,
        name: "Garden portrait path west",
        notes: "Updated after planner call.",
      },
    },
  });

  assert.equal(locationUpdateCall.result.isError, false);
  assert.equal(locationUpdateCall.result.structuredContent.location.id, locationCall.result.structuredContent.location.id);
  assert.equal(locationUpdateCall.result.structuredContent.location.name, "Garden portrait path west");
  assert.equal(locationUpdateCall.result.structuredContent.location.sourceType, "project_source");
  assert.equal(locationUpdateCall.result.structuredContent.location.sourceId, sourceCall.result.structuredContent.projectSource.id);

  const timelineBatchCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 31,
    method: "tools/call",
    params: {
      name: "studio_create_timeline_items",
      arguments: {
        projectId: "project-1",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
        timelineItems: [
          {
            title: "Getting ready",
            description: "Detail photos and final prep.",
            startAt: "2026-09-19T16:00:00.000Z",
            endAt: "2026-09-19T17:00:00.000Z",
          },
          {
            title: "Ceremony",
            description: "Garden ceremony.",
            startAt: "2026-09-19T20:00:00.000Z",
            endAt: "2026-09-19T20:30:00.000Z",
          },
        ],
      },
    },
  });

  assert.equal(timelineBatchCall.result.isError, false);
  assert.deepEqual(timelineBatchCall.result.structuredContent.timelineItems.map((item: {
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
    {
      title: "Getting ready",
      sortOrder: 6,
      sourceType: "project_source",
      sourceId: sourceCall.result.structuredContent.projectSource.id,
    },
    {
      title: "Ceremony",
      sortOrder: 7,
      sourceType: "project_source",
      sourceId: sourceCall.result.structuredContent.projectSource.id,
    },
  ]);

  const timelineReplacementCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 310,
    method: "tools/call",
    params: {
      name: "studio_create_timeline_items",
      arguments: {
        projectId: "project-1",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
        replaceExistingForSource: true,
        timelineItems: [
          {
            title: "Corrected getting ready",
            description: "Updated from revised source notes.",
            startAt: "2026-09-19T15:45:00.000Z",
            endAt: "2026-09-19T16:45:00.000Z",
          },
        ],
      },
    },
  });

  assert.equal(timelineReplacementCall.result.isError, false);
  assert.deepEqual(
    database.prepare(`
      SELECT title
      FROM project_timeline_items
      WHERE project_id = 'project-1' AND source_type = 'project_source' AND source_id = ?
      ORDER BY sort_order
    `).all(sourceCall.result.structuredContent.projectSource.id),
    [{ title: "Corrected getting ready" }],
  );

  const proposalCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "studio_create_proposal",
      arguments: {
        projectId: "project-1",
        title: "Discovery Call Proposal",
        packageName: "Heritage Day",
        scopeSummary: "Generated from discovery call notes.",
        contractTitle: "Photography Agreement",
        contractBody: "Draft terms from the call.",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
        lineItems: [
          { name: "Wedding photography coverage", quantity: 1, unitPriceCents: 900000 },
          { name: "Engagement session", quantity: 1, unitPriceCents: 150000, isOptional: true },
        ],
      },
    },
  });

  assert.equal(proposalCall.result.isError, false);
  assert.equal(proposalCall.result.structuredContent.proposal.projectId, "project-1");
  assert.equal(proposalCall.result.structuredContent.proposal.totalCents, 900000);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM proposals WHERE project_id = 'project-1'").get().count,
    2,
  );

  const proposalUpdateCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 405,
    method: "tools/call",
    params: {
      name: "studio_update_proposal",
      arguments: {
        projectId: "project-1",
        proposalId: proposalCall.result.structuredContent.proposal.proposalId,
        title: "Discovery Call Proposal Revised",
        packageName: "Heritage Weekend",
        scopeSummary: "Revised from follow-up discovery notes.",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
        lineItems: [
          { name: "Wedding photography coverage", quantity: 1, unitPriceCents: 950000 },
          { name: "Rehearsal dinner coverage", quantity: 1, unitPriceCents: 125000 },
        ],
      },
    },
  });

  assert.equal(proposalUpdateCall.result.isError, false);
  assert.equal(proposalUpdateCall.result.structuredContent.proposal.proposalId, proposalCall.result.structuredContent.proposal.proposalId);
  assert.equal(proposalUpdateCall.result.structuredContent.proposal.totalCents, 1075000);
  assert.deepEqual(database.prepare(`
    SELECT name, unit_price_cents, sort_order
    FROM proposal_line_items
    WHERE proposal_id = ?
    ORDER BY sort_order
  `).all(proposalCall.result.structuredContent.proposal.proposalId), [
    { name: "Wedding photography coverage", unit_price_cents: 950000, sort_order: 0 },
    { name: "Rehearsal dinner coverage", unit_price_cents: 125000, sort_order: 1 },
  ]);

  const proposalLinkCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 406,
    method: "tools/call",
    params: {
      name: "studio_create_proposal_link",
      arguments: {
        projectId: "project-1",
        proposalId: proposalCall.result.structuredContent.proposal.proposalId,
        clientId: "client-1",
        label: "MCP proposal link",
      },
    },
  });

  assert.equal(proposalLinkCall.result.isError, false);
  assert.equal(proposalLinkCall.result.structuredContent.link.proposalId, proposalCall.result.structuredContent.proposal.proposalId);
  assert.equal(proposalLinkCall.result.structuredContent.link.projectId, "project-1");
  assert.equal(proposalLinkCall.result.structuredContent.link.clientId, "client-1");
  assert.match(proposalLinkCall.result.structuredContent.link.url, /^http:\/\/localhost:3000\/proposal\//);
  assert.deepEqual(database.prepare(`
    SELECT proposal_id, project_id, client_id, label, length(token_hash) AS hash_length, revoked_at
    FROM proposal_access_tokens
    WHERE proposal_id = ?
  `).get(proposalCall.result.structuredContent.proposal.proposalId), {
    proposal_id: proposalCall.result.structuredContent.proposal.proposalId,
    project_id: "project-1",
    client_id: "client-1",
    label: "MCP proposal link",
    hash_length: 64,
    revoked_at: null,
  });

  const wrongPortalLinkCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 407,
    method: "tools/call",
    params: {
      name: "studio_create_portal_link",
      arguments: {
        projectId: "project-2",
        clientId: "client-orphan",
      },
    },
  });

  assert.equal(wrongPortalLinkCall.error.code, -32603);
  assert.match(wrongPortalLinkCall.error.message, /Portal client is not linked to this project/);

  const portalLinkCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 408,
    method: "tools/call",
    params: {
      name: "studio_create_portal_link",
      arguments: {
        projectId: "project-1",
        clientId: "client-1",
        label: "MCP portal link",
      },
    },
  });

  assert.equal(portalLinkCall.result.isError, false);
  assert.equal(portalLinkCall.result.structuredContent.link.projectId, "project-1");
  assert.equal(portalLinkCall.result.structuredContent.link.clientId, "client-1");
  assert.equal(portalLinkCall.result.structuredContent.link.label, "MCP portal link");
  assert.match(portalLinkCall.result.structuredContent.link.url, /^http:\/\/localhost:3000\/p\//);
  assert.deepEqual(database.prepare(`
    SELECT project_id, client_id, label, length(token_hash) AS hash_length, revoked_at
    FROM portal_access_tokens
    WHERE id = ?
  `).get(portalLinkCall.result.structuredContent.link.tokenId), {
    project_id: "project-1",
    client_id: "client-1",
    label: "MCP portal link",
    hash_length: 64,
    revoked_at: null,
  });

  const invoiceCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "studio_create_invoice",
      arguments: {
        projectId: "project-1",
        proposalId: proposalCall.result.structuredContent.proposal.proposalId,
        invoiceNumber: "INV-MCP",
        retainerPercent: 30,
        installmentCount: 1,
        acceptedPaymentMethods: ["stripe", "zelle"],
        stripePaymentLink: "https://pay.stripe.com/test_mcp_invoice",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });

  assert.equal(invoiceCall.error.code, -32603);
  assert.match(invoiceCall.error.message, /Invoices and payment schedules require Tyler approval/);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM invoices WHERE invoice_number = 'INV-MCP'").get().count,
    0,
  );

  const invoiceUpdateCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 505,
    method: "tools/call",
    params: {
      name: "studio_update_invoice",
      arguments: {
        projectId: "project-1",
        invoiceId: "invoice-1",
        status: "sent",
        totalCents: 1200000,
        retainerPercent: 25,
        installmentCount: 2,
        dueDate: "2026-06-15",
        paymentNotes: "Updated payment instructions from MCP.",
        acceptedPaymentMethods: ["stripe", "zelle"],
        stripePaymentLink: "https://pay.stripe.com/revised_mcp_invoice",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });

  assert.equal(invoiceUpdateCall.error.code, -32603);
  assert.match(invoiceUpdateCall.error.message, /Invoices and payment schedules require Tyler approval/);
  assert.deepEqual(database.prepare(`
    SELECT invoice_number, status, total_cents
    FROM invoices
    WHERE id = 'invoice-1'
  `).get(), {
    invoice_number: "INV-1",
    status: "draft",
    total_cents: 100000,
  });

  const expenseCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: "studio_create_expense",
      arguments: {
        projectId: "project-1",
        vendorName: "Canon Professional Services",
        category: "equipment",
        description: "Lens calibration from assistant receipt intake.",
        amountCents: 12500,
        status: "paid",
        paidAt: "2026-05-11",
        paymentMethod: "amex",
        externalPaymentId: "ch_mcp_expense_1",
        receiptUrl: "r2://receipts/ch_mcp_expense_1.pdf",
        taxDeductible: true,
        notes: "Recorded by agent from receipt.",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });

  assert.equal(expenseCall.result.isError, false);
  assert.equal(expenseCall.result.structuredContent.expense.projectId, "project-1");
  assert.equal(expenseCall.result.structuredContent.expense.vendorName, "Canon Professional Services");
  assert.equal(expenseCall.result.structuredContent.expense.amountCents, 12500);
  assert.equal(expenseCall.result.structuredContent.expense.sourceType, "project_source");
  assert.equal(expenseCall.result.structuredContent.expense.sourceId, sourceCall.result.structuredContent.projectSource.id);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM expenses WHERE project_id = 'project-1'").get().count,
    1,
  );

  const expenseUpdateCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 1205,
    method: "tools/call",
    params: {
      name: "studio_update_expense",
      arguments: {
        projectId: "project-1",
        expenseId: expenseCall.result.structuredContent.expense.id,
        vendorName: "B&H Photo",
        category: "equipment rental",
        description: "Corrected lens calibration receipt.",
        amountCents: 13500,
        status: "paid",
        paidAt: "2026-05-13",
        paymentMethod: "visa",
        externalPaymentId: "ch_mcp_expense_1_corrected",
        receiptUrl: "r2://receipts/ch_mcp_expense_1_corrected.pdf",
        taxDeductible: true,
        notes: "Agent corrected the OCR import.",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });

  assert.equal(expenseUpdateCall.result.isError, false);
  assert.equal(expenseUpdateCall.result.structuredContent.expense.id, expenseCall.result.structuredContent.expense.id);
  assert.equal(expenseUpdateCall.result.structuredContent.expense.vendorName, "B&H Photo");
  assert.equal(expenseUpdateCall.result.structuredContent.expense.amountCents, 13500);
  assert.equal(expenseUpdateCall.result.structuredContent.expense.externalPaymentId, "ch_mcp_expense_1_corrected");

  const originalFetch = globalThis.fetch;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = "https://studio.bythereeses.com";
  const checkoutStripeCalls: Array<URLSearchParams> = [];
  globalThis.fetch = (async (_url, init) => {
    checkoutStripeCalls.push(new URLSearchParams(String(init?.body ?? "")));
    return Response.json({
      id: "cs_test_mcp_invoice_final",
      url: "https://checkout.stripe.com/c/pay/cs_test_mcp_invoice_final",
    });
  }) as typeof fetch;
  const checkoutCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 1290,
    method: "tools/call",
    params: {
      name: "studio_create_invoice_payment_checkout",
      arguments: {
        invoiceId: "invoice-1",
        paymentId: "payment-2",
      },
    },
  }).finally(() => {
    globalThis.fetch = originalFetch;
    if (originalAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
  });

  assert.equal(checkoutCall.result.isError, false);
  assert.equal(checkoutCall.result.structuredContent.checkout.checkoutUrl, "https://checkout.stripe.com/c/pay/cs_test_mcp_invoice_final");
  assert.equal(checkoutCall.result.structuredContent.checkout.checkoutSessionId, "cs_test_mcp_invoice_final");
  assert.equal(checkoutCall.result.structuredContent.checkout.checkoutStatus, "link_ready");
  assert.equal(checkoutCall.result.structuredContent.checkout.clientPayableOpenCents, 77175);
  assert.equal(checkoutStripeCalls[0].get("line_items[0][price_data][unit_amount]"), "77175");

  const paymentCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "studio_record_invoice_payment",
      arguments: {
        invoiceId: "invoice-1",
        paymentId: "payment-2",
        status: "paid",
        paymentMethod: "stripe",
        paidAmountCents: 75000,
        paidAt: "2026-08-19T14:00:00.000Z",
        externalPaymentId: "pi_mcp_final_123",
        notes: "Recorded by agent from Stripe receipt.",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });

  assert.equal(paymentCall.error.code, -32603);
  assert.match(paymentCall.error.message, /Payments require Tyler approval/);
  assert.deepEqual(database.prepare(`
    SELECT status, paid_amount_cents, external_payment_id
    FROM invoice_payments
    WHERE id = 'payment-2'
  `).get(), {
    status: "pending",
    paid_amount_cents: 0,
    external_payment_id: null,
  });

  const paymentUpdateCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 1305,
    method: "tools/call",
    params: {
      name: "studio_update_invoice_payment",
      arguments: {
        invoiceId: "invoice-1",
        paymentId: "payment-2",
        status: "paid",
        paymentMethod: "stripe",
        paidAmountCents: 74000,
        paidAt: "2026-08-19T14:30:00.000Z",
        externalPaymentId: "pi_mcp_final_123_corrected",
        notes: "Corrected by agent from Stripe balance transaction.",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });

  assert.equal(paymentUpdateCall.error.code, -32603);
  assert.match(paymentUpdateCall.error.message, /Payments require Tyler approval/);

  const reminderCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 1306,
    method: "tools/call",
    params: {
      name: "studio_log_invoice_reminder",
      arguments: {
        invoiceId: "invoice-1",
        paymentId: "payment-2",
        channel: "email",
        note: "Agent drafted a final balance follow-up for Tyler to send.",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });

  assert.equal(reminderCall.result.isError, false);
  assert.equal(reminderCall.result.structuredContent.reminder.invoiceId, "invoice-1");
  assert.equal(reminderCall.result.structuredContent.reminder.projectId, "project-1");
  assert.equal(reminderCall.result.structuredContent.reminder.paymentId, "payment-2");
  assert.equal(reminderCall.result.structuredContent.reminder.channel, "email");
  assert.equal(reminderCall.result.structuredContent.reminder.sourceType, "project_source");
  assert.equal(typeof reminderCall.result.structuredContent.reminder.activityLogId, "string");
  assert.deepEqual(database.prepare(`
    SELECT action, project_id, actor_type
    FROM activity_logs
    WHERE id = ?
  `).get(reminderCall.result.structuredContent.reminder.activityLogId), {
    action: "invoice.reminder_logged_by_agent",
    project_id: "project-1",
    actor_type: "agent",
  });

  const schedulerPaymentCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: {
      name: "studio_record_scheduler_booking_payment",
      arguments: {
        bookingId: "booking-1",
        status: "paid",
        paymentMethod: "stripe",
        paidAmountCents: 25000,
        paidAt: "2026-05-29T13:00:00.000Z",
        externalPaymentId: "pi_mcp_scheduler_123",
        notes: "Recorded by agent from scheduler checkout.",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });

  assert.equal(schedulerPaymentCall.error.code, -32603);
  assert.match(schedulerPaymentCall.error.message, /Payments require Tyler approval/);
  assert.deepEqual(database.prepare(`
    SELECT payment_status, paid_amount_cents, external_payment_id
    FROM scheduler_bookings
    WHERE id = 'booking-1'
  `).get(), {
    payment_status: "unpaid",
    paid_amount_cents: 0,
    external_payment_id: null,
  });

  const schedulerPaymentUpdateCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 1401,
    method: "tools/call",
    params: {
      name: "studio_update_scheduler_booking_payment",
      arguments: {
        bookingId: "booking-1",
        status: "paid",
        paymentMethod: "stripe",
        paidAmountCents: 24000,
        paidAt: "2026-05-29T13:30:00.000Z",
        externalPaymentId: "pi_mcp_scheduler_123_corrected",
        notes: "Corrected by agent from scheduler checkout settlement.",
      },
    },
  });

  assert.equal(schedulerPaymentUpdateCall.error.code, -32603);
  assert.match(schedulerPaymentUpdateCall.error.message, /Payments require Tyler approval/);

  const selectedAddOnId = database.prepare(`
    SELECT id
    FROM proposal_line_items
    WHERE proposal_id = ? AND name = 'Rehearsal dinner coverage'
  `).pluck().get(proposalCall.result.structuredContent.proposal.proposalId) as string;

  database.prepare(`
    UPDATE proposals
    SET
      status = 'accepted',
      contract_status = 'signed',
      accepted_at = ?,
      signed_at = ?,
      signer_name = 'Alex Taylor',
      signer_email = 'alex@example.com',
      signature_ip = '203.0.113.20',
      signature_user_agent = 'Studio MCP Context QA',
      signature_consent_version = 'proposal-signature-v1',
      selected_optional_line_item_ids_json = ?
    WHERE id = ?
  `).run(now, now, JSON.stringify([selectedAddOnId]), proposalCall.result.structuredContent.proposal.proposalId);

  const contextCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "studio_get_project_context",
      arguments: { projectId: "project-1" },
    },
  });

  assert.equal(contextCall.result.isError, false);
  assert.deepEqual(contextCall.result.structuredContent.projectContext.project, {
    id: "project-1",
    name: "Alex Wedding",
    type: "wedding",
    stage: "inquiry",
    status: "active",
    eventDate: null,
    venueName: null,
    venueAddress: null,
    city: null,
    state: null,
    budgetCents: null,
    notes: null,
  });
  assert.deepEqual(contextCall.result.structuredContent.projectContext.clients, [
    {
      id: "client-1",
      firstName: "Alex",
      lastName: "Taylor",
      email: "alex@example.com",
      phone: "555-0100",
      preferredName: null,
      instagramHandle: null,
      communicationPreference: null,
      referralSource: null,
      role: "primary",
      isPrimaryContact: true,
    },
    {
      id: "client-2",
      firstName: "Jordan",
      lastName: "Taylor",
      email: "jordan@example.com",
      phone: "555-0101",
      preferredName: null,
      instagramHandle: null,
      communicationPreference: null,
      referralSource: null,
      role: "partner",
      isPrimaryContact: false,
    },
  ]);
  assert.deepEqual(contextCall.result.structuredContent.projectContext.sources.map((source: {
    id: string;
    kind: string;
    title: string;
    sourceType: string | null;
    sourceId: string | null;
  }) => ({
    id: source.id,
    kind: source.kind,
    title: source.title,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
  })), [
    {
      id: agentQuestionnaireSource.id,
      kind: "questionnaire_response",
      title: "Questionnaire: Timeline Questionnaire",
      sourceType: "questionnaire_response",
      sourceId: questionnaireResponseCall.result.structuredContent.questionnaireResponse.id,
    },
    {
      id: workflowTaskResultCall.result.structuredContent.projectSource.id,
      kind: "workflow_draft",
      title: "Proposal and retainer task brief",
      sourceType: "project_workflow_step",
      sourceId: workflowQueueCall.result.structuredContent.workflowSteps.find((step: { stepKey: string }) => step.stepKey === "proposal-retainer-package").id,
    },
    {
      id: sourceCall.result.structuredContent.projectSource.id,
      kind: "discovery_call",
      title: "Discovery call notes - final cleaned source",
      sourceType: "call_transcript",
      sourceId: "call-1",
    },
  ]);
  assert.equal(contextCall.result.structuredContent.projectContext.events[0].title, "Wedding Day");
  assert.deepEqual(contextCall.result.structuredContent.projectContext.communications.map((communication: {
    subject: string | null;
    status: string;
    recipientEmail: string | null;
    sourceType: string | null;
    sourceId: string | null;
  }) => ({
    subject: communication.subject,
    status: communication.status,
    recipientEmail: communication.recipientEmail,
    sourceType: communication.sourceType,
    sourceId: communication.sourceId,
  })), [
    {
      subject: "Proposal next steps",
      status: "sent",
      recipientEmail: "alex@example.com",
      sourceType: "project_source",
      sourceId: sourceCall.result.structuredContent.projectSource.id,
    },
  ]);
  const contextQuestionnaireResponses = contextCall.result.structuredContent.projectContext.questionnaireResponses;
  const existingQuestionnaireResponse = contextQuestionnaireResponses.find((response: { id: string }) => response.id === "response-1");
  assert.deepEqual(existingQuestionnaireResponse, {
    id: "response-1",
    questionnaireId: "questionnaire-1",
    questionnaireTitle: "Timeline Questionnaire",
    clientId: "client-1",
    respondentName: "Alex Taylor",
    respondentEmail: "alex@example.com",
    status: "submitted",
    submittedAt: "2026-05-30T12:00:00.000Z",
    updatedAt: questionnaireResponseCall.result.structuredContent.questionnaireResponse.updatedAt,
    sourceType: "questionnaire_response",
    sourceId: "response-1",
    answers: [
      {
        questionId: "question-timeline-notes",
        title: "Timeline notes",
        type: "paragraph",
        required: true,
        value: "First look, family formals, and ceremony emotion matter most.",
        formattedValue: "First look, family formals, and ceremony emotion matter most.",
      },
      {
        questionId: "question-family-priorities",
        title: "Family priorities",
        type: "paragraph",
        required: false,
        value: "Keep grandparents comfortable and photographed early.",
        formattedValue: "Keep grandparents comfortable and photographed early.",
      },
    ],
  });
  assert.equal(
    contextQuestionnaireResponses.filter((response: { id: string }) => (
      response.id === questionnaireResponseCall.result.structuredContent.questionnaireResponse.id
    )).length,
    1,
  );
  assert.deepEqual(contextCall.result.structuredContent.projectContext.schedulerBookings, [
    {
      id: "booking-1",
      meetingTypeId: "meeting-1",
      meetingTypeName: "Paid Consultation",
      attendeeName: "Alex Taylor",
      attendeeEmail: "alex@example.com",
      startAt: "2026-06-01T14:00:00.000Z",
      endAt: "2026-06-01T14:45:00.000Z",
      status: "confirmed",
      paymentStatus: "unpaid",
      paidAmountCents: 0,
      clientFeeCents: 0,
      processingFeeCents: 0,
      grossCollectedCents: 0,
      netDepositCents: 0,
      paymentMethod: null,
      paidAt: null,
      externalPaymentId: null,
      paymentLink: null,
      paymentNotes: null,
      paymentSourceType: null,
      paymentSourceId: null,
      inviteeAnswers: [
        {
          questionId: "coverage_priorities",
          label: "What should we prioritize?",
          type: "textarea",
          value: "Family, ceremony emotion, and calm portraits.",
          formattedValue: "Family, ceremony emotion, and calm portraits.",
        },
        {
          questionId: "must_have_events",
          label: "Must-have events",
          type: "checkbox",
          value: ["First look", "Family formals"],
          formattedValue: "First look\nFamily formals",
        },
      ],
    },
  ]);
  assert.equal(contextCall.result.structuredContent.projectContext.timelineItems[0].title, "Corrected getting ready");
  assert.deepEqual(contextCall.result.structuredContent.projectContext.locations.map((location: {
    name: string;
    sourceType: string | null;
    sourceId: string | null;
  }) => ({
    name: location.name,
    sourceType: location.sourceType,
    sourceId: location.sourceId,
  })), [
    {
      name: "Garden portrait path west",
      sourceType: "project_source",
      sourceId: sourceCall.result.structuredContent.projectSource.id,
    },
  ]);
  const contextProposal = contextCall.result.structuredContent.projectContext.proposals.find((proposal: { title: string }) => proposal.title === "Discovery Call Proposal Revised");
  assert.ok(contextProposal);
  assert.equal(contextProposal.title, "Discovery Call Proposal Revised");
  assert.equal(contextProposal.sourceType, "project_source");
  assert.equal(contextProposal.sourceId, sourceCall.result.structuredContent.projectSource.id);
  assert.deepEqual(contextProposal.lineItems.map((item: {
    name: string;
    description: string | null;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    isOptional: boolean;
    sortOrder: number;
  }) => ({
    name: item.name,
    description: item.description,
    quantity: item.quantity,
    unitPriceCents: item.unitPriceCents,
    totalCents: item.totalCents,
    isOptional: item.isOptional,
    sortOrder: item.sortOrder,
  })), [
    {
      name: "Wedding photography coverage",
      description: null,
      quantity: 1,
      unitPriceCents: 950000,
      totalCents: 950000,
      isOptional: false,
      sortOrder: 0,
    },
    {
      name: "Rehearsal dinner coverage",
      description: null,
      quantity: 1,
      unitPriceCents: 125000,
      totalCents: 125000,
      isOptional: false,
      sortOrder: 1,
    },
  ]);
  assert.deepEqual(contextProposal.signatureEvidence, {
    signedAt: now,
    signerName: "Alex Taylor",
    signerEmail: "alex@example.com",
    signatureIp: "203.0.113.20",
    signatureUserAgent: "Studio MCP Context QA",
    signatureConsentVersion: "proposal-signature-v1",
    selectedOptionalLineItemIds: [selectedAddOnId],
  });
  assert.deepEqual(contextProposal.selectedOptionalLineItems, [
    {
      id: selectedAddOnId,
      name: "Rehearsal dinner coverage",
      description: null,
      quantity: 1,
      unitPriceCents: 125000,
      totalCents: 125000,
      isOptional: false,
      sortOrder: 1,
    },
  ]);
  const contextInvoice = contextCall.result.structuredContent.projectContext.invoices.find((invoice: { invoiceNumber: string }) => invoice.invoiceNumber === "INV-1");
  assert.equal(contextInvoice.clientPayableCents, 102930);
  assert.equal(contextInvoice.balanceCents, 77175);
  assert.equal(contextInvoice.clientPayableBalanceCents, 77175);
  assert.equal(contextInvoice.stripePaymentLink, "https://pay.stripe.com/test_context_invoice");
  assert.equal(contextInvoice.paymentNotes, "Pay by card or Zelle.");
  assert.deepEqual(contextInvoice.acceptedPaymentMethods, [
    {
      key: "stripe",
      enabled: true,
      passFees: true,
      displayName: "Credit card",
      instructions: "",
    },
    {
      key: "zelle",
      enabled: true,
      passFees: false,
      displayName: "Zelle",
      instructions: "hello@bythereeses.com",
    },
  ]);
  assert.equal(contextInvoice.zelleInfo, "hello@bythereeses.com");
  assert.equal(contextInvoice.venmoInfo, "@the-reeses");
  assert.equal(
    contextCall.result.structuredContent.projectContext.invoices.some((invoice: { invoiceNumber: string }) => invoice.invoiceNumber === "INV-MCP"),
    false,
    "agent invoice creation should remain blocked",
  );
  assert.equal(contextCall.result.structuredContent.projectContext.expenses[0].sourceType, "project_source");
  assert.equal(contextCall.result.structuredContent.projectContext.expenses[0].sourceId, sourceCall.result.structuredContent.projectSource.id);
  assert.deepEqual(contextInvoice.paymentSummary, {
    scheduledCents: 100000,
    paidCents: 25000,
    grossCollectedCents: 25755,
    clientFeeCents: 755,
    processingFeeCents: 755,
    netDepositCents: 25000,
    openCents: 75000,
  });
  assert.deepEqual(contextCall.result.structuredContent.projectContext.financialSummary, {
    scheduledCents: 125000,
    paidCents: 25000,
    grossCollectedCents: 25755,
    clientFeeCents: 755,
    processingFeeCents: 755,
    netDepositCents: 25000,
    openCents: 100000,
    clientPayableOpenCents: 102175,
    expenseCents: 13500,
    paidExpenseCents: 13500,
    openPayableCents: 0,
    taxDeductibleExpenseCents: 13500,
    nonDeductibleExpenseCents: 0,
    collectedProfitCents: 11500,
    projectedProfitCents: 111500,
    invoiceCount: 1,
    invoicePaymentCount: 2,
    schedulerPaymentCount: 1,
    expenseCount: 1,
  });
  assert.deepEqual(contextInvoice.payments.map((payment: {
    label: string;
    status: string;
    paidAmountCents: number;
    externalPaymentId: string | null;
    openCents: number;
    sourceType: string | null;
    sourceId: string | null;
  }) => ({
    label: payment.label,
    status: payment.status,
    paidAmountCents: payment.paidAmountCents,
    externalPaymentId: payment.externalPaymentId,
    openCents: payment.openCents,
    sourceType: payment.sourceType,
    sourceId: payment.sourceId,
  })), [
    {
      label: "Retainer",
      status: "paid",
      paidAmountCents: 25000,
      externalPaymentId: "pi_context_123",
      openCents: 0,
      sourceType: null,
      sourceId: null,
    },
    {
      label: "Final payment",
      status: "pending",
      paidAmountCents: 0,
      externalPaymentId: null,
      openCents: 75000,
      sourceType: null,
      sourceId: null,
    },
  ]);

  const financeReportCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 15,
    method: "tools/call",
    params: {
      name: "studio_get_finance_report",
      arguments: {
        paymentStatus: "paid",
        expenseStatus: "paid",
        asOfDate: "2026-09-20",
      },
    },
  });

  assert.equal(financeReportCall.result.isError, false);
  assert.equal(financeReportCall.result.structuredContent.financeReport.period.asOfDate, "2026-09-20");
  assert.equal(financeReportCall.result.structuredContent.financeReport.paymentLedger.totals.paidCents, 25000);
  assert.deepEqual(financeReportCall.result.structuredContent.financeReport.paymentLedger.aging.buckets.find((bucket: { bucket: string }) => bucket.bucket === "current"), {
    bucket: "current",
    label: "Current",
    openCents: 0,
    count: 0,
  });
  assert.equal(financeReportCall.result.structuredContent.financeReport.bookkeeping.totals.expenseCents, 13500);
  assert.deepEqual(financeReportCall.result.structuredContent.financeReport.projectFinancials, [
    {
      projectId: "project-1",
      projectName: "Alex Wedding",
      clientId: "client-1",
      clientName: "Alex Taylor",
      scheduledCents: 25000,
      paidCents: 25000,
      grossCollectedCents: 25755,
      clientFeeCents: 755,
      processingFeeCents: 755,
      netDepositCents: 25000,
      openCents: 0,
      clientPayableOpenCents: 0,
      expenseCents: 13500,
      paidExpenseCents: 13500,
      openPayableCents: 0,
      taxDeductibleExpenseCents: 13500,
      nonDeductibleExpenseCents: 0,
      paymentCount: 1,
      expenseCount: 1,
      href: "/projects/project-1",
      collectedProfitCents: 11500,
      projectedProfitCents: 11500,
    },
  ]);
  assert.equal(
    financeReportCall.result.structuredContent.financeReport.paymentLedger.rows.find((row: { paymentId: string }) => row.paymentId === "payment-2"),
    undefined,
    "paid-only finance report should not include pending invoice payments",
  );
  assert.equal(
    financeReportCall.result.structuredContent.financeReport.bookkeeping.expenses[0].sourceId,
    sourceCall.result.structuredContent.projectSource.id,
  );
  assert.deepEqual(
    financeReportCall.result.structuredContent.financeReport.paymentLedger.rows.find((row: { paymentId: string }) => row.paymentId === "payment-1").missingEvidence,
    ["source"],
  );
  assert.equal(
    financeReportCall.result.structuredContent.financeReport.paymentLedger.rows.find((row: { paymentId: string }) => row.paymentId === "payment-1").needsReconciliation,
    true,
  );
  assert.deepEqual(
    financeReportCall.result.structuredContent.financeReport.bookkeeping.expenses[0].missingEvidence,
    [],
  );
  assert.equal(
    financeReportCall.result.structuredContent.financeReport.bookkeeping.expenses[0].needsReconciliation,
    false,
  );

  const updateProjectCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 16,
    method: "tools/call",
    params: {
      name: "studio_update_project",
      arguments: {
        projectId: "project-1",
        stage: "planning",
        primaryClientId: "client-2",
        venueName: "Updated Garden House",
        city: "Rhinebeck",
        state: "NY",
        budgetCents: 950000,
        notes: "Updated by agent from canonical discovery source.",
        sourceType: "project_source",
        sourceId: sourceCall.result.structuredContent.projectSource.id,
      },
    },
  });

  assert.equal(updateProjectCall.result.isError, false);
  assert.equal(updateProjectCall.result.structuredContent.project.stage, "planning");
  assert.equal(updateProjectCall.result.structuredContent.project.venueName, "Updated Garden House");
  assert.equal(updateProjectCall.result.structuredContent.project.primaryClientId, "client-2");
  assert.equal(updateProjectCall.result.structuredContent.project.sourceId, sourceCall.result.structuredContent.projectSource.id);

  const missingTool = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "studio_missing_tool", arguments: {} },
  });
  assert.equal(missingTool.error.code, -32601);

  // -------------------------------------------------------------------
  // Phase 7a — agent gallery read (all statuses) + attach-only guard.
  // -------------------------------------------------------------------

  database.prepare(`
    INSERT INTO project_galleries (
      id, project_id, provider, title, url, status, passcode, delivered_at, expires_at, created_by, created_at, updated_at
    ) VALUES (
      'gallery-delivered', 'project-1', 'Pixieset', 'Wedding gallery', 'https://client.pixieset.com/wedding',
      'delivered', NULL, ?, NULL, 'admin', ?, ?
    )
  `).run(now, now, now);

  const attachGalleryCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 17,
    method: "tools/call",
    params: {
      name: "studio_attach_gallery_link",
      arguments: {
        projectId: "project-1",
        title: "Sneak peek gallery",
        url: "https://client.pixieset.com/sneak-peek",
        // Hostile/elevated fields — MUST be ignored (Active-Learning Log:
        // agent authority guard).
        status: "delivered",
        createdBy: "admin",
      },
    },
  });
  assert.equal(attachGalleryCall.result.isError, false);
  assert.equal(attachGalleryCall.result.structuredContent.gallery.status, "draft", "agent attach is forced to draft");
  assert.equal(attachGalleryCall.result.structuredContent.gallery.createdBy, "agent", "agent attach is forced to createdBy=agent");

  const deliveredGalleryCount = database.prepare(
    "SELECT COUNT(*) AS count FROM project_galleries WHERE status = 'delivered' AND created_by = 'agent'",
  ).get() as { count: number };
  assert.equal(deliveredGalleryCount.count, 0, "the agent tool must never mint a client-visible gallery");

  const galleryContextCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 18,
    method: "tools/call",
    params: {
      name: "studio_get_project_context",
      arguments: { projectId: "project-1" },
    },
  });
  assert.equal(galleryContextCall.result.isError, false);
  const contextGalleries = galleryContextCall.result.structuredContent.projectContext.galleries as Array<{
    id: string;
    status: string;
    createdBy: string;
  }>;
  assert.equal(contextGalleries.length, 2, "the always-on agent reader surfaces every status, not just delivered");
  assert.ok(contextGalleries.some((gallery) => gallery.status === "delivered"), "delivered gallery is visible to the agent");
  assert.ok(contextGalleries.some((gallery) => gallery.status === "draft" && gallery.createdBy === "agent"), "draft agent-authored gallery is visible to the agent");
  // Ordering is NOT lexicographic by status (archived < delivered < draft,
  // which would surface drafts oddly) — it is deliveredAt/createdAt recency.
  // The agent-attached draft has no deliveredAt (null) and was created after
  // the seeded delivered row, so `ORDER BY deliveredAt DESC, createdAt DESC`
  // (NULLs sort last in SQLite) places the delivered row first here.
  assert.equal(contextGalleries[0].status, "delivered", "delivered (non-null deliveredAt) sorts before the null-deliveredAt draft");

  // -------------------------------------------------------------------
  // Phase 7a — missing-table resilience (B1): the always-on reader MUST NOT
  // throw when project_galleries is absent (pre-0086 deploy race).
  // -------------------------------------------------------------------

  database.exec("DROP TABLE project_galleries;");
  const resilientContext = await getStudioProjectContext("project-1");
  assert.deepEqual(resilientContext.galleries, [], "a missing project_galleries table degrades to [] instead of throwing");

  console.log("studio mcp tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
