import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-payment-ledger-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { accountsReceivableAgingCsv, getPaymentLedgerReport, paymentLedgerCsv } = await import("./sales");
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
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, source_type, source_id, created_at, updated_at
    ) VALUES (
      'source-payment-1', 'project-1', 'payment_receipt', 'Invoice retainer receipt',
      'Stripe receipt for the invoice retainer.', 'stripe_payment_intent', 'pi_123', ?, ?
    ), (
      'source-booking-1', 'project-1', 'payment_receipt', 'Scheduler checkout receipt',
      'Stripe receipt for the paid consultation.', 'stripe_payment_intent', 'pi_booking_123', ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-LEDGER', 'partially_paid', 100000, 30000,
      'client_pays', 290, 30, 2930,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, external_payment_id, notes, source_type, source_id, created_at, updated_at
    ) VALUES (
      'payment-paid', 'invoice-1', 'Retainer', 30000, '2026-06-01', 'paid', '2026-06-02T10:00:00.000Z', 'stripe',
      30000, 900, 900, 30900,
      30000, 'pi_123', 'Stripe payment', 'project_source', 'source-payment-1', ?, ?
    ), (
      'payment-open', 'invoice-1', 'Final payment', 70000, '2026-08-19', 'pending', NULL, NULL,
      0, 0, 0, 0,
      0, NULL, NULL, NULL, NULL, ?, ?
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
      net_deposit_cents, external_payment_id, payment_link, payment_notes,
      payment_source_type, payment_source_id, created_at, updated_at
    ) VALUES (
      'booking-paid', 'meeting-1', 'project-1', 'client-1', 'Alex Taylor', 'alex@example.com',
      '2026-06-03T14:00:00.000Z', '2026-06-03T14:45:00.000Z', 'confirmed', 'booking_link',
      'paid', 'stripe', '2026-06-03T13:00:00.000Z',
      25000, 755, 755, 25755,
      25000, 'pi_booking_123', 'https://pay.stripe.com/test_paid_consult', 'Paid scheduler consultation',
      'project_source', 'source-booking-1', ?, ?
    )
  `).run(now, now);

  const report = await getPaymentLedgerReport({ status: "all" });

  assert.deepEqual(report.totals, {
    scheduledCents: 125000,
    paidCents: 55000,
    grossCollectedCents: 56655,
    clientFeeCents: 1655,
    processingFeeCents: 1655,
    netDepositCents: 55000,
    openCents: 70000,
    clientPayableOpenCents: 72030,
    refundedCents: 0,
    disputedOpenCents: 0,
    netCollectedCents: 56655,
  });
  assert.deepEqual(report.rows.map((row) => ({
    sourceType: row.sourceType,
    invoiceNumber: row.invoice.invoiceNumber,
    paymentLabel: row.payment.label,
    projectName: row.project.name,
    clientName: row.clientName,
    openCents: row.openCents,
    clientPayableOpenCents: row.clientPayableOpenCents,
    paymentSourceType: row.paymentSourceType,
    paymentSourceId: row.paymentSourceId,
  })), [
    {
      sourceType: "invoice",
      invoiceNumber: "INV-LEDGER",
      paymentLabel: "Retainer",
      projectName: "Alex Wedding",
      clientName: "Alex Taylor",
      openCents: 0,
      clientPayableOpenCents: 72030,
      paymentSourceType: "project_source",
      paymentSourceId: "source-payment-1",
    },
    {
      sourceType: "scheduler_booking",
      invoiceNumber: "BOOKING",
      paymentLabel: "Paid Consultation",
      projectName: "Alex Wedding",
      clientName: "Alex Taylor",
      openCents: 0,
      clientPayableOpenCents: 0,
      paymentSourceType: "project_source",
      paymentSourceId: "source-booking-1",
    },
    {
      sourceType: "invoice",
      invoiceNumber: "INV-LEDGER",
      paymentLabel: "Final payment",
      projectName: "Alex Wedding",
      clientName: "Alex Taylor",
      openCents: 70000,
      clientPayableOpenCents: 72030,
      paymentSourceType: null,
      paymentSourceId: null,
    },
  ]);

  const paidOnly = await getPaymentLedgerReport({ status: "paid" });
  assert.equal(paidOnly.rows.length, 2);
  assert.equal(paidOnly.rows[0].payment.id, "payment-paid");
  assert.equal(paidOnly.rows[1].sourceId, "booking-paid");

  const csv = paymentLedgerCsv(report.rows);
  assert.match(csv, /^Invoice,Project,Client,Payment,Due Date,Paid At,Status,Method,Scheduled,Paid,Gross Collected,Client Fee,Processor Fee,Net Deposit,Open,Client Payable Open,External Payment ID,Notes,Payment Source Type,Payment Source ID/m);
  assert.match(csv, /INV-LEDGER,Alex Wedding,Alex Taylor,Retainer,2026-06-01,2026-06-02T10:00:00.000Z,paid,stripe,300.00,300.00,309.00,9.00,9.00,300.00,0.00,720.30,pi_123,Stripe payment,project_source,source-payment-1/);
  assert.match(csv, /BOOKING,Alex Wedding,Alex Taylor,Paid Consultation,2026-06-03T14:00:00.000Z,2026-06-03T13:00:00.000Z,paid,stripe,250.00,250.00,257.55,7.55,7.55,250.00,0.00,0.00,pi_booking_123,Paid scheduler consultation,project_source,source-booking-1,scheduler_booking,booking-paid,\/scheduler\/bookings\/booking-paid#payment-booking-paid/);

  database.prepare("UPDATE invoices SET total_cents = 160000 WHERE id = 'invoice-1'").run();
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, gross_collected_cents, net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-current', 'invoice-1', 'Album balance', 10000, '2026-09-30', 'pending', NULL, NULL,
      0, 0, 0, ?, ?
    ), (
      'payment-1-30', 'invoice-1', 'Second payment', 20000, '2026-09-01', 'pending', NULL, NULL,
      0, 0, 0, ?, ?
    ), (
      'payment-90-plus', 'invoice-1', 'Past balance', 30000, '2026-05-01', 'pending', NULL, NULL,
      0, 0, 0, ?, ?
    )
  `).run(now, now, now, now, now, now);

  const agingReport = await getPaymentLedgerReport({ status: "all", asOfDate: "2026-09-20" });
  assert.deepEqual(agingReport.aging.buckets, [
    { bucket: "current", label: "Current", openCents: 10000, count: 1 },
    { bucket: "1_30", label: "1-30", openCents: 20000, count: 1 },
    { bucket: "31_60", label: "31-60", openCents: 70000, count: 1 },
    { bucket: "61_90", label: "61-90", openCents: 0, count: 0 },
    { bucket: "90_plus", label: "90+", openCents: 30000, count: 1 },
  ]);
  assert.deepEqual(agingReport.aging.rows.map((row) => ({
    sourceId: row.sourceId,
    invoiceNumber: row.invoiceNumber,
    paymentLabel: row.paymentLabel,
    clientName: row.clientName,
    dueDate: row.dueDate,
    daysPastDue: row.daysPastDue,
    bucket: row.bucket,
    openCents: row.openCents,
  })), [
    {
      sourceId: "payment-90-plus",
      invoiceNumber: "INV-LEDGER",
      paymentLabel: "Past balance",
      clientName: "Alex Taylor",
      dueDate: "2026-05-01",
      daysPastDue: 142,
      bucket: "90_plus",
      openCents: 30000,
    },
    {
      sourceId: "payment-open",
      invoiceNumber: "INV-LEDGER",
      paymentLabel: "Final payment",
      clientName: "Alex Taylor",
      dueDate: "2026-08-19",
      daysPastDue: 32,
      bucket: "31_60",
      openCents: 70000,
    },
    {
      sourceId: "payment-1-30",
      invoiceNumber: "INV-LEDGER",
      paymentLabel: "Second payment",
      clientName: "Alex Taylor",
      dueDate: "2026-09-01",
      daysPastDue: 19,
      bucket: "1_30",
      openCents: 20000,
    },
    {
      sourceId: "payment-current",
      invoiceNumber: "INV-LEDGER",
      paymentLabel: "Album balance",
      clientName: "Alex Taylor",
      dueDate: "2026-09-30",
      daysPastDue: 0,
      bucket: "current",
      openCents: 10000,
    },
  ]);
  const agingCsv = accountsReceivableAgingCsv(agingReport.aging);
  assert.match(agingCsv, /^As Of,Bucket,Invoice,Project,Client,Payment,Due Date,Days Past Due,Open,Status,Source Type,Source ID,Link/m);
  assert.match(agingCsv, /2026-09-20,90\+,INV-LEDGER,Alex Wedding,Alex Taylor,Past balance,2026-05-01,142,300.00,pending,invoice,payment-90-plus,\/invoices\/invoice-1/);
  assert.match(agingCsv, /2026-09-20,31-60,INV-LEDGER,Alex Wedding,Alex Taylor,Final payment,2026-08-19,32,700.00,pending,invoice,payment-open,\/invoices\/invoice-1/);

  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents, created_at, updated_at
    ) VALUES ('invoice-old', 'project-1', 'INV-OLD', 'paid', 50000, 50000, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, gross_collected_cents, net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-old', 'invoice-old', 'Old payment', 50000, '2026-04-01', 'paid', '2026-04-02T10:00:00.000Z', 'stripe',
      50000, 50000, 50000, ?, ?
    )
  `).run(now, now);

  const junePaidOnly = await getPaymentLedgerReport({
    status: "paid",
    fromDate: "2026-06-01",
    toDate: "2026-06-30",
  });
  assert.deepEqual(junePaidOnly.rows.map((row) => row.sourceId), ["payment-paid", "booking-paid"]);
  assert.equal(junePaidOnly.totals.paidCents, 55000);

  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents, created_at, updated_at
    ) VALUES ('invoice-unreconciled', 'project-1', 'INV-UNRECONCILED', 'paid', 40000, 40000, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, gross_collected_cents, net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-unreconciled', 'invoice-unreconciled', 'Offline payment', 40000, '2026-06-10', 'paid', '2026-06-11T10:00:00.000Z', 'zelle',
      40000, 40000, 40000, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, client_id, attendee_name, attendee_email,
      start_at, end_at, status, source, payment_status, payment_method, paid_at,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, external_payment_id, payment_link, payment_notes,
      created_at, updated_at
    ) VALUES (
      'booking-unreconciled', 'meeting-1', 'project-1', 'client-1', 'Alex Taylor', 'alex@example.com',
      '2026-06-12T14:00:00.000Z', '2026-06-12T14:45:00.000Z', 'confirmed', 'booking_link',
      'paid', 'stripe', '2026-06-12T13:00:00.000Z',
      25000, 755, 755, 25755,
      25000, NULL, 'https://pay.stripe.com/test_paid_consult', 'Needs Stripe settlement reference',
      ?, ?
    )
  `).run(now, now);

  const needsReconciliation = await getPaymentLedgerReport({
    status: "needs_reconciliation",
    fromDate: "2026-06-01",
    toDate: "2026-06-30",
  });
  assert.deepEqual(needsReconciliation.rows.map((row) => ({
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    externalPaymentId: row.payment.externalPaymentId,
    paymentSourceType: row.paymentSourceType,
    paymentSourceId: row.paymentSourceId,
  })), [
    {
      sourceType: "invoice",
      sourceId: "payment-unreconciled",
      externalPaymentId: null,
      paymentSourceType: null,
      paymentSourceId: null,
    },
    {
      sourceType: "scheduler_booking",
      sourceId: "booking-unreconciled",
      externalPaymentId: null,
      paymentSourceType: null,
      paymentSourceId: null,
    },
  ]);
  assert.equal(needsReconciliation.totals.paidCents, 65000);
  assert.equal(needsReconciliation.totals.netDepositCents, 65000);

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
    VALUES ('project-orphan', 'Needs Primary Client Wedding', 'wedding', 'inquiry', 'active', '2026-10-10', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-orphan', 'project-orphan', 'INV-ORPHAN-LEDGER', 'sent', 200000, 0,
      'client_pays', 290, 30, 5830,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, gross_collected_cents, net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-orphan-open', 'invoice-orphan', 'Unlinked project balance', 200000, '2026-10-01', 'pending', NULL, NULL,
      0, 0, 0, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, client_id, attendee_name, attendee_email,
      start_at, end_at, status, source, payment_status, payment_method, paid_at,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, external_payment_id, payment_link, payment_notes,
      created_at, updated_at
    ) VALUES (
      'booking-orphan-open', 'meeting-1', 'project-orphan', NULL, 'Unlinked Client', 'unlinked@example.com',
      '2026-10-05T14:00:00.000Z', '2026-10-05T14:45:00.000Z', 'confirmed', 'booking_link',
      'unpaid', NULL, NULL,
      0, 0, 0, 0,
      0, NULL, 'https://pay.stripe.com/test_paid_consult', 'Scheduler payment awaiting reconciliation',
      ?, ?
    )
  `).run(now, now);

  const orphanReport = await getPaymentLedgerReport({ status: "all", asOfDate: "2026-10-20" });
  const orphanRows = orphanReport.rows.filter((row) => row.project.id === "project-orphan");
  assert.deepEqual(orphanRows.map((row) => ({
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    invoiceNumber: row.invoice.invoiceNumber,
    projectName: row.project.name,
    clientId: row.client?.id ?? null,
    clientName: row.clientName,
    openCents: row.openCents,
    clientPayableOpenCents: row.clientPayableOpenCents,
  })), [
    {
      sourceType: "invoice",
      sourceId: "payment-orphan-open",
      invoiceNumber: "INV-ORPHAN-LEDGER",
      projectName: "Needs Primary Client Wedding",
      clientId: null,
      clientName: "Needs primary client",
      openCents: 200000,
      clientPayableOpenCents: 205830,
    },
    {
      sourceType: "scheduler_booking",
      sourceId: "booking-orphan-open",
      invoiceNumber: "BOOKING",
      projectName: "Needs Primary Client Wedding",
      clientId: null,
      clientName: "Needs primary client",
      openCents: 25000,
      clientPayableOpenCents: 25000,
    },
  ]);
  assert(orphanReport.totals.openCents >= 225000);
  assert(orphanReport.aging.rows.some((row) => (
    row.sourceId === "payment-orphan-open"
    && row.clientId === null
    && row.clientName === "Needs primary client"
    && row.openCents === 200000
  )));
  const orphanCsv = paymentLedgerCsv(orphanReport.rows);
  assert.match(orphanCsv, /INV-ORPHAN-LEDGER,Needs Primary Client Wedding,Needs primary client,Unlinked project balance/);
  const orphanAgingCsv = accountsReceivableAgingCsv(orphanReport.aging);
  assert.match(orphanAgingCsv, /2026-10-20,1-30,INV-ORPHAN-LEDGER,Needs Primary Client Wedding,Needs primary client,Unlinked project balance/);

  console.log("payment ledger tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
