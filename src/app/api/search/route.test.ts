import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-search-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.ORIGIN_PROXY_SECRET = "origin-secret";

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (
      id, name, type, stage, status, event_date, venue_name, city, state, budget_cents, created_at, updated_at
    ) VALUES (
      'project-1', 'Alex and Jordan Wedding', 'wedding', 'planning', 'active', '2026-09-19',
      'The Garden House', 'Hudson', 'NY', 950000, ?, ?
    ), (
      'project-2', 'Maya Corporate Retreat', 'brand', 'inquiry', 'active', '2026-10-10',
      'The Foundry', 'Brooklyn', 'NY', 1200000, ?, ?
    ), (
      'project-orphan', 'Needs Primary Client Wedding', 'wedding', 'inquiry', 'active', '2026-11-11',
      'The Repair Room', 'Beacon', 'NY', 500000, ?, ?
    )
  `).run(now, now, now, now, now, now);

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', '555-0100', ?, ?),
           ('client-2', 'Maya', 'Chen', 'maya@example.com', '555-0101', ?, ?)
  `).run(now, now, now, now);

  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?),
           ('participant-2', 'project-2', 'client-2', 'primary', 1, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_amount_cents, created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-SEARCH-FEE', 'partially_paid', 900000, 300000,
      'client_pays', 26130, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-1', 'invoice-1', 'Retainer', 300000, '2026-06-01', 'paid',
      '2026-06-02T10:00:00.000Z', 'stripe',
      300000, 8730, 8730, 308730,
      300000, ?, ?
    )
  `).run(now, now);

  const blocked = await route.GET(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/search?q=maya"));
  assert.equal(blocked.status, 404);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/search?q=maya&limit=5"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    projects: [
      {
        id: "project-2",
        name: "Maya Corporate Retreat",
        type: "brand",
        stage: "inquiry",
        status: "active",
        eventDate: "2026-10-10",
        venueName: "The Foundry",
        location: "Brooklyn, NY",
        budgetCents: 1200000,
        primaryClient: {
          id: "client-2",
          name: "Maya Chen",
          email: "maya@example.com",
          instagramHandle: null,
          communicationPreference: null,
          referralSource: null,
        },
        clientCount: 1,
        proposalCount: 0,
        invoiceCount: 0,
        openBalanceCents: 0,
      },
    ],
  });

  const balanceResponse = await route.GET(new Request("https://studio.bythereeses.com/api/search?q=alex&limit=5"));
  assert.equal(balanceResponse.status, 200);
  const balancePayload = await balanceResponse.json();
  assert.equal(balancePayload.projects[0].openBalanceCents, 617400);

  const orphanResponse = await route.GET(new Request("https://studio.bythereeses.com/api/search?q=repair&limit=5"));
  assert.equal(orphanResponse.status, 200);
  assert.deepEqual(await orphanResponse.json(), {
    projects: [
      {
        id: "project-orphan",
        name: "Needs Primary Client Wedding",
        type: "wedding",
        stage: "inquiry",
        status: "active",
        eventDate: "2026-11-11",
        venueName: "The Repair Room",
        location: "Beacon, NY",
        budgetCents: 500000,
        primaryClient: null,
        clientCount: 0,
        proposalCount: 0,
        invoiceCount: 0,
        openBalanceCents: 0,
      },
    ],
  });

  console.log("search route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
