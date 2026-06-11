import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-finance-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getProjectFinancialSummary } = await import("./project-finance");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', '2026-09-19', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-PROJECT', 'partially_paid', 100000, 30000,
      'client_pays', 290, 30, 2930,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-paid', 'invoice-1', 'Retainer', 30000, '2026-06-01', 'paid', '2026-06-02T10:00:00.000Z', 'stripe',
      30000, 900, 900, 30900, 30000, ?, ?
    ), (
      'payment-open', 'invoice-1', 'Final payment', 70000, '2026-08-19', 'pending', NULL, NULL,
      0, 0, 0, 0, 0, ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, collect_payment, price_cents,
      stripe_payment_link, created_at, updated_at
    ) VALUES (
      'meeting-1', 'paid-consult', 'Paid Consultation', 45, 15, 1, 25000,
      'https://pay.stripe.com/test_paid_consult', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, client_id, attendee_name, attendee_email,
      start_at, end_at, status, source, payment_status, payment_method, paid_at,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, created_at, updated_at
    ) VALUES (
      'booking-paid', 'meeting-1', 'project-1', 'client-1', 'Alex Taylor', 'alex@example.com',
      '2026-06-03T14:00:00.000Z', '2026-06-03T14:45:00.000Z', 'confirmed', 'booking_link',
      'paid', 'stripe', '2026-06-03T13:00:00.000Z',
      25000, 755, 755, 25755, 25000, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO vendors (id, name, normalized_name, created_at, updated_at)
    VALUES ('vendor-1', 'Album Lab', 'album lab', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO expenses (
      id, vendor_id, project_id, category, description, amount_cents, status, paid_at,
      payment_method, tax_deductible, created_at, updated_at
    ) VALUES (
      'expense-1', 'vendor-1', 'project-1', 'albums', 'Album proof',
      15000, 'paid', '2026-06-03', 'amex', 1, ?, ?
    ), (
      'expense-2', 'vendor-1', 'project-1', 'meals', 'Client lunch',
      5000, 'paid', '2026-06-04', 'amex', 0, ?, ?
    ), (
      'expense-unpaid', 'vendor-1', 'project-1', 'contractor', 'Second shooter balance',
      40000, 'unpaid', '2026-06-10', 'ach', 1, ?, ?
    )
  `).run(now, now, now, now, now, now);

  assert.deepEqual(await getProjectFinancialSummary("project-1"), {
    scheduledCents: 125000,
    paidCents: 55000,
    grossCollectedCents: 56655,
    clientFeeCents: 1655,
    processingFeeCents: 1655,
    netDepositCents: 55000,
    openCents: 70000,
    clientPayableOpenCents: 72030,
    expenseCents: 60000,
    paidExpenseCents: 20000,
    openPayableCents: 40000,
    taxDeductibleExpenseCents: 55000,
    nonDeductibleExpenseCents: 5000,
    collectedProfitCents: 35000,
    projectedProfitCents: 65000,
    invoiceCount: 1,
    invoicePaymentCount: 2,
    schedulerPaymentCount: 1,
    expenseCount: 3,
  });
  assert.equal(await getProjectFinancialSummary("missing-project"), null);

  console.log("project finance tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
