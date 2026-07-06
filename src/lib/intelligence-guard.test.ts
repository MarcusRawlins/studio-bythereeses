import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-intelligence-guard-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

const NOW = "2026-05-01T00:00:00.000Z";

// Every canonical business table the Phase 10 read surface must NEVER write.
const CANONICAL_TABLES = [
  "projects",
  "clients",
  "project_participants",
  "proposals",
  "proposal_line_items",
  "invoices",
  "invoice_payments",
  "scheduler_bookings",
  "expenses",
  "vendors",
  "project_events",
  "activity_logs",
  "inbound_inquiries",
  "payment_refunds",
  "payment_disputes",
  "mileage_logs",
];

async function main() {
  const { rawDb } = await import("@/db/client");
  const database = rawDb();
  const run = (sql: string, ...params: unknown[]) => database.prepare(sql).run(...params);
  const count = (table: string) => (database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  const snapshot = () => Object.fromEntries(CANONICAL_TABLES.map((table) => [table, count(table)]));

  // --- seed a representative slice of canonical data ------------------------
  run(`INSERT INTO app_settings (id, business_name, public_brand_name, contact_email, timezone, payment_methods_json, created_at, updated_at)
       VALUES ('business', 'The Reeses', 'The Reeses Studio', 'hello@bythereeses.com', 'America/New_York',
        '{"stripe":{"enabled":true,"passFees":false,"displayName":"Credit card","instructions":""}}', ?, ?)`, NOW, NOW);
  run(`INSERT INTO clients (id, first_name, last_name, email, referral_source, created_at, updated_at)
       VALUES ('client-1', 'Guard', 'Case', 'guard@x.com', 'Instagram', ?, ?)`, NOW, NOW);
  run(`INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
       VALUES ('project-1', 'Guard Wedding', 'wedding', 'retainer_paid', 'active', ?, ?)`, NOW, NOW);
  run(`INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
       VALUES ('part-1', 'project-1', 'client-1', 'primary', 1, ?)`, NOW);
  run(`INSERT INTO proposals (id, project_id, title, status, total_cents, accepted_at, created_at, updated_at)
       VALUES ('prop-1', 'project-1', 'Package', 'accepted', 500000, ?, ?, ?)`, NOW, NOW, NOW);
  run(`INSERT INTO invoices (id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents, card_fee_policy, created_at, updated_at)
       VALUES ('inv-1', 'project-1', 'prop-1', 'INV-GUARD', 'partially_paid', 500000, 100000, 'studio_absorbs', ?, ?)`, NOW, NOW);
  run(`INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, paid_at, paid_amount_cents, gross_collected_cents, net_deposit_cents, created_at, updated_at)
       VALUES ('pay-paid', 'inv-1', 'Retainer', 100000, '2026-05-01', 'paid', '2026-05-02T10:00:00.000Z', 100000, 100000, 100000, ?, ?)`, NOW, NOW);
  run(`INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
       VALUES ('pay-open', 'inv-1', 'Final', 400000, '2026-09-01', 'pending', ?, ?)`, NOW, NOW);
  run(`INSERT INTO scheduler_meeting_types (id, slug, name, duration_minutes, buffer_minutes, price_cents, created_at, updated_at)
       VALUES ('mt-1', 'consult', 'Consult', 30, 15, 5000, ?, ?)`, NOW, NOW);
  run(`INSERT INTO scheduler_bookings (id, meeting_type_id, project_id, client_id, attendee_name, attendee_email, start_at, end_at, status, source, payment_status, created_at, updated_at)
       VALUES ('booking-1', 'mt-1', 'project-1', 'client-1', 'Guard Case', 'guard@x.com', '2026-05-10T14:00:00.000Z', '2026-05-10T14:30:00.000Z', 'confirmed', 'booking_link', 'unpaid', ?, ?)`, NOW, NOW);
  run(`INSERT INTO project_events (id, project_id, type, title, event_date, calendar_sync_status, created_at, updated_at)
       VALUES ('evt-1', 'project-1', 'wedding', 'Wedding day', '2026-09-19', 'not_connected', ?, ?)`, NOW, NOW);
  run(`INSERT INTO inbound_inquiries (id, status, parsed_email, received_at, created_at, updated_at)
       VALUES ('inb-1', 'new', 'guard@x.com', ?, ?, ?)`, NOW, NOW, NOW);
  run(`INSERT INTO vendors (id, name, normalized_name, created_at, updated_at)
       VALUES ('vendor-1', 'Album Lab', 'album lab', ?, ?)`, NOW, NOW);
  run(`INSERT INTO expenses (id, vendor_id, project_id, category, description, amount_cents, status, paid_at, tax_deductible, created_at, updated_at)
       VALUES ('exp-1', 'vendor-1', 'project-1', 'albums', 'Album', 15000, 'paid', '2026-05-03', 1, ?, ?)`, NOW, NOW);
  run(`INSERT INTO mileage_logs (id, trip_date, miles, created_at, updated_at)
       VALUES ('mile-1', '2026-05-03', 40, ?, ?)`, NOW, NOW);
  run(`INSERT INTO payment_refunds (id, stripe_refund_id, amount_cents, currency, status, created_at, updated_at)
       VALUES ('ref-1', 're_guard_1', 5000, 'usd', 'succeeded', ?, ?)`, NOW, NOW);
  run(`INSERT INTO payment_disputes (id, stripe_dispute_id, amount_cents, currency, status, funds_reinstated, created_at, updated_at)
       VALUES ('dis-1', 'dp_guard_1', 3000, 'usd', 'open', 0, ?, ?)`, NOW, NOW);

  const intel = await import("./intelligence");
  const { handleStudioMcpMessage } = await import("./studio-mcp");

  const before = snapshot();

  // --- exercise every read surface (normal args) ----------------------------
  await intel.getRevenueForecast({});
  await intel.getConversionReport({});
  await intel.getLeadSourcePerformance({});
  await intel.getPackageValueTrend({});
  await intel.getSeasonalCapacity({});
  await intel.getBusinessReview({});
  await intel.getIntelligenceSettings();

  const normalMcp = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "studio_get_business_review", arguments: { fromDate: "2026-05-01", toDate: "2026-05-31" } },
  });
  assert.ok(normalMcp && normalMcp.result, "MCP business review returns a result for normal args");

  // --- hostile args (SQL-injection-shaped, wrong types, extra keys) ---------
  const hostileArgs = {
    projectId: "x'; DROP",
    fromDate: "'; DELETE FROM projects; --",
    toDate: {},
    asOfDate: "'; DROP TABLE clients; --",
    extra: "not-a-real-field",
  } as Record<string, unknown>;
  await intel.getBusinessReview(hostileArgs as never);
  const hostileMcp = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "studio_get_business_review", arguments: hostileArgs },
  });
  assert.ok(hostileMcp, "MCP handled hostile args without crashing");

  const after = snapshot();
  assert.deepEqual(after, before, "no canonical table row count changed after normal + hostile reads");

  // --- source-level no-write assertions -------------------------------------
  const source = fs.readFileSync(path.join(process.cwd(), "src", "lib", "intelligence.ts"), "utf8");
  assert.ok(!/db\.insert\(/.test(source), "intelligence.ts contains NO db.insert(");
  assert.ok(!/db\.delete\(/.test(source), "intelligence.ts contains NO db.delete(");
  const updateMatches = source.match(/db\.update\(/g) ?? [];
  assert.equal(updateMatches.length, 1, "intelligence.ts has exactly one db.update( (the admin settings writer)");
  assert.ok(/db\.update\(appSettings\)/.test(source), "the single db.update targets app_settings only");

  // --- updateIntelligenceSettings writes ONLY app_settings ------------------
  const beforeSettings = snapshot();
  await intel.updateIntelligenceSettings({
    forecastHorizonMonths: 5,
    forecastTrailingMonths: 12,
    monthlyCapacityTarget: 4,
    leadSourceTaxonomyJson: '{"instagram":"Social"}',
  });
  const afterSettings = snapshot();
  assert.deepEqual(afterSettings, beforeSettings, "settings write left every canonical business table unchanged");
  const settingsRow = database.prepare(
    "SELECT forecast_horizon_months AS h, forecast_trailing_months AS t, monthly_capacity_target AS c, lead_source_taxonomy_json AS j FROM app_settings WHERE id = 'business'",
  ).get() as { h: number; t: number; c: number; j: string };
  assert.equal(settingsRow.h, 5);
  assert.equal(settingsRow.t, 12);
  assert.equal(settingsRow.c, 4);
  assert.equal(settingsRow.j, '{"instagram":"Social"}');

  // --- finance-write block still throws (Phase 10 didn't loosen it) ---------
  const { recordInvoicePaymentFromAgent } = await import("./sales");
  await assert.rejects(
    () => recordInvoicePaymentFromAgent("inv-1", {
      paymentId: "pay-open",
      status: "paid",
      paymentMethod: "stripe",
      paidAmountCents: 400000,
      paidAt: "2026-06-02T10:00:00.000Z",
    }),
    /Payments require Tyler approval/,
    "the existing agent finance-write block still rejects",
  );
  const openPayment = database.prepare("SELECT status, paid_amount_cents AS paid FROM invoice_payments WHERE id = 'pay-open'").get() as { status: string; paid: number };
  assert.equal(openPayment.status, "pending", "the blocked payment was not mutated");
  assert.equal(openPayment.paid, 0);

  console.log("intelligence guard tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
