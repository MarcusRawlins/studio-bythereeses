import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-finance-report-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, source_type, source_id, created_at, updated_at
    ) VALUES (
      'payment-source-1', 'project-1', 'payment_receipt', 'Stripe receipt',
      'Stripe receipt for retainer.', 'stripe_payment_intent', 'pi_route_123', ?, ?
    ), (
      'expense-source-1', 'project-1', 'receipt_upload', 'Album proof receipt',
      'Receipt OCR for album proof.', 'receipt_upload', 'receipt-route-1', ?, ?
    ), (
      'payment-source-scheduler', 'project-1', 'payment_receipt', 'Scheduler receipt',
      'Scheduler booking payment receipt.', 'stripe_payment_intent', 'pi_scheduler_route_123', ?, ?
    )
  `).run(now, now, now, now, now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-FINANCE', 'partially_paid', 100000, 40000,
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
      'payment-1', 'invoice-1', 'Retainer', 40000, '2026-06-01', 'paid',
      '2026-06-02T10:00:00.000Z', 'stripe',
      40000, 1190, 1190, 41190,
      40000, 'pi_route_123', 'Stripe receipt reconciled.', 'project_source', 'payment-source-1', ?, ?
    ), (
      'payment-open', 'invoice-1', 'Final balance', 60000, '2026-08-19', 'pending',
      NULL, NULL,
      0, 0, 0, 0,
      0, NULL, NULL, NULL, NULL, ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, collect_payment, price_cents,
      stripe_payment_link, created_at, updated_at
    ) VALUES (
      'meeting-1', 'paid-consult', 'Paid Consultation', 45, 15, 1, 10000,
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
      'booking-duplicate', 'meeting-1', 'project-1', 'client-1', 'Alex Taylor', 'alex@example.com',
      '2026-06-03T14:00:00.000Z', '2026-06-03T14:45:00.000Z', 'confirmed', 'booking_link',
      'paid', 'stripe', '2026-06-03T13:00:00.000Z',
      10000, 0, 0, 10000,
      10000, 'pi_route_123', 'https://pay.stripe.com/test_paid_consult', 'Duplicate payment intent imported from scheduler.',
      'project_source', 'payment-source-scheduler', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO vendors (id, name, normalized_name, created_at, updated_at)
    VALUES ('vendor-1', 'Album Lab', 'album lab', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO expenses (
      id, vendor_id, project_id, category, description, amount_cents, status, paid_at,
      payment_method, external_payment_id, receipt_url, tax_deductible, notes,
      source_type, source_id, created_at, updated_at
    ) VALUES (
      'expense-1', 'vendor-1', 'project-1', 'albums', 'Album proof',
      15000, 'paid', '2026-06-03', 'amex', 'ch_route_123',
      'r2://receipts/album-proof.pdf', 1, 'Client album proof.',
      'project_source', 'expense-source-1', ?, ?
    ), (
      'expense-unpaid', 'vendor-1', 'project-1', 'albums', 'Album balance',
      40000, 'unpaid', '2026-06-10', 'ach', NULL,
      NULL, 1, 'Vendor balance not paid yet.',
      NULL, NULL, ?, ?
    )
  `).run(now, now, now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blockedOrigin = await route.GET(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/agent/finance/report", {
    headers: { authorization: "Bearer secret" },
  }));
  assert.equal(blockedOrigin.status, 404);

  const unauthorized = await route.GET(new Request("https://studio.bythereeses.com/api/agent/finance/report"));
  assert.equal(unauthorized.status, 401);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/agent/finance/report?paymentStatus=paid&expenseStatus=paid", {
    headers: {
      authorization: "Bearer secret",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.financeReport.paymentLedger.totals, {
    scheduledCents: 50000,
    paidCents: 50000,
    grossCollectedCents: 51190,
    clientFeeCents: 1190,
    processingFeeCents: 1190,
    netDepositCents: 50000,
    openCents: 0,
    clientPayableOpenCents: 0,
    refundedCents: 0,
    disputedOpenCents: 0,
    netCollectedCents: 51190,
  });
  assert.deepEqual(body.financeReport.paymentLedger.rows.map((row: {
    recordType: string;
    invoiceNumber: string;
    paymentLabel: string;
    paymentSourceType: string | null;
    paymentSourceId: string | null;
  }) => ({
    recordType: row.recordType,
    invoiceNumber: row.invoiceNumber,
    paymentLabel: row.paymentLabel,
    paymentSourceType: row.paymentSourceType,
    paymentSourceId: row.paymentSourceId,
  })), [
    {
      recordType: "invoice",
      invoiceNumber: "INV-FINANCE",
      paymentLabel: "Retainer",
      paymentSourceType: "project_source",
      paymentSourceId: "payment-source-1",
    },
    {
      recordType: "scheduler_booking",
      invoiceNumber: "BOOKING",
      paymentLabel: "Paid Consultation",
      paymentSourceType: "project_source",
      paymentSourceId: "payment-source-scheduler",
    },
  ]);

  const agingResponse = await route.GET(new Request("https://studio.bythereeses.com/api/agent/finance/report?paymentStatus=all&expenseStatus=paid&asOfDate=2026-09-20", {
    headers: {
      authorization: "Bearer secret",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(agingResponse.status, 200);
  const agingBody = await agingResponse.json();
  assert.equal(agingBody.financeReport.period.asOfDate, "2026-09-20");
  assert.deepEqual(agingBody.financeReport.paymentLedger.aging.buckets.find((bucket: { bucket: string }) => bucket.bucket === "31_60"), {
    bucket: "31_60",
    label: "31-60",
    openCents: 60000,
    count: 1,
  });
  assert.deepEqual(agingBody.financeReport.paymentLedger.rows.map((row: {
    paymentId: string;
    openCents: number;
    clientPayableOpenCents: number;
  }) => ({
    paymentId: row.paymentId,
    openCents: row.openCents,
    clientPayableOpenCents: row.clientPayableOpenCents,
  })), [
    {
      paymentId: "payment-1",
      openCents: 0,
      clientPayableOpenCents: 61740,
    },
    {
      paymentId: "booking-duplicate",
      openCents: 0,
      clientPayableOpenCents: 0,
    },
    {
      paymentId: "payment-open",
      openCents: 60000,
      clientPayableOpenCents: 61740,
    },
  ]);
  assert.deepEqual(agingBody.financeReport.paymentLedger.aging.rows.map((row: {
    paymentId: string;
    projectName: string;
    clientName: string;
    daysPastDue: number;
    bucket: string;
    openCents: number;
  }) => ({
    paymentId: row.paymentId,
    projectName: row.projectName,
    clientName: row.clientName,
    daysPastDue: row.daysPastDue,
    bucket: row.bucket,
    openCents: row.openCents,
  })), [
    {
      paymentId: "payment-open",
      projectName: "Alex Wedding",
      clientName: "Alex Taylor",
      daysPastDue: 32,
      bucket: "31_60",
      openCents: 60000,
    },
  ]);
  assert.deepEqual(agingBody.financeReport.projectFinancials, [
    {
      projectId: "project-1",
      projectName: "Alex Wedding",
      clientId: "client-1",
      clientName: "Alex Taylor",
      scheduledCents: 110000,
      paidCents: 50000,
      grossCollectedCents: 51190,
      clientFeeCents: 1190,
      processingFeeCents: 1190,
      netDepositCents: 50000,
      openCents: 60000,
      clientPayableOpenCents: 61740,
      expenseCents: 15000,
      paidExpenseCents: 15000,
      openPayableCents: 0,
      taxDeductibleExpenseCents: 15000,
      nonDeductibleExpenseCents: 0,
      collectedProfitCents: 35000,
      projectedProfitCents: 95000,
      paymentCount: 3,
      expenseCount: 1,
      href: "/projects/project-1",
    },
  ]);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-orphan', 'Needs Primary Client Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-orphan', 'project-orphan', 'INV-AGENT-ORPHAN', 'sent', 200000, 0,
      'client_pays', 290, 30, 5830,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, gross_collected_cents, net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-agent-orphan', 'invoice-orphan', 'Unlinked project balance', 200000, '2026-10-01', 'pending',
      NULL, NULL,
      0, 0, 0, ?, ?
    )
  `).run(now, now);

  const orphanResponse = await route.GET(new Request("https://studio.bythereeses.com/api/agent/finance/report?paymentStatus=all&expenseStatus=paid&asOfDate=2026-10-20", {
    headers: {
      authorization: "Bearer secret",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(orphanResponse.status, 200);
  const orphanBody = await orphanResponse.json();
  assert.deepEqual(orphanBody.financeReport.paymentLedger.rows
    .filter((row: { projectId: string }) => row.projectId === "project-orphan")
    .map((row: {
      recordType: string;
      recordId: string;
      invoiceNumber: string;
      projectName: string;
      clientId: string | null;
      clientName: string;
      openCents: number;
      clientPayableOpenCents: number;
    }) => ({
      recordType: row.recordType,
      recordId: row.recordId,
      invoiceNumber: row.invoiceNumber,
      projectName: row.projectName,
      clientId: row.clientId,
      clientName: row.clientName,
      openCents: row.openCents,
      clientPayableOpenCents: row.clientPayableOpenCents,
    })), [
      {
        recordType: "invoice",
        recordId: "payment-agent-orphan",
        invoiceNumber: "INV-AGENT-ORPHAN",
        projectName: "Needs Primary Client Wedding",
        clientId: null,
        clientName: "Needs primary client",
        openCents: 200000,
        clientPayableOpenCents: 205830,
      },
    ]);
  assert.deepEqual(orphanBody.financeReport.projectFinancials
    .filter((row: { projectId: string }) => row.projectId === "project-orphan"), [
      {
        projectId: "project-orphan",
        projectName: "Needs Primary Client Wedding",
        clientId: null,
        clientName: "Needs primary client",
        scheduledCents: 200000,
        paidCents: 0,
        grossCollectedCents: 0,
        clientFeeCents: 0,
        processingFeeCents: 0,
        netDepositCents: 0,
        openCents: 200000,
        clientPayableOpenCents: 205830,
        expenseCents: 0,
        paidExpenseCents: 0,
        openPayableCents: 0,
        taxDeductibleExpenseCents: 0,
        nonDeductibleExpenseCents: 0,
        collectedProfitCents: 0,
        projectedProfitCents: 200000,
        paymentCount: 1,
        expenseCount: 0,
        href: "/projects/project-orphan",
      },
    ]);
  assert.deepEqual(body.financeReport.bookkeeping.totals, {
    revenueCents: 50000,
    grossCollectedCents: 51190,
    clientFeeCents: 1190,
    processingFeeCents: 1190,
    netDepositCents: 50000,
    expenseCents: 15000,
    paidExpenseCents: 15000,
    openPayableCents: 40000,
    taxDeductibleExpenseCents: 15000,
    nonDeductibleExpenseCents: 0,
    netIncomeCents: 35000,
    refundedCents: 0,
    disputeLostCents: 0,
    netRevenueCents: 50000,
    netDepositAfterRefundsCents: 50000,
    netIncomeAfterRefundsCents: 35000,
  });
  assert.deepEqual(body.financeReport.bookkeeping.expensesByCategory, [
    {
      category: "albums",
      expenseCents: 15000,
      taxDeductibleExpenseCents: 15000,
      count: 1,
    },
  ]);
  assert.deepEqual(body.financeReport.bookkeeping.expensesByVendor, [
    {
      vendorId: "vendor-1",
      vendorName: "Album Lab",
      expenseCents: 15000,
      taxDeductibleExpenseCents: 15000,
      count: 1,
    },
  ]);
  assert.deepEqual(body.financeReport.bookkeeping.expenses.map((row: {
    vendorName: string;
    projectName: string | null;
    sourceType: string | null;
    sourceId: string | null;
  }) => ({
    vendorName: row.vendorName,
    projectName: row.projectName,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
  })), [
    {
      vendorName: "Album Lab",
      projectName: "Alex Wedding",
      sourceType: "project_source",
      sourceId: "expense-source-1",
    },
  ]);
  assert.deepEqual(body.financeReport.canonicalization, {
    issueCount: 1,
    duplicateExternalPaymentIds: [{
      externalPaymentId: "pi_route_123",
      count: 2,
      records: [
        {
          ledger: "payment_ledger",
          recordType: "invoice",
          recordId: "payment-1",
          projectId: "project-1",
          externalPaymentId: "pi_route_123",
        },
        {
          ledger: "payment_ledger",
          recordType: "scheduler_booking",
          recordId: "booking-duplicate",
          projectId: "project-1",
          externalPaymentId: "pi_route_123",
        },
      ],
    }],
    orphanedSourceLinks: [],
  });

  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-reconciliation', 'project-1', 'INV-RECON', 'paid', 1000, 1000,
      'studio_absorbs', 0, 0, 0,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, external_payment_id, notes, source_type, source_id, created_at, updated_at
    ) VALUES (
      'payment-missing-evidence', 'invoice-reconciliation', 'Card charge needing evidence', 1000, '2026-06-04', 'paid',
      '2026-06-04T10:00:00.000Z', 'stripe',
      1000, 0, 0, 1000,
      1000, NULL, 'Imported card charge without settlement/source evidence.', NULL, NULL, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO expenses (
      id, vendor_id, project_id, category, description, amount_cents, status, paid_at,
      payment_method, external_payment_id, receipt_url, tax_deductible, notes,
      source_type, source_id, created_at, updated_at
    ) VALUES (
      'expense-missing-evidence', 'vendor-1', 'project-1', 'software', 'Receipt missing charge',
      9900, 'paid', '2026-06-05', 'amex', NULL,
      NULL, 1, 'Imported card charge missing receipt/source.',
      NULL, NULL, ?, ?
    )
  `).run(now, now);

  const reconciliationResponse = await route.GET(new Request("https://studio.bythereeses.com/api/agent/finance/report?paymentStatus=needs_reconciliation&expenseStatus=needs_reconciliation", {
    headers: {
      authorization: "Bearer secret",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(reconciliationResponse.status, 200);
  const reconciliationBody = await reconciliationResponse.json();
  assert.deepEqual(reconciliationBody.financeReport.paymentLedger.rows.map((row: {
    paymentId: string;
    needsReconciliation: boolean;
    missingEvidence: string[];
  }) => ({
    paymentId: row.paymentId,
    needsReconciliation: row.needsReconciliation,
    missingEvidence: row.missingEvidence,
  })), [
    {
      paymentId: "payment-missing-evidence",
      needsReconciliation: true,
      missingEvidence: ["external_payment_id", "source"],
    },
  ]);
  assert.deepEqual(reconciliationBody.financeReport.bookkeeping.expenses.map((row: {
    id: string;
    needsReconciliation: boolean;
    missingEvidence: string[];
  }) => ({
    id: row.id,
    needsReconciliation: row.needsReconciliation,
    missingEvidence: row.missingEvidence,
  })), [
    {
      id: "expense-missing-evidence",
      needsReconciliation: true,
      missingEvidence: ["external_payment_id", "receipt_url", "source"],
    },
  ]);
  assert.deepEqual(reconciliationBody.financeReport.reconciliation, {
    paymentCount: 1,
    expenseCount: 1,
    totalCount: 2,
    missingEvidenceCounts: [
      {
        evidence: "external_payment_id",
        paymentCount: 1,
        expenseCount: 1,
        totalCount: 2,
      },
      {
        evidence: "source",
        paymentCount: 1,
        expenseCount: 1,
        totalCount: 2,
      },
      {
        evidence: "receipt_url",
        paymentCount: 0,
        expenseCount: 1,
        totalCount: 1,
      },
    ],
    paymentRows: [
      {
        recordType: "invoice",
        recordId: "payment-missing-evidence",
        paymentId: "payment-missing-evidence",
        paymentLabel: "Card charge needing evidence",
        projectId: "project-1",
        projectName: "Alex Wedding",
        clientName: "Alex Taylor",
        paidAt: "2026-06-04T10:00:00.000Z",
        paidCents: 1000,
        externalPaymentId: null,
        paymentSourceType: null,
        paymentSourceId: null,
        href: "/invoices/invoice-reconciliation#payment-payment-missing-evidence",
        missingEvidence: ["external_payment_id", "source"],
      },
    ],
    expenseRows: [
      {
        id: "expense-missing-evidence",
        vendorName: "Album Lab",
        projectId: "project-1",
        projectName: "Alex Wedding",
        paidAt: "2026-06-05",
        amountCents: 9900,
        externalPaymentId: null,
        receiptUrl: null,
        sourceType: null,
        sourceId: null,
        href: "/finance?expenseId=expense-missing-evidence#expense-expense-missing-evidence",
        missingEvidence: ["external_payment_id", "receipt_url", "source"],
      },
    ],
    refundInitiations: {
      initiatedNotRecorded: [],
      stuckSubmitting: [],
      totalCount: 0,
    },
  });

  console.log("agent finance report route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
