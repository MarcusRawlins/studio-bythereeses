import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-proposal-signature-audit-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { acceptProposalByToken, createProposalLinkFromForm } = await import("./sales");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Signature Audit Wedding', 'wedding', 'proposal_sent', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Avery', 'Stone', 'avery@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, package_name, total_cents, contract_status,
      contract_title, contract_body, invoice_status, created_at, updated_at
    ) VALUES (
      'proposal-1', 'project-1', 'Signature Audit Proposal', 'ready', 'Heritage Day',
      850000, 'ready', 'Photography Agreement', 'Agreement body.', 'created', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposal_line_items (
      id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at
    ) VALUES
      ('included-1', 'proposal-1', 'Wedding coverage', 1, 850000, 0, 0, ?, ?),
      ('optional-1', 'proposal-1', 'Engagement session', 1, 120000, 1, 1, ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'proposal-1', 'INV-SIGNATURE', 'sent', 850000, 0,
      'client_pays', 290, 30, 24680, ?, ?
    ), (
      'invoice-paid', 'project-1', 'proposal-1', 'INV-PAID-SIGNATURE', 'partially_paid', 850000, 255000,
      'client_pays', 290, 30, 24680, ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at
    ) VALUES
      ('payment-retainer', 'invoice-1', 'Retainer', 255000, '2026-06-01', 'pending', ?, ?),
      ('payment-final', 'invoice-1', 'Final payment', 595000, '2026-08-01', 'pending', ?, ?),
      ('payment-paid-retainer', 'invoice-paid', 'Retainer', 255000, '2026-06-01', 'paid', ?, ?),
      ('payment-paid-final', 'invoice-paid', 'Final payment', 595000, '2026-08-01', 'pending', ?, ?)
  `).run(now, now, now, now, now, now, now, now);

  const linkForm = new FormData();
  linkForm.set("proposalId", "proposal-1");
  linkForm.set("projectId", "project-1");
  linkForm.set("clientId", "client-1");
  linkForm.set("label", "Client proposal");
  const access = await createProposalLinkFromForm(linkForm);
  const token = access.url.split("/proposal/")[1];

  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, package_name, total_cents, contract_status,
      contract_title, contract_body, invoice_status, created_at, updated_at
    ) VALUES (
      'proposal-no-contract', 'project-1', 'No Contract Proposal', 'ready', 'Heritage Day',
      850000, 'ready', 'Photography Agreement', 'Agreement body before link.', 'created', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposal_line_items (
      id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at
    ) VALUES ('included-no-contract', 'proposal-no-contract', 'Wedding coverage', 1, 850000, 0, 0, ?, ?)
  `).run(now, now);
  const noContractLinkForm = new FormData();
  noContractLinkForm.set("proposalId", "proposal-no-contract");
  noContractLinkForm.set("projectId", "project-1");
  noContractLinkForm.set("clientId", "client-1");
  noContractLinkForm.set("label", "No contract client proposal");
  const noContractAccess = await createProposalLinkFromForm(noContractLinkForm);
  const noContractToken = noContractAccess.url.split("/proposal/")[1];
  database.prepare(`
    UPDATE proposals
    SET contract_body = NULL, updated_at = ?
    WHERE id = 'proposal-no-contract'
  `).run(now);

  assert.equal(await acceptProposalByToken(noContractToken, "203.0.113.11", {
    signerName: "Avery Stone",
    signerEmail: "avery@example.com",
    selectedOptionalLineItemIds: [],
    userAgent: "Mozilla/5.0 Direct Post",
    consentText: "I agree.",
    consentVersion: "proposal-signature-v1",
  }), null);
  assert.deepEqual(database.prepare(`
    SELECT status, contract_status, accepted_at, signed_at, signer_name
    FROM proposals
    WHERE id = 'proposal-no-contract'
  `).get(), {
    status: "sent",
    contract_status: "ready",
    accepted_at: null,
    signed_at: null,
    signer_name: null,
  });

  await acceptProposalByToken(token, "203.0.113.10", {
    signerName: "Avery Stone",
    signerEmail: "AVERY@example.com",
    selectedOptionalLineItemIds: ["optional-1"],
    userAgent: "Mozilla/5.0 Studio QA",
    consentText: "I agree that typing my name above signs the contract electronically and accepts this proposal package.",
    consentVersion: "proposal-signature-v1",
  });

  const proposal = database.prepare(`
    SELECT
      status,
      contract_status,
      total_cents,
      signer_name,
      signer_email,
      signature_ip,
      signature_user_agent,
      signature_consent_text,
      signature_consent_version,
      selected_optional_line_item_ids_json
    FROM proposals
    WHERE id = 'proposal-1'
  `).get();

  assert.deepEqual(proposal, {
    status: "accepted",
    contract_status: "signed",
    total_cents: 970000,
    signer_name: "Avery Stone",
    signer_email: "avery@example.com",
    signature_ip: "203.0.113.10",
    signature_user_agent: "Mozilla/5.0 Studio QA",
    signature_consent_text: "I agree that typing my name above signs the contract electronically and accepts this proposal package.",
    signature_consent_version: "proposal-signature-v1",
    selected_optional_line_item_ids_json: JSON.stringify(["optional-1"]),
  });

  assert.deepEqual(database.prepare(`
    SELECT total_cents, card_fee_amount_cents
    FROM invoices
    WHERE id = 'invoice-1'
  `).get(), {
    total_cents: 970000,
    card_fee_amount_cents: 28160,
  });

  assert.deepEqual(database.prepare(`
    SELECT label, amount_cents, status
    FROM invoice_payments
    WHERE invoice_id = 'invoice-1'
    ORDER BY created_at, label
  `).all(), [
    { label: "Final payment", amount_cents: 715000, status: "pending" },
    { label: "Retainer", amount_cents: 255000, status: "pending" },
  ]);

  assert.deepEqual(database.prepare(`
    SELECT total_cents, card_fee_amount_cents, amount_paid_cents
    FROM invoices
    WHERE id = 'invoice-paid'
  `).get(), {
    total_cents: 850000,
    card_fee_amount_cents: 24680,
    amount_paid_cents: 255000,
  });

  const signedActivity = database.prepare(`
    SELECT metadata
    FROM activity_logs
    WHERE action = 'proposal.signed'
  `).get() as { metadata: string };
  const metadata = JSON.parse(signedActivity.metadata);
  assert.equal(metadata.signatureIp, "203.0.113.10");
  assert.equal(metadata.signatureUserAgent, "Mozilla/5.0 Studio QA");
  assert.deepEqual(metadata.selectedOptionalLineItemIds, ["optional-1"]);

  const invoiceSyncActivity = database.prepare(`
    SELECT metadata
    FROM activity_logs
    WHERE action = 'invoice.synced_to_accepted_proposal'
  `).get() as { metadata: string };
  assert.deepEqual(JSON.parse(invoiceSyncActivity.metadata), {
    invoiceId: "invoice-1",
    proposalId: "proposal-1",
    previousTotalCents: 850000,
    totalCents: 970000,
    adjustedPaymentId: "payment-final",
    deltaCents: 120000,
  });

  assert.deepEqual(database.prepare(`
    SELECT type, title, event_date, calendar_sync_status
    FROM project_events
    WHERE project_id = 'project-1' AND type = 'engagement'
  `).all(), [{
    type: "engagement",
    title: "Engagement session",
    event_date: null,
    calendar_sync_status: "not_connected",
  }], "accepting an engagement package should create one unscheduled engagement placeholder");

  const engagementActivity = database.prepare(`
    SELECT metadata
    FROM activity_logs
    WHERE action = 'engagement.pending_added'
  `).get() as { metadata: string };
  assert.deepEqual(JSON.parse(engagementActivity.metadata), {
    proposalId: "proposal-1",
    eventId: database.prepare(`
      SELECT id
      FROM project_events
      WHERE project_id = 'project-1' AND type = 'engagement'
    `).pluck().get(),
  });

  await acceptProposalByToken(token, "198.51.100.22", {
    signerName: "Different Signer",
    signerEmail: "different@example.com",
    selectedOptionalLineItemIds: ["included-1"],
    userAgent: "Mozilla/5.0 Repeat Submit",
    consentText: "Repeat submit should not rewrite signed evidence.",
    consentVersion: "proposal-signature-v2",
  });

  assert.deepEqual(database.prepare(`
    SELECT
      status,
      contract_status,
      total_cents,
      signer_name,
      signer_email,
      signature_ip,
      signature_user_agent,
      signature_consent_version,
      selected_optional_line_item_ids_json
    FROM proposals
    WHERE id = 'proposal-1'
  `).get(), {
    status: "accepted",
    contract_status: "signed",
    total_cents: 970000,
    signer_name: "Avery Stone",
    signer_email: "avery@example.com",
    signature_ip: "203.0.113.10",
    signature_user_agent: "Mozilla/5.0 Studio QA",
    signature_consent_version: "proposal-signature-v1",
    selected_optional_line_item_ids_json: JSON.stringify(["optional-1"]),
  }, "repeat accepts should be idempotent and preserve signed evidence");
  assert.equal(database.prepare(`
    SELECT COUNT(*)
    FROM activity_logs
    WHERE action IN ('proposal.accepted', 'proposal.signed', 'invoice.synced_to_accepted_proposal')
  `).pluck().get(), 3, "repeat accepts should not duplicate acceptance, signature, or invoice sync activity");

  console.log("proposal signature audit tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
