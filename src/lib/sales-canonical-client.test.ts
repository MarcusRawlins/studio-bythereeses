import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-sales-canonical-client-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getInvoice, getPaymentLedgerReport, getProposal, listInvoices, listProposals } = await import("./sales");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-primary', 'Primary', 'Client', 'primary@example.com', ?, ?),
      ('client-secondary', 'Second', 'Client', 'second@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Canonical Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-secondary', 'project-1', 'client-secondary', 'partner', 0, ?),
      ('participant-primary', 'project-1', 'client-primary', 'primary', 1, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposals (id, project_id, title, status, total_cents, contract_status, invoice_status, created_at, updated_at)
    VALUES ('proposal-1', 'project-1', 'Canonical Proposal', 'sent', 500000, 'ready', 'created', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'proposal-1', 'INV-CANON', 'partially_paid', 500000, 100000,
      'client_pays', 290, 30, 14530,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-1', 'invoice-1', 'Retainer', 100000, '2026-06-01', 'paid',
      '2026-06-02T10:00:00.000Z', 'stripe',
      100000, 2930, 2930, 102930,
      100000, ?, ?
    )
  `).run(now, now);

  const proposalRows = await listProposals();
  assert.equal(proposalRows.length, 1);
  assert.equal(proposalRows[0].client.id, "client-primary");

  const proposal = await getProposal("proposal-1");
  assert.equal(proposal?.client.id, "client-primary");

  const invoiceRows = await listInvoices();
  assert.equal(invoiceRows.length, 1);
  assert.equal(invoiceRows[0].client.id, "client-primary");
  assert.equal(invoiceRows[0].clientPayableBalanceCents, 411600);

  const invoice = await getInvoice("invoice-1");
  assert.equal(invoice?.client.id, "client-primary");

  const paymentLedger = await getPaymentLedgerReport({ status: "all" });
  assert.equal(paymentLedger.rows.length, 1);
  assert.equal(paymentLedger.rows[0].client.id, "client-primary");
  assert.equal(paymentLedger.rows[0].clientName, "Primary Client");
  assert.equal(paymentLedger.totals.scheduledCents, 100000);

  console.log("sales canonical client tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
