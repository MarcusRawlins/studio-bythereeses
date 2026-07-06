import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-tax-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const tax = await import("./tax");
  const { getAccountingExportRows, accountingExportCsv } = await import("./accounting-export");
  const database = rawDb();
  const NOW = "2026-03-15T12:00:00.000Z";

  database.prepare(`
    INSERT INTO app_settings (id, business_name, public_brand_name, contact_email, timezone, payment_methods_json, created_at, updated_at)
    VALUES ('business', 'Alex & Tyler Reese', 'The Reeses Studio', 'hello@bythereeses.com', 'America/New_York', '{"stripe":{"enabled":true,"passFees":false,"displayName":"Credit card","instructions":""}}', ?, ?)
  `).run(NOW, NOW);

  // ---- Test 9: 1099 threshold ---------------------------------------------
  database.prepare("INSERT INTO vendors (id, name, normalized_name, created_at, updated_at) VALUES ('v-shooter', 'Second Shooter', 'second shooter', ?, ?)").run(NOW, NOW);
  database.prepare("INSERT INTO vendors (id, name, normalized_name, created_at, updated_at) VALUES ('v-card', 'Card Vendor', 'card vendor', ?, ?)").run(NOW, NOW);
  database.prepare("INSERT INTO vendors (id, name, normalized_name, created_at, updated_at) VALUES ('v-ambig', 'Ambiguous Vendor', 'ambiguous vendor', ?, ?)").run(NOW, NOW);
  // reportable (check) $700 → crosses $600, missing W-9
  database.prepare("INSERT INTO expenses (id, vendor_id, category, description, amount_cents, status, paid_at, payment_method, created_at, updated_at) VALUES ('e1', 'v-shooter', 'second_shooter', 'Wedding day', 70000, 'paid', '2026-05-01T00:00:00.000Z', 'check', ?, ?)").run(NOW, NOW);
  // card ($800 via 'Credit Card' free text) → excluded from 1099 tally
  database.prepare("INSERT INTO expenses (id, vendor_id, category, description, amount_cents, status, paid_at, payment_method, created_at, updated_at) VALUES ('e2', 'v-card', 'gear', 'Lens', 80000, 'paid', '2026-05-02T00:00:00.000Z', 'Credit Card', ?, ?)").run(NOW, NOW);
  // ambiguous: reportable $700 (zelle) + unrecognized $100 (bitcoin) → crosses + reconciliation flag
  database.prepare("INSERT INTO expenses (id, vendor_id, category, description, amount_cents, status, paid_at, payment_method, created_at, updated_at) VALUES ('e3', 'v-ambig', 'album', 'Album', 70000, 'paid', '2026-05-03T00:00:00.000Z', 'zelle', ?, ?)").run(NOW, NOW);
  database.prepare("INSERT INTO expenses (id, vendor_id, category, description, amount_cents, status, paid_at, payment_method, created_at, updated_at) VALUES ('e4', 'v-ambig', 'album', 'Album extra', 10000, 'paid', '2026-05-04T00:00:00.000Z', 'bitcoin', ?, ?)").run(NOW, NOW);

  const report1099 = await tax.get1099VendorReport({ year: 2026 });
  const shooter = report1099.vendors.find((v) => v.vendorId === "v-shooter");
  assert.equal(shooter?.reportableCents, 70000, "check payments counted as reportable");
  assert.equal(shooter?.crossesThreshold, true, "≥$600 non-card crosses the threshold");
  assert.equal(shooter?.missingW9, true, "crossed-threshold vendor missing W-9 flagged");
  const card = report1099.vendors.find((v) => v.vendorId === "v-card");
  assert.equal(card?.reportableCents, 0, "card payments excluded from 1099 tally (normalized include-list)");
  assert.equal(card?.crossesThreshold, false, "card-only vendor does not cross 1099 threshold");
  const ambig = report1099.vendors.find((v) => v.vendorId === "v-ambig");
  assert.equal(ambig?.hasUnrecognizedMethod, true, "unrecognized method detected");
  assert.equal(ambig?.needsReconciliation, true, "unrecognized method on a ≥threshold vendor is a reconciliation item");

  // After entering W-9 data, the missing-W9 flag clears; TIN is stored as last4 only.
  await tax.updateVendorTaxInfo("v-shooter", { legalName: "Jamie Second-Shooter", taxIdLast4: "12-3456789", is1099Tracked: true });
  assert.equal(database.prepare("SELECT tax_id_last4 FROM vendors WHERE id = 'v-shooter'").pluck().get(), "6789", "only the last 4 of the TIN is stored");
  const report1099b = await tax.get1099VendorReport({ year: 2026 });
  assert.equal(report1099b.vendors.find((v) => v.vendorId === "v-shooter")?.missingW9, false, "W-9 entry clears the missing flag");

  // ---- Test 10: mileage ----------------------------------------------------
  const created = await tax.createMileageLog({ tripDate: "2026-02-10", miles: 100, purpose: "Venue scout" });
  let mileage = await tax.getMileageReport({ year: 2026 });
  assert.equal(mileage.totalMiles, 100);
  assert.equal(mileage.deductionCents, 100 * tax.DEFAULT_MILEAGE_RATE_CENTS, "miles × rate = deduction");
  await tax.updateMileageLog(created.id, { miles: 200 });
  mileage = await tax.getMileageReport({ year: 2026 });
  assert.equal(mileage.totalMiles, 200, "mileage update round-trips");
  await tax.deleteMileageLog(created.id);
  mileage = await tax.getMileageReport({ year: 2026 });
  assert.equal(mileage.totalMiles, 0, "mileage delete round-trips");

  // ---- Tax estimate feeds from net revenue + deductible + mileage ----------
  // Seed Q1 revenue: a paid invoice payment in Feb.
  database.prepare("INSERT INTO projects (id, name, type, stage, status, created_at, updated_at) VALUES ('p-tax', 'Tax Wedding', 'wedding', 'retainer_paid', 'active', ?, ?)").run(NOW, NOW);
  database.prepare("INSERT INTO invoices (id, project_id, invoice_number, status, total_cents, amount_paid_cents, card_fee_policy, card_fee_amount_cents, paid_at, created_at, updated_at) VALUES ('i-tax', 'p-tax', 'INV-TAX', 'paid', 200000, 200000, 'studio_absorbs', 0, '2026-02-15T00:00:00.000Z', ?, ?)").run(NOW, NOW);
  database.prepare("INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, status, paid_at, payment_method, paid_amount_cents, gross_collected_cents, net_deposit_cents, created_at, updated_at) VALUES ('pp-tax', 'i-tax', 'Full', 200000, 'paid', '2026-02-15T00:00:00.000Z', 'stripe', 200000, 200000, 200000, ?, ?)").run(NOW, NOW);
  await tax.createMileageLog({ tripDate: "2026-02-20", miles: 100, purpose: "Shoot" });
  const estimate = await tax.getQuarterlyTaxEstimate({ year: 2026, quarter: 1 });
  assert.equal(estimate.netRevenueCents, 200000, "Q1 net revenue picks up the paid payment");
  assert.equal(estimate.mileageDeductionCents, 100 * tax.DEFAULT_MILEAGE_RATE_CENTS, "mileage deduction feeds the estimate");
  const expectedSetAside = Math.round(Math.max(estimate.estimatedNetSelfEmploymentIncomeCents, 0) * (estimate.taxSetAsideRatePercent / 100));
  assert.equal(estimate.estimatedSetAsideCents, expectedSetAside, "set-aside = net SE income × configured rate");

  // ---- Test 8: accounting export ------------------------------------------
  // Seed a refund child (succeeded) with a May money-event date + a paid expense in May.
  database.prepare("INSERT INTO payment_refunds (id, stripe_refund_id, stripe_payment_intent_id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at) VALUES ('r-acct', 're_acct', 'pi_tax', 'pp-tax', 25000, 'usd', 'succeeded', '2026-05-10T00:00:00.000Z', '2026-05-10T00:00:00.000Z')").run();
  const rows = await getAccountingExportRows({ fromDate: "2026-05-01", toDate: "2026-05-31" });
  assert.ok(rows.some((r) => r.type === "Refund" && r.reference === "re_acct" && r.debitCents === 25000), "export includes the refund line with Stripe reference");
  assert.ok(rows.some((r) => r.type === "Expense" && r.reference !== undefined), "export includes expense lines");
  // Income lines are scoped by paidAt — the Feb income should NOT appear in the May window.
  assert.ok(!rows.some((r) => r.type === "Income"), "May window excludes February income (period-scoped)");
  const febRows = await getAccountingExportRows({ fromDate: "2026-02-01", toDate: "2026-02-28" });
  assert.ok(febRows.some((r) => r.type === "Income" && r.creditCents === 200000), "February window includes the income line");
  const csv = accountingExportCsv(rows, { fromDate: "2026-05-01", toDate: "2026-05-31" });
  assert.ok(csv.includes("Date,Type,Description,Reference,Account,Debit,Credit,Party,Memo"), "CSV carries the accountant header row");
  assert.ok(csv.includes("re_acct"), "CSV carries the Stripe reference id");

  console.log("tax / 1099 / mileage / accounting-export tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
