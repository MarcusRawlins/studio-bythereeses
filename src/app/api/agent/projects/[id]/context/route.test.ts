import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-context-route-"));
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
      'source-1', 'project-1', 'planning_call', 'Planning call',
      'Planning source notes for the welcome dinner.', 'call_transcript', 'call-context-1', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_events (
      id, project_id, type, title, event_date, venue_name, source_type, source_id, created_at, updated_at
    ) VALUES (
      'event-1', 'project-1', 'welcome_dinner', 'Welcome dinner', '2026-06-18',
      'Harbor Room', 'project_source', 'source-1', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_locations (
      id, project_id, type, name, address, city, state, notes, source_type, source_id, created_at, updated_at
    ) VALUES (
      'location-1', 'project-1', 'rehearsal', 'Harbor Room Suite', '10 Harbor Way',
      'Hudson', 'NY', 'Planner confirmed this as the getting-ready room.',
      'project_source', 'source-1', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-CONTEXT', 'partially_paid', 100000, 30000,
      'client_pays', 290, 30, 2930,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, external_payment_id, created_at, updated_at
    ) VALUES (
      'payment-1', 'invoice-1', 'Retainer', 30000, '2026-06-01', 'paid', '2026-06-02T10:00:00.000Z', 'stripe',
      30000, 900, 900, 30900,
      30000, 'pi_context_rest', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO vendors (id, name, normalized_name, created_at, updated_at)
    VALUES ('vendor-1', 'Canon Professional Services', 'canon professional services', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO expenses (
      id, vendor_id, project_id, category, description, amount_cents, status, paid_at,
      payment_method, external_payment_id, tax_deductible, created_at, updated_at
    ) VALUES (
      'expense-1', 'vendor-1', 'project-1', 'equipment', 'Lens calibration', 12500, 'paid', '2026-05-11',
      'amex', 'ch_expense_1', 1, ?, ?
    )
  `).run(now, now);

  const unauthorized = await route.GET(new Request("https://studio.bythereeses.com/api/agent/projects/project-1/context"), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(unauthorized.status, 401);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/agent/projects/project-1/context", {
    headers: { authorization: "Bearer secret" },
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.projectContext.project.id, "project-1");
  assert.deepEqual(body.projectContext.events, [
    {
      id: "event-1",
      type: "welcome_dinner",
      title: "Welcome dinner",
      eventDate: "2026-06-18",
      venueName: "Harbor Room",
      venueAddress: null,
      city: null,
      state: null,
      notes: null,
      sourceType: "project_source",
      sourceId: "source-1",
    },
  ]);
  assert.deepEqual(body.projectContext.locations, [
    {
      id: "location-1",
      type: "rehearsal",
      name: "Harbor Room Suite",
      address: "10 Harbor Way",
      city: "Hudson",
      state: "NY",
      notes: "Planner confirmed this as the getting-ready room.",
      sourceType: "project_source",
      sourceId: "source-1",
    },
  ]);
  assert.equal(body.projectContext.invoices[0].invoiceNumber, "INV-CONTEXT");
  assert.equal(body.projectContext.invoices[0].balanceCents, 72030);
  assert.equal(body.projectContext.invoices[0].clientPayableBalanceCents, 72030);
  assert.equal(body.projectContext.financialSummary.openCents, 0);
  assert.equal(body.projectContext.financialSummary.clientPayableOpenCents, 72030);
  assert.deepEqual(body.projectContext.invoices[0].paymentSummary, {
    scheduledCents: 30000,
    paidCents: 30000,
    grossCollectedCents: 30900,
    clientFeeCents: 900,
    processingFeeCents: 900,
    netDepositCents: 30000,
    openCents: 0,
  });
  assert.equal(body.projectContext.invoices[0].payments[0].externalPaymentId, "pi_context_rest");
  assert.deepEqual(body.projectContext.expenses, [
    {
      id: "expense-1",
      vendorId: "vendor-1",
      vendorName: "Canon Professional Services",
      projectId: "project-1",
      category: "equipment",
      description: "Lens calibration",
      amountCents: 12500,
      status: "paid",
      paidAt: "2026-05-11",
      paymentMethod: "amex",
      externalPaymentId: "ch_expense_1",
      receiptUrl: null,
      taxDeductible: true,
      notes: null,
      sourceType: null,
      sourceId: null,
    },
  ]);

  console.log("agent project context route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
