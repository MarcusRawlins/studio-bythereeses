import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-intelligence-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

const NOW = "2024-01-01T00:00:00.000Z";

async function main() {
  const { rawDb } = await import("@/db/client");
  const database = rawDb();
  const run = (sql: string, ...params: unknown[]) => database.prepare(sql).run(...params);

  const setTrailing = (n: number) =>
    run("UPDATE app_settings SET forecast_trailing_months = ? WHERE id = 'business'", n);
  const setTarget = (n: number | null) =>
    run("UPDATE app_settings SET monthly_capacity_target = ? WHERE id = 'business'", n);

  // --- settings row -----------------------------------------------------------
  run(`
    INSERT INTO app_settings (id, business_name, public_brand_name, contact_email, timezone,
      payment_methods_json, forecast_horizon_months, forecast_trailing_months, lead_source_taxonomy_json,
      created_at, updated_at)
    VALUES ('business', 'The Reeses', 'The Reeses Studio', 'hello@bythereeses.com', 'America/New_York',
      '{"stripe":{"enabled":true,"passFees":false,"displayName":"Credit card","instructions":""}}',
      3, 6, '{"instagram":"Social - Instagram"}', ?, ?)
  `, NOW, NOW);

  const intel = await import("./intelligence");

  // =========================================================================
  // Revenue dataset — a single project/invoice with monthly paid payments.
  // 2024-01 .. 2026-05, base $8,000; July 2024 + July 2025 spiked to $100,000.
  // =========================================================================
  run(`INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
       VALUES ('rev-proj', 'Revenue', 'wedding', 'completed', 'active', ?, ?)`, NOW, NOW);
  run(`INSERT INTO invoices (id, project_id, invoice_number, status, total_cents, amount_paid_cents,
        card_fee_policy, created_at, updated_at)
       VALUES ('rev-inv', 'rev-proj', 'INV-REV', 'paid', 100000000, 100000000, 'studio_absorbs', ?, ?)`, NOW, NOW);

  const revMonths: Array<[number, number]> = [];
  for (let y = 2024; y <= 2026; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      if (y === 2026 && m > 5) break;
      revMonths.push([y, m]);
    }
  }
  let paymentSeq = 0;
  const addPaidPayment = (year: number, month: number, cents: number) => {
    paymentSeq += 1;
    const mm = String(month).padStart(2, "0");
    run(`INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, status, paid_at,
          paid_amount_cents, gross_collected_cents, net_deposit_cents, created_at, updated_at)
         VALUES (?, 'rev-inv', 'Payment', ?, 'paid', ?, ?, ?, ?, ?, ?)`,
      `rev-pay-${paymentSeq}`, cents, `${year}-${mm}-15T12:00:00.000Z`, cents, cents, cents, NOW, NOW);
  };
  for (const [y, m] of revMonths) {
    const cents = (m === 7 && (y === 2024 || y === 2025)) ? 10000000 : 800000;
    addPaidPayment(y, m, cents);
  }

  // ---- Cold-start ladder (keyed on dataPoints) -----------------------------
  setTrailing(6);
  const d0 = await intel.getRevenueForecast({ asOfDate: "2024-01-15" });
  assert.equal(d0.dataPoints, 0, "no fully-elapsed month since first activity → 0 datapoints");
  assert.equal(d0.confidence, "insufficient_data");
  assert.ok(d0.months.every((month) => month.projectedCents === 0), "dataPoints 0 → contracted-only, no projection");
  assert.ok(d0.note && /not enough revenue history/i.test(d0.note), "dataPoints 0 emits the honest fallback note");

  const d1 = await intel.getRevenueForecast({ asOfDate: "2024-02-15" });
  assert.equal(d1.dataPoints, 1, "one fully-elapsed month → 1 datapoint");
  assert.equal(d1.confidence, "low");
  assert.equal(d1.baseRunRateCents, 800000, "single $8,000 month reads $8,000 run-rate (not zero-padded)");
  assert.notEqual(d1.baseRunRateCents, 133333, "must NOT dilute to mean([0,0,0,0,0,8000]) == $1,333");

  const d3 = await intel.getRevenueForecast({ asOfDate: "2024-04-15" });
  assert.equal(d3.dataPoints, 3, "three fully-elapsed months → 3 datapoints");
  assert.equal(d3.confidence, "medium");

  setTrailing(24);
  const d24 = await intel.getRevenueForecast({ asOfDate: "2026-06-15" });
  assert.equal(d24.dataPoints, 24, "24 fully-elapsed months → 24 datapoints");
  assert.equal(d24.confidence, "high");
  // ---- Extrapolation clamp (F9): July seasonal spike clamped to 4× run-rate -
  const julyMonth = d24.months.find((month) => month.month === "2026-07");
  assert.ok(julyMonth, "horizon includes 2026-07");
  assert.equal(julyMonth!.projectedCents, 4 * d24.baseRunRateCents, "spiky month clamped to 4× run-rate");
  assert.equal(julyMonth!.confidence, "low", "clamp flips that month's confidence to low");
  assert.ok(julyMonth!.note && /clamp/i.test(julyMonth!.note), "clamp sets a note");

  // =========================================================================
  // Refund honesty — refund lands on money-event month, forecast uses net series.
  // =========================================================================
  run(`INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, status, paid_at,
        paid_amount_cents, gross_collected_cents, net_deposit_cents, created_at, updated_at)
       VALUES ('refund-pay', 'rev-inv', 'Big', 1000000, 'paid', '2030-01-15T12:00:00.000Z',
        1000000, 1000000, 1000000, ?, ?)`, NOW, NOW);
  run(`INSERT INTO payment_refunds (id, stripe_refund_id, amount_cents, currency, status, created_at, updated_at)
       VALUES ('refund-1', 're_test_1', 400000, 'usd', 'succeeded', '2030-02-10T12:00:00.000Z', ?)`, NOW);
  const { getBookkeepingReport } = await import("./bookkeeping");
  const jan = await getBookkeepingReport({ fromDate: "2030-01-01", toDate: "2030-01-31" });
  const feb = await getBookkeepingReport({ fromDate: "2030-02-01", toDate: "2030-02-28" });
  assert.equal(jan.totals.netRevenueCents, 1000000, "original paid month unaffected by later refund");
  assert.equal(feb.totals.netRevenueCents, -400000, "refund subtracted on its money-event month");
  setTrailing(2);
  const refundForecast = await intel.getRevenueForecast({ asOfDate: "2030-03-15" });
  assert.equal(refundForecast.dataPoints, 2);
  assert.equal(refundForecast.baseRunRateCents, 300000, "run-rate uses net series ((1,000,000 + -400,000)/2)");
  assert.notEqual(refundForecast.baseRunRateCents, 500000, "must NOT use a paid-only query (would read $5,000)");

  // ---- Non-positive run-rate (F9) ------------------------------------------
  run(`INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, status, paid_at,
        paid_amount_cents, gross_collected_cents, net_deposit_cents, created_at, updated_at)
       VALUES ('np-pay', 'rev-inv', 'Small', 200000, 'paid', '2031-01-15T12:00:00.000Z',
        200000, 200000, 200000, ?, ?)`, NOW, NOW);
  run(`INSERT INTO payment_refunds (id, stripe_refund_id, amount_cents, currency, status, created_at, updated_at)
       VALUES ('refund-2', 're_test_2', 500000, 'usd', 'succeeded', '2031-01-20T12:00:00.000Z', ?)`, NOW);
  setTrailing(1);
  const nonPositive = await intel.getRevenueForecast({ asOfDate: "2031-02-15" });
  assert.ok(nonPositive.baseRunRateCents <= 0, "refund-heavy window → non-positive run-rate");
  assert.ok(nonPositive.months.every((month) => month.projectedCents === 0), "non-positive run-rate suppresses projection");
  assert.equal(nonPositive.confidence, "low");
  assert.ok(nonPositive.months[0].note && /non-positive/i.test(nonPositive.months[0].note), "non-positive note set (no inverted clamp)");

  // =========================================================================
  // Carry-in reconciliation (F3) — open rows partitioned purely by dueDate.
  // Includes a refunded consult booking (openCents > 0, keeps counting).
  // =========================================================================
  run(`INSERT INTO scheduler_meeting_types (id, slug, name, duration_minutes, buffer_minutes, price_cents, created_at, updated_at)
       VALUES ('mt1', 'consult', 'Consult', 30, 15, 5000, ?, ?)`, NOW, NOW);
  run(`INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
       VALUES ('proj-recon', 'Recon', 'wedding', 'proposal_sent', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  run(`INSERT INTO invoices (id, project_id, invoice_number, status, total_cents, amount_paid_cents, card_fee_policy, created_at, updated_at)
       VALUES ('recon-inv', 'proj-recon', 'INV-RECON', 'sent', 450000, 0, 'studio_absorbs', ?, ?)`, NOW, NOW);
  // future in-horizon (contracted), past (carry-in), null due (carry-in)
  run(`INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
       VALUES ('recon-future', 'recon-inv', 'Final', 300000, '2026-08-01', 'pending', ?, ?)`, NOW, NOW);
  run(`INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
       VALUES ('recon-overdue', 'recon-inv', 'Overdue', 100000, '2026-03-01', 'pending', ?, ?)`, NOW, NOW);
  run(`INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, status, created_at, updated_at)
       VALUES ('recon-null', 'recon-inv', 'Unscheduled', 50000, 'pending', ?, ?)`, NOW, NOW);
  // refunded consult booking — openCents stays > 0 (booking zeroes only paid/waived)
  run(`INSERT INTO scheduler_bookings (id, meeting_type_id, project_id, attendee_name, attendee_email,
        start_at, end_at, status, source, payment_status, paid_amount_cents, gross_collected_cents,
        net_deposit_cents, created_at, updated_at)
       VALUES ('recon-booking', 'mt1', 'proj-recon', 'Past Consult', 'consult@x.com',
        '2026-02-10T14:00:00.000Z', '2026-02-10T14:30:00.000Z', 'confirmed', 'booking_link', 'refunded', 0, 0, 0, ?, ?)`, NOW, NOW);

  const { getPaymentLedgerReport } = await import("./sales");
  const ledgerAll = await getPaymentLedgerReport({ status: "all" });
  const bigHorizon = await intel.getRevenueForecast({ asOfDate: "2026-06-15", horizonMonths: 240 });
  const contractedSum = bigHorizon.months.reduce((sum, month) => sum + month.contractedCents, 0);
  assert.equal(
    bigHorizon.carryInCents + contractedSum,
    ledgerAll.totals.openCents,
    "carry-in + Σ contracted == totals.openCents over an unbounded horizon (refunded booking included)",
  );
  assert.equal(bigHorizon.carryInCents, 155000, "carry-in = overdue 100000 + null 50000 + refunded booking 5000");
  assert.equal(ledgerAll.totals.openCents, 455000);

  // =========================================================================
  // Conversion — key-set-union dedup, zero-key singletons, spam excluded, <5.
  // =========================================================================
  run(`INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
       VALUES ('conv-client', 'Cora', 'Ple', 'couple@x.com', ?, ?)`, NOW, NOW);
  run(`INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
       VALUES ('conv-proj', 'Couple', 'wedding', 'retainer_paid', 'active', '2028-01-05T00:00:00.000Z', '2028-01-05T00:00:00.000Z')`);
  run(`INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
       VALUES ('conv-part', 'conv-proj', 'conv-client', 'primary', 1, ?)`, NOW);
  // Unlinked booking sharing ONLY the email
  run(`INSERT INTO scheduler_bookings (id, meeting_type_id, attendee_name, attendee_email,
        start_at, end_at, status, source, payment_status, created_at, updated_at)
       VALUES ('conv-booking', 'mt1', 'Couple', 'couple@x.com',
        '2028-01-03T14:00:00.000Z', '2028-01-03T14:30:00.000Z', 'confirmed', 'booking_link', 'unpaid', '2028-01-03T00:00:00.000Z', '2028-01-03T00:00:00.000Z')`);
  // Unlinked inbound sharing ONLY the email
  run(`INSERT INTO inbound_inquiries (id, status, parsed_email, received_at, created_at, updated_at)
       VALUES ('conv-inbound', 'new', 'couple@x.com', '2028-01-02T00:00:00.000Z', ?, ?)`, NOW, NOW);
  // Two zero-key inbounds (null parsedEmail, no projectId) → two singletons
  run(`INSERT INTO inbound_inquiries (id, status, parsed_email, received_at, created_at, updated_at)
       VALUES ('conv-null-1', 'new', NULL, '2028-01-06T00:00:00.000Z', ?, ?)`, NOW, NOW);
  run(`INSERT INTO inbound_inquiries (id, status, parsed_email, received_at, created_at, updated_at)
       VALUES ('conv-null-2', 'new', '   ', '2028-01-07T00:00:00.000Z', ?, ?)`, NOW, NOW);
  // Spam + dismissed excluded
  run(`INSERT INTO inbound_inquiries (id, status, parsed_email, received_at, created_at, updated_at)
       VALUES ('conv-spam', 'spam', 'spam@x.com', '2028-01-04T00:00:00.000Z', ?, ?)`, NOW, NOW);
  run(`INSERT INTO inbound_inquiries (id, status, parsed_email, received_at, created_at, updated_at)
       VALUES ('conv-dismissed', 'dismissed', 'nope@x.com', '2028-01-04T00:00:00.000Z', ?, ?)`, NOW, NOW);

  const conversion = await intel.getConversionReport({ fromDate: "2028-01-01", toDate: "2028-01-31", asOfDate: "2028-01-31" });
  assert.equal(conversion.totalInquiries, 3, "merged (project+booking+inbound) counts once; two blank-email inbounds stay two singletons; spam/dismissed excluded");
  assert.equal(conversion.bookedCount, 1, "email-only inbound/booking convert via the shared project (not undercounted)");
  assert.equal(conversion.stillMaturingCount, 2, "the two young unbooked singletons are still maturing");
  assert.equal(conversion.cohortDenominator, 1, "only the matured/booked identity is in the cohort denominator");
  assert.equal(conversion.cohortBookedCount, 1);
  assert.equal(conversion.confidence, "low", "<5 inquiries → low confidence");
  assert.ok(conversion.showRawCountsOnly, "<5 inquiries → raw counts, not a percentage");
  assert.ok(/28/.test(conversion.method), "maturation window value appears in method");

  // =========================================================================
  // Lead-source — refund honesty, Unknown bucket, taxonomy, banner.
  // =========================================================================
  run(`INSERT INTO clients (id, first_name, email, referral_source, created_at, updated_at)
       VALUES ('ls-refund-client', 'Ref', 'ref@x.com', 'RefundSource', ?, ?)`, NOW, NOW);
  run(`INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
       VALUES ('ls-refund-proj', 'Refunded Wedding', 'wedding', 'completed', 'active', '2029-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z')`);
  run(`INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
       VALUES ('ls-refund-part', 'ls-refund-proj', 'ls-refund-client', 'primary', 1, ?)`, NOW);
  run(`INSERT INTO invoices (id, project_id, invoice_number, status, total_cents, amount_paid_cents, card_fee_policy, created_at, updated_at)
       VALUES ('ls-refund-inv', 'ls-refund-proj', 'INV-LSREF', 'paid', 500000, 500000, 'studio_absorbs', ?, ?)`, NOW, NOW);
  // Fully-refunded invoice payment: gross 500000, refunded 500000 → net collected 0
  run(`INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, status, paid_at,
        paid_amount_cents, gross_collected_cents, net_deposit_cents, refunded_amount_cents, created_at, updated_at)
       VALUES ('ls-refund-pay', 'ls-refund-inv', 'Full', 500000, 'refunded', '2029-02-01T12:00:00.000Z',
        500000, 500000, 500000, 500000, ?, ?)`, NOW, NOW);
  // Taxonomy-mapped Instagram source
  run(`INSERT INTO clients (id, first_name, email, referral_source, created_at, updated_at)
       VALUES ('ls-ig-client', 'Ig', 'ig@x.com', 'Instagram', ?, ?)`, NOW, NOW);
  run(`INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
       VALUES ('ls-ig-proj', 'IG Wedding', 'wedding', 'inquiry', 'active', '2029-01-02T00:00:00.000Z', '2029-01-02T00:00:00.000Z')`);
  run(`INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
       VALUES ('ls-ig-part', 'ls-ig-proj', 'ls-ig-client', 'primary', 1, ?)`, NOW);
  // No-primary project → Unknown
  run(`INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
       VALUES ('ls-noprimary', 'No Primary', 'wedding', 'inquiry', 'active', '2029-01-03T00:00:00.000Z', '2029-01-03T00:00:00.000Z')`);
  // Blank referralSource → Unknown
  run(`INSERT INTO clients (id, first_name, email, referral_source, created_at, updated_at)
       VALUES ('ls-blank-client', 'Bl', 'bl@x.com', NULL, ?, ?)`, NOW, NOW);
  run(`INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
       VALUES ('ls-blank-proj', 'Blank Source', 'wedding', 'inquiry', 'active', '2029-01-04T00:00:00.000Z', '2029-01-04T00:00:00.000Z')`);
  run(`INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
       VALUES ('ls-blank-part', 'ls-blank-proj', 'ls-blank-client', 'primary', 1, ?)`, NOW);

  const leadSource = await intel.getLeadSourcePerformance({});
  const refundBucket = leadSource.buckets.find((bucket) => bucket.source === "Refundsource");
  assert.ok(refundBucket, "refund source bucket rendered");
  assert.equal(refundBucket!.netCollectedCents, 0, "fully-refunded booking contributes $0 (refund-adjusted), not full gross");
  const igBucket = leadSource.buckets.find((bucket) => bucket.source === "Social - Instagram");
  assert.ok(igBucket, "taxonomy maps raw 'Instagram' → 'Social - Instagram'");
  const unknownBucket = leadSource.buckets.find((bucket) => bucket.source === "Unknown");
  assert.ok(unknownBucket && unknownBucket.projectCount >= 4, "no-primary + blank + others land in Unknown");
  assert.ok(leadSource.unknownBannerFlag, "Unknown >= 50% of projects sets the banner flag");

  // netCollected != agentFinance.netDepositCents for the refunded source
  const { getAgentFinanceReport } = await import("./agent-finance");
  const finance = await getAgentFinanceReport({});
  const refundProjectFinance = finance.projectFinancials.find((row) => row.projectId === "ls-refund-proj");
  assert.ok(refundProjectFinance, "refunded project appears in agent finance");
  assert.equal(refundProjectFinance!.netDepositCents, 500000, "agent-finance netDeposit is raw (no refund subtraction)");
  assert.notEqual(refundBucket!.netCollectedCents, refundProjectFinance!.netDepositCents, "lead-source net (0) must differ from raw netDeposit (500000)");

  // =========================================================================
  // Package value — earliest-invoice picker, thin months, declined excluded.
  // =========================================================================
  run(`INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
       VALUES ('pkg-proj', 'Package', 'wedding', 'completed', 'active', '2029-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z')`);
  run(`INSERT INTO proposals (id, project_id, title, status, total_cents, accepted_at, created_at, updated_at)
       VALUES ('prop1', 'pkg-proj', 'Prop 1', 'accepted', 500000, '2029-06-10T12:00:00.000Z', ?, ?)`, NOW, NOW);
  // Two linked invoices — earliest created is the booked value; never summed.
  run(`INSERT INTO invoices (id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents, card_fee_policy, created_at, updated_at)
       VALUES ('pkg-inv-a', 'pkg-proj', 'prop1', 'INV-PKGA', 'draft', 700000, 0, 'studio_absorbs', '2029-06-01T00:00:00.000Z', '2029-06-01T00:00:00.000Z')`);
  run(`INSERT INTO invoices (id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents, card_fee_policy, created_at, updated_at)
       VALUES ('pkg-inv-b', 'pkg-proj', 'prop1', 'INV-PKGB', 'draft', 999999, 0, 'studio_absorbs', '2029-06-02T00:00:00.000Z', '2029-06-02T00:00:00.000Z')`);
  // Second accepted proposal same month, no linked invoice → fallback total (estimated)
  run(`INSERT INTO proposals (id, project_id, title, status, total_cents, accepted_at, created_at, updated_at)
       VALUES ('prop3', 'pkg-proj', 'Prop 3', 'accepted', 300000, '2029-06-20T12:00:00.000Z', ?, ?)`, NOW, NOW);
  // Accepted proposal in the prior month → thin (single booking)
  run(`INSERT INTO proposals (id, project_id, title, status, total_cents, accepted_at, created_at, updated_at)
       VALUES ('prop2', 'pkg-proj', 'Prop 2', 'accepted', 250000, '2029-05-15T12:00:00.000Z', ?, ?)`, NOW, NOW);
  // Declined proposal → excluded
  run(`INSERT INTO proposals (id, project_id, title, status, total_cents, accepted_at, created_at, updated_at)
       VALUES ('prop-declined', 'pkg-proj', 'Prop Declined', 'declined', 111111, NULL, ?, ?)`, NOW, NOW);

  setTrailing(6);
  const pkg = await intel.getPackageValueTrend({ asOfDate: "2029-06-15" });
  assert.equal(pkg.totalBookings, 3, "3 accepted proposals in window (declined excluded)");
  const june = pkg.months.find((month) => month.month === "2029-06");
  assert.ok(june, "June bucket present");
  assert.equal(june!.bookingCount, 2);
  assert.equal(june!.avgPackageValueCents, 500000, "avg of earliest-invoice 700000 and fallback 300000");
  assert.ok(june!.values.includes(700000), "earliest-created linked invoice (700000) is the booked value");
  assert.ok(!june!.values.includes(1699999), "never sums the two linked invoices");
  assert.equal(june!.thin, false, "2 bookings → not thin");
  const may = pkg.months.find((month) => month.month === "2029-05");
  assert.ok(may && may.thin && may.bookingCount === 1, "single-booking month marked thin");

  // =========================================================================
  // Seasonal capacity — all project_events counted (rehearsal), calls excluded.
  // =========================================================================
  run(`INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
       VALUES ('evt-proj', 'Events', 'wedding', 'completed', 'active', '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')`);
  run(`INSERT INTO project_events (id, project_id, type, title, event_date, calendar_sync_status, created_at, updated_at)
       VALUES ('evt-wed', 'evt-proj', 'wedding', 'Wedding day', '2027-05-10', 'not_connected', ?, ?)`, NOW, NOW);
  run(`INSERT INTO project_events (id, project_id, type, title, event_date, calendar_sync_status, created_at, updated_at)
       VALUES ('evt-reh', 'evt-proj', 'rehearsal', 'Rehearsal dinner', '2027-05-09', 'not_connected', ?, ?)`, NOW, NOW);
  run(`INSERT INTO project_events (id, project_id, type, title, event_date, calendar_sync_status, created_at, updated_at)
       VALUES ('evt-por', 'evt-proj', 'portrait', 'Portrait session', '2027-08-01', 'not_connected', ?, ?)`, NOW, NOW);

  setTarget(null);
  const seasonal = await intel.getSeasonalCapacity({ asOfDate: "2027-05-01" });
  assert.equal(seasonal.seasonalIndexAvailable, false, "<2 years of events → no seasonal index");
  assert.equal(seasonal.confidence, "insufficient_data");
  const may2027 = seasonal.eventsByMonth.find((month) => month.month === "2027-05");
  assert.ok(may2027 && may2027.count === 2, "rehearsal counted alongside the wedding (all project_events counted)");
  assert.equal(seasonal.dataPoints, 3, "only project_events counted; scheduler bookings excluded");
  assert.ok(seasonal.calendarMonths.every((stat) => stat.seasonalIndex === null), "index null until 2+ years");
  assert.equal(seasonal.utilization[0].utilization, null, "no target set → no utilization");

  setTarget(2);
  const seasonalTargeted = await intel.getSeasonalCapacity({ asOfDate: "2027-05-01" });
  const utilMay = seasonalTargeted.utilization.find((month) => month.month === "2027-05");
  assert.ok(utilMay && utilMay.utilization === 1, "utilization = events/target when target set");
  setTarget(null);

  // =========================================================================
  // CSV builders — header/shape + method/confidence in footer.
  // =========================================================================
  const forecastCsv = intel.revenueForecastCsv(d24);
  assert.ok(forecastCsv.includes("Month,Contracted,Projected,Confidence,Note"), "revenue CSV header");
  assert.ok(/Carry-in/.test(forecastCsv) && /Method/.test(forecastCsv), "revenue CSV footer carries carry-in + method");
  assert.ok(intel.conversionCsv(conversion).includes("Method"), "conversion CSV carries method");
  assert.ok(intel.leadSourceCsv(leadSource).includes("Net collected"), "lead-source CSV header");
  assert.ok(intel.packageValueCsv(pkg).includes("Confidence"), "package CSV footer carries confidence");
  assert.ok(intel.seasonalCapacityCsv(seasonal).includes("Seasonal index"), "seasonal CSV header");

  // =========================================================================
  // Business review aggregator + headlines.
  // =========================================================================
  const review = await intel.getBusinessReview({ fromDate: "2029-06-01", toDate: "2029-06-30", asOfDate: "2029-06-30" });
  assert.ok(Array.isArray(review.headlines) && review.headlines.length >= 3, "business review emits headlines");
  assert.ok(review.revenueForecast && review.conversion && review.leadSource && review.packageValue && review.seasonalCapacity, "review aggregates all five metrics");

  console.log("intelligence tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
