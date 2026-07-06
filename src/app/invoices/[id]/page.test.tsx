import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-invoice-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: InvoiceDetailPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-orphan', 'Needs Client Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', NULL, 'INV-DEEP-LINK', 'partially_paid', 100000, 30000,
      'client_pays', 290, 30, 2930,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-orphan', 'project-orphan', NULL, 'INV-ORPHAN', 'sent', 200000, 0,
      'studio_absorbs', 0, 0, 0,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, gross_collected_cents, net_deposit_cents, external_payment_id, notes,
      created_at, updated_at
    ) VALUES (
      'payment-paid', 'invoice-1', 'Retainer', 30000, '2026-06-01', 'paid',
      '2026-06-02T10:00:00.000Z', 'stripe', 30000, 30900, 30000, 'pi_123',
      'Stripe reconciliation evidence.', ?, ?
    ), (
      'payment-final', 'invoice-1', 'Final payment', 70000, '2026-08-19', 'pending',
      NULL, NULL, 0, 0, 0, NULL, 'Final balance note.', ?, ?
    )
  `).run(now, now, now, now);
  // Dedicated invoice for the Phase 9b refund-UI sub-test (kept OFF invoice-1 so its balance
  // assertions are unperturbed). A retainer (earliest) + a later non-retainer paid Stripe payment.
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-refund', 'project-1', NULL, 'INV-REFUND', 'paid', 40000, 40000,
      'studio_absorbs', 0, 0, 0,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, gross_collected_cents, net_deposit_cents, external_payment_id, notes,
      created_at, updated_at
    ) VALUES (
      'payment-refund-ret', 'invoice-refund', 'Retainer', 20000, '2026-05-01', 'paid',
      '2026-05-02T10:00:00.000Z', 'stripe', 20000, 20000, 20000, 'pi_refund_ret',
      NULL, ?, ?
    ), (
      'payment-refund-final', 'invoice-refund', 'Final payment', 20000, '2026-06-01', 'paid',
      '2026-06-02T10:00:00.000Z', 'stripe', 20000, 20000, 20000, 'pi_refund_final',
      NULL, ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO templates (id, type, name, trigger, subject, body, status, created_at, updated_at)
    VALUES (
      'template-reminder-1', 'reminder', 'Balance Due Follow-up',
      '3 days before due date', 'Balance reminder',
      'Hi {{client.name}}, your balance is {{invoice.balanceDue}}.', 'active', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO activity_logs (id, project_id, client_id, action, actor_type, actor_name, metadata, created_at)
    VALUES (
      'activity-sync', 'project-1', 'client-1', 'invoice.synced_to_accepted_proposal',
      'system', NULL, ?, '2026-05-31T12:30:00.000Z'
    )
  `).run(JSON.stringify({
    invoiceId: "invoice-1",
    proposalId: "proposal-1",
    previousTotalCents: 100000,
    totalCents: 120000,
    adjustedPaymentId: "payment-final",
    deltaCents: 20000,
  }));

  const markup = renderToStaticMarkup(await InvoiceDetailPage({
    params: Promise.resolve({ id: "invoice-1" }),
  }));
  const savedMarkup = renderToStaticMarkup(await InvoiceDetailPage({
    params: Promise.resolve({ id: "invoice-1" }),
    searchParams: Promise.resolve({ saved: "checkout" }),
  }));
  const { getInvoice } = await import("@/lib/sales");
  const invoiceData = await getInvoice("invoice-1");
  const orphanMarkup = renderToStaticMarkup(await InvoiceDetailPage({
    params: Promise.resolve({ id: "invoice-orphan" }),
  }));
  const orphanInvoiceData = await getInvoice("invoice-orphan");

  assert.match(markup, /id="payment-payment-paid"/);
  assert.match(markup, /id="payment-payment-final"/);
  assert.match(markup, /Stripe reconciliation evidence/);
  assert.match(markup, /Accepted proposal sync/);
  assert.match(markup, /name="templateId"/);
  assert.match(markup, /Balance Due Follow-up/);
  assert.match(markup, /3 days before due date/);
  assert.match(markup, /Invoice total changed from \$1,000 to \$1,200/);
  assert.match(markup, /Delta \$200/);
  assert.match(markup, /Create checkout/);
  assert.match(savedMarkup, /Stripe checkout link created and saved/);
  assert.equal(invoiceData?.balanceCents, 72030);
  assert.match(markup, /\$720/);
  assert.equal(orphanInvoiceData?.client, null);
  assert.equal(orphanInvoiceData?.balanceCents, 200000);
  assert.match(orphanMarkup, /INV-ORPHAN/);
  assert.match(orphanMarkup, /Needs Client Wedding · Needs primary client/);
  assert.match(orphanMarkup, /\$2,000/);

  // Phase 9b — admin refund UI (DARK behind REFUND_INITIATION_ENABLED). Flag OFF (default,
  // unset in this test's env): the refund control must not exist on the page AT ALL, not just
  // be visually hidden — no "Start refund" button, no retainer note, no refund section.
  assert.doesNotMatch(markup, /Start refund/, "flag off → no refund control rendered");
  assert.doesNotMatch(markup, /Retainers are non-refundable/, "flag off → no retainer note rendered");

  const savedFlag = process.env.REFUND_INITIATION_ENABLED;
  try {
    process.env.REFUND_INITIATION_ENABLED = "1";
    const refundsOnMarkup = renderToStaticMarkup(await InvoiceDetailPage({
      params: Promise.resolve({ id: "invoice-refund" }),
    }));
    // 'payment-refund-ret' is labeled "Retainer" AND is the earliest paid Stripe payment on the
    // invoice — the UI must show the disabled note (reusing the server's own predicate) and
    // must NOT offer a "Start refund" button for it.
    assert.match(refundsOnMarkup, /This is the initial retainer\. Retainers are non-refundable\./, "flag on → retainer row shows the non-refundable note");
    // 'payment-refund-final' is a paid, non-retainer, non-earliest Stripe payment — eligible, so
    // the control must offer "Start refund".
    assert.match(refundsOnMarkup, /Start refund/, "flag on → an eligible payment gets the refund control");
  } finally {
    if (savedFlag === undefined) delete process.env.REFUND_INITIATION_ENABLED;
    else process.env.REFUND_INITIATION_ENABLED = savedFlag;
  }

  console.log("invoice page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
