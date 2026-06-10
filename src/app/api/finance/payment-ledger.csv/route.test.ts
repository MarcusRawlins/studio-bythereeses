import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-payment-ledger-csv-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

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
      'source-payment-1', 'project-1', 'payment_receipt', 'Retainer receipt',
      'Stripe receipt for the invoice retainer.', 'stripe_payment_intent', 'pi_route_123', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-LEDGER-ROUTE', 'partially_paid', 100000, 30000,
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
      30000, 'pi_route_123', 'Stripe payment', 'project_source', 'source-payment-1', ?, ?
    )
  `).run(now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blocked = await route.GET(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/finance/payment-ledger.csv?status=paid"));
  assert.equal(blocked.status, 404);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/finance/payment-ledger.csv?status=paid", {
    headers: { "x-reese-origin-secret": "origin-secret" },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(response.headers.get("content-disposition") ?? "", /the-reeses-studio-payment-ledger-\d{4}-\d{2}-\d{2}\.csv/);
  const csv = await response.text();
  assert.match(csv, /^Invoice,Project,Client,Payment,Due Date,Paid At,Status,Method,Scheduled,Paid,Gross Collected,Client Fee,Processor Fee,Net Deposit,Open,Client Payable Open,External Payment ID,Notes,Payment Source Type,Payment Source ID,Record Source Type,Record Source ID,Link/m);
  assert.match(csv, /INV-LEDGER-ROUTE,Alex Wedding,Alex Taylor,Retainer,2026-06-01,2026-06-02T10:00:00.000Z,paid,stripe,300.00,300.00,309.00,9.00,9.00,300.00,0.00,0.00,pi_route_123,Stripe payment,project_source,source-payment-1,invoice,payment-paid,\/invoices\/invoice-1#payment-payment-paid/);

  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, gross_collected_cents, net_deposit_cents, notes, created_at, updated_at
    ) VALUES (
      'payment-unreconciled-route', 'invoice-1', 'Manual payment', 20000, '2026-06-15', 'paid',
      '2026-06-16T10:00:00.000Z', 'zelle',
      20000, 20000, 20000, 'Needs bank reference', ?, ?
    )
  `).run(now, now);
  const reconciliationResponse = await route.GET(new Request("https://studio.bythereeses.com/api/finance/payment-ledger.csv?status=needs_reconciliation", {
    headers: { "x-reese-origin-secret": "origin-secret" },
  }));
  assert.equal(reconciliationResponse.status, 200);
  const reconciliationCsv = await reconciliationResponse.text();
  assert.match(reconciliationCsv, /INV-LEDGER-ROUTE,Alex Wedding,Alex Taylor,Manual payment,2026-06-15,2026-06-16T10:00:00.000Z,paid,zelle,200.00,200.00,200.00,0.00,0.00,200.00,0.00,0.00,,Needs bank reference,,,invoice,payment-unreconciled-route,\/invoices\/invoice-1#payment-payment-unreconciled-route/);
  assert.doesNotMatch(reconciliationCsv, /pi_route_123/);

  console.log("payment ledger csv route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
