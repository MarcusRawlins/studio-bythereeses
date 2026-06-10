import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-client-context-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getClientWithProjects } = await import("./crm");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (
      id, first_name, last_name, email, phone,
      instagram_handle, communication_preference, referral_source,
      created_at, updated_at
    )
    VALUES (
      'client-1', 'Alex', 'Taylor', 'alex@example.com', '555-0100',
      '@alexreese', 'Email for contracts; text for wedding week logistics.', 'Planner referral',
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-other', 'Other', 'Client', 'other@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
    VALUES
      ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', '2026-09-19', ?, ?),
      ('project-other', 'Other Wedding', 'wedding', 'planning', 'active', '2026-10-10', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (id, slug, name, duration_minutes, buffer_minutes, created_at, updated_at)
    VALUES ('meeting-1', 'discovery', 'Discovery Call', 45, 15, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, client_id, attendee_name, attendee_email,
      start_at, end_at, status, source, created_at, updated_at
    ) VALUES (
      'booking-1', 'meeting-1', 'project-1', 'client-1', 'Alex Taylor', 'alex@example.com',
      '2026-06-01T14:00:00.000Z', '2026-06-01T14:45:00.000Z', 'confirmed', 'booking_link', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposals (id, project_id, title, status, total_cents, sent_at, created_at, updated_at)
    VALUES
      ('proposal-1', 'project-1', 'Alex Proposal', 'sent', 900000, '2026-05-30T12:00:00.000Z', ?, ?),
      ('proposal-other', 'project-other', 'Other Proposal', 'sent', 100000, '2026-05-30T12:00:00.000Z', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      due_date, created_at, updated_at
    )
    VALUES (
      'invoice-1', 'project-1', 'proposal-1', 'INV-ALEX', 'sent', 900000, 300000,
      'client_pays', 290, 30, 26130,
      '2026-06-15', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents,
      created_at, updated_at
    ) VALUES (
      'payment-paid', 'invoice-1', 'Retainer', 300000, '2026-06-15', 'paid',
      '2026-06-15T14:00:00.000Z', 'stripe',
      300000, 8730, 8730, 308730, 300000,
      ?, ?
    ), (
      'payment-final', 'invoice-1', 'Final balance', 600000, '2026-08-19', 'pending',
      NULL, NULL,
      0, 0, 0, 0, 0,
      ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO questionnaires (id, title, status, created_at, updated_at)
    VALUES ('questionnaire-1', 'Timeline Questionnaire', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaire_responses (
      id, questionnaire_id, project_id, client_id, respondent_name, respondent_email,
      submitted_at, answers_json, created_at, updated_at
    ) VALUES (
      'response-1', 'questionnaire-1', 'project-1', 'client-1', 'Alex Taylor', 'alex@example.com',
      NULL, '[]', '2026-05-29T12:00:00.000Z', '2026-05-30T12:00:00.000Z'
    )
  `).run();
  database.prepare(`
    INSERT INTO activity_logs (id, project_id, client_id, action, actor_type, actor_name, metadata, created_at)
    VALUES
      ('activity-client', NULL, 'client-1', 'client.updated_by_agent', 'agent', 'The Reeses Studio Agent', '{}', '2026-05-31T12:00:00.000Z'),
      ('activity-project', 'project-1', NULL, 'proposal.viewed', 'client', 'Alex Taylor', '{}', '2026-05-30T12:00:00.000Z')
  `).run();

  const context = await getClientWithProjects("client-1");
  assert.ok(context);
  assert.equal(context.client.email, "alex@example.com");
  assert.equal(context.client.instagramHandle, "@alexreese");
  assert.equal(context.client.communicationPreference, "Email for contracts; text for wedding week logistics.");
  assert.equal(context.client.referralSource, "Planner referral");
  assert.deepEqual(context.projects.map((row) => row.project.id), ["project-1"]);
  assert.deepEqual(context.bookings.map((booking) => ({
    id: booking.id,
    meetingName: booking.meetingName,
    projectName: booking.projectName,
  })), [{
    id: "booking-1",
    meetingName: "Discovery Call",
    projectName: "Alex Wedding",
  }]);
  assert.deepEqual(context.proposals.map((proposal) => ({
    id: proposal.id,
    title: proposal.title,
    projectName: proposal.projectName,
  })), [{
    id: "proposal-1",
    title: "Alex Proposal",
    projectName: "Alex Wedding",
  }]);
  assert.deepEqual(context.invoices.map((invoice) => ({
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    projectName: invoice.projectName,
    openBalanceCents: invoice.openBalanceCents,
    nextPaymentDueDate: invoice.nextPaymentDueDate,
  })), [{
    id: "invoice-1",
    invoiceNumber: "INV-ALEX",
    projectName: "Alex Wedding",
    openBalanceCents: 617400,
    nextPaymentDueDate: "2026-08-19",
  }]);
  assert.deepEqual(context.questionnaireResponses.map((response) => ({
    id: response.id,
    questionnaireTitle: response.questionnaireTitle,
    projectName: response.projectName,
    status: response.status,
  })), [{
    id: "response-1",
    questionnaireTitle: "Timeline Questionnaire",
    projectName: "Alex Wedding",
    status: "draft",
  }]);
  assert.deepEqual(context.activity.map((entry) => entry.action), [
    "client.updated_by_agent",
    "proposal.viewed",
  ]);

  console.log("client context tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
