import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-portal-context-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.NEXT_PUBLIC_APP_URL = "https://studio.test";

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getPortalProjectContext } = await import("./portal");
  const { verifyQuestionnaireContext } = await import("./questionnaire-links");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, preferred_name, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', '555-0100', 'Alex', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (
      id, name, type, stage, status, event_date, venue_name, city, state, budget_cents, created_at, updated_at
    ) VALUES (
      'project-1', 'Portal Wedding', 'wedding', 'planning', 'active', '2026-09-19',
      'The Garden House', 'Hudson', 'NY', 900000, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_timeline_items (
      id, project_id, title, description, start_at, end_at, sort_order, source_type, source_id, created_by, created_at, updated_at
    ) VALUES (
      'timeline-1', 'project-1', 'Golden hour portraits', 'Portraits near the garden.',
      '2026-09-19T22:30:00.000Z', '2026-09-19T23:00:00.000Z', 10,
      'agent', 'task-1', 'agent', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_events (
      id, project_id, type, title, event_date, venue_name, venue_address, city, state, notes, created_at, updated_at
    ) VALUES (
      'event-1', 'project-1', 'welcome_party', 'Welcome party',
      '2026-09-18', 'River Room', '10 Water St', 'Hudson', 'NY',
      'Casual dinner after rehearsal.', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_locations (
      id, project_id, type, name, address, city, state, notes, created_at, updated_at
    ) VALUES (
      'location-1', 'project-1', 'getting_ready', 'Garden House Suite',
      '1 Garden Ln', 'Hudson', 'NY', 'Hair and makeup start here.', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, package_name, total_cents, scope_summary,
      contract_status, invoice_status, sent_at, accepted_at, signed_at,
      signer_name, signer_email, created_at, updated_at
    ) VALUES (
      'proposal-1', 'project-1', 'Portal Proposal', 'accepted', 'Heritage Day', 900000,
      'Wedding photography coverage.', 'signed', 'created',
      '2026-05-29T13:00:00.000Z', '2026-05-29T14:00:00.000Z', '2026-05-29T14:05:00.000Z',
      'Alex Taylor', 'alex@example.com', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents,
      payment_notes, accepted_payment_methods_json,
      card_fee_policy, card_fee_amount_cents, stripe_payment_link, zelle_info, venmo_info,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'proposal-1', 'PORTAL-INV', 'partially_paid', 900000, 300000,
      'Please include your invoice number with manual payments.',
      ?,
      'client_pays', 26130, 'https://pay.stripe.com/test_portal_invoice',
      'Zelle hello@bythereeses.com',
      '@bythereeses',
      ?, ?
    )
  `).run(JSON.stringify([
    { key: "stripe", displayName: "Credit card", passFees: true, instructions: "" },
    { key: "zelle", displayName: "Zelle", instructions: "Zelle hello@bythereeses.com", passFees: false },
    { key: "venmo", displayName: "Venmo", instructions: "@bythereeses", passFees: false },
  ]), now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, external_payment_id, stripe_checkout_url, stripe_checkout_status, notes, created_at, updated_at
    ) VALUES (
      'payment-1', 'invoice-1', 'Retainer', 300000, '2026-06-01', 'paid',
      '2026-06-02T10:00:00.000Z', 'stripe', 300000, 8730, 8730, 308730,
      300000, 'pi_portal_retainer', 'https://checkout.stripe.com/c/pay/cs_portal_retainer', 'paid', 'Paid retainer', ?, ?
    ), (
      'payment-2', 'invoice-1', 'Final payment', 600000, '2026-08-19', 'pending',
      NULL, NULL, 0, 0, 0, 0,
      0, NULL, 'https://checkout.stripe.com/c/pay/cs_portal_final', 'link_ready', NULL, ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, collect_payment, price_cents,
      stripe_payment_link, created_at, updated_at
    ) VALUES (
      'meeting-1', 'portal-paid-consult', 'Paid Planning Call', 60, 15, 1, 25000,
      'https://pay.stripe.com/test_portal_booking', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, client_id, attendee_name, attendee_email,
      start_at, end_at, status, source, payment_status, payment_method, paid_at,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, external_payment_id, payment_link, payment_notes, created_at, updated_at
    ) VALUES (
      'booking-1', 'meeting-1', 'project-1', 'client-1', 'Alex Taylor', 'alex@example.com',
      '2026-06-03T14:00:00.000Z', '2026-06-03T15:00:00.000Z', 'confirmed', 'booking_link',
      'paid', 'stripe', '2026-06-03T13:00:00.000Z',
      25000, 755, 755, 25755,
      25000, 'pi_portal_booking', 'https://pay.stripe.com/test_portal_booking', 'Paid call', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaires (id, title, description, status, created_at, updated_at)
    VALUES ('questionnaire-1', 'Timeline Questionnaire', 'Planning form', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaire_responses (
      id, questionnaire_id, project_id, client_id, respondent_name, respondent_email,
      submitted_at, answers_json, created_at, updated_at
    ) VALUES (
      'response-1', 'questionnaire-1', 'project-1', 'client-1', 'Alex Taylor', 'alex@example.com',
      '2026-05-30T15:00:00.000Z', ?, ?, ?
    )
  `).run(JSON.stringify([{ title: "Ceremony time", value: "4:00 PM" }]), now, now);

  const context = await getPortalProjectContext("project-1", "client-1");
  assert.equal(context?.project.name, "Portal Wedding");
  assert.equal(context?.primaryClient?.email, "alex@example.com");
  assert.deepEqual(context?.events.map((event) => ({
    title: event.title,
    type: event.type,
    eventDate: event.eventDate,
    venueName: event.venueName,
    location: [event.venueAddress, event.city, event.state].filter(Boolean).join(", "),
    notes: event.notes,
  })), [{
    title: "Welcome party",
    type: "welcome_party",
    eventDate: "2026-09-18",
    venueName: "River Room",
    location: "10 Water St, Hudson, NY",
    notes: "Casual dinner after rehearsal.",
  }]);
  assert.deepEqual(context?.locations.map((location) => ({
    name: location.name,
    type: location.type,
    location: [location.address, location.city, location.state].filter(Boolean).join(", "),
    notes: location.notes,
  })), [{
    name: "Garden House Suite",
    type: "getting_ready",
    location: "1 Garden Ln, Hudson, NY",
    notes: "Hair and makeup start here.",
  }]);
  assert.equal(context?.timelineItems[0].title, "Golden hour portraits");
  assert.deepEqual(context?.proposals.map((proposal) => ({
    title: proposal.title,
    status: proposal.status,
    contractStatus: proposal.contractStatus,
    signedAt: proposal.signedAt,
    totalCents: proposal.totalCents,
    proposalUrlPath: new URL(proposal.proposalUrl).pathname,
  })), [{
    title: "Portal Proposal",
    status: "accepted",
    contractStatus: "signed",
    signedAt: "2026-05-29T14:05:00.000Z",
    totalCents: 900000,
    proposalUrlPath: "/portal/proposals/proposal-1",
  }]);
  assert.deepEqual(context?.invoices.map((invoice) => ({
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    totalCents: invoice.totalCents,
    amountPaidCents: invoice.amountPaidCents,
    balanceCents: invoice.balanceCents,
    clientPayableBalanceCents: invoice.clientPayableBalanceCents,
    clientPayableCents: invoice.clientPayableCents,
    serviceBalanceCents: invoice.serviceBalanceCents,
    remainingClientFeeCents: invoice.remainingClientFeeCents,
    paymentNotes: invoice.paymentNotes,
    paymentOptions: invoice.paymentOptions,
    stripePaymentLink: invoice.stripePaymentLink,
    paymentCount: invoice.payments.length,
    openCents: invoice.payments[1].openCents,
    clientPayableOpenCents: invoice.payments[1].clientPayableOpenCents,
    stripeCheckoutUrl: invoice.payments[1].stripeCheckoutUrl,
    stripeCheckoutStatus: invoice.payments[1].stripeCheckoutStatus,
  })), [{
    invoiceNumber: "PORTAL-INV",
    status: "partially_paid",
    totalCents: 900000,
    amountPaidCents: 300000,
    balanceCents: 617400,
    clientPayableBalanceCents: 617400,
    clientPayableCents: 926130,
    serviceBalanceCents: 600000,
    remainingClientFeeCents: 17400,
    paymentNotes: "Please include your invoice number with manual payments.",
    paymentOptions: [
      { key: "stripe", displayName: "Credit card", instructions: "https://pay.stripe.com/test_portal_invoice", passFees: true },
      { key: "zelle", displayName: "Zelle", instructions: "Zelle hello@bythereeses.com", passFees: false },
      { key: "venmo", displayName: "Venmo", instructions: "@bythereeses", passFees: false },
    ],
    stripePaymentLink: "https://pay.stripe.com/test_portal_invoice",
    paymentCount: 2,
    openCents: 600000,
    clientPayableOpenCents: 617400,
    stripeCheckoutUrl: "https://checkout.stripe.com/c/pay/cs_portal_final",
    stripeCheckoutStatus: "link_ready",
  }]);
  assert.deepEqual(context?.schedulerBookings.map((booking) => ({
    meetingTypeName: booking.meetingTypeName,
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    paidAmountCents: booking.paidAmountCents,
    paymentLink: booking.paymentLink,
    manageUrlPath: new URL(booking.manageUrl).pathname,
    rescheduleUrlPath: new URL(booking.rescheduleUrl).pathname,
    rescheduleTokenPresent: Boolean(new URL(booking.rescheduleUrl).searchParams.get("reschedule")),
  })), [{
    meetingTypeName: "Paid Planning Call",
    status: "confirmed",
    paymentStatus: "paid",
    paidAmountCents: 25000,
    paymentLink: "https://pay.stripe.com/test_portal_booking",
    manageUrlPath: "/book/portal-paid-consult/manage",
    rescheduleUrlPath: "/book/portal-paid-consult",
    rescheduleTokenPresent: true,
  }]);
  assert.deepEqual(context?.questionnaireResponses.map((response) => ({
    questionnaireTitle: response.questionnaireTitle,
    status: response.status,
    respondentEmail: response.respondentEmail,
    questionnaireUrlPath: new URL(response.questionnaireUrl).pathname,
    questionnaireUrlProjectId: verifyQuestionnaireContext(new URL(response.questionnaireUrl).searchParams.get("context"), response.questionnaireId)?.projectId,
    questionnaireUrlClientId: verifyQuestionnaireContext(new URL(response.questionnaireUrl).searchParams.get("context"), response.questionnaireId)?.clientId,
  })), [{
    questionnaireTitle: "Timeline Questionnaire",
    status: "submitted",
    respondentEmail: "alex@example.com",
    questionnaireUrlPath: "/questionnaires/questionnaire-1/preview",
    questionnaireUrlProjectId: "project-1",
    questionnaireUrlClientId: "client-1",
  }]);
  assert.deepEqual(context?.moneySummary, {
    invoiceTotalCents: 900000,
    invoicePaidCents: 300000,
    invoiceOpenCents: 617400,
    schedulerPaidCents: 25000,
  });

  console.log("portal context tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
