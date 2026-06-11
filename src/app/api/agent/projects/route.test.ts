import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-project-search-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, venue_name, city, state, budget_cents, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', '2026-09-19', 'The Garden House', 'Hudson', 'NY', 850000, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, venue_name, city, state, budget_cents, created_at, updated_at)
    VALUES ('project-orphan', 'Orphan Project', 'wedding', 'inquiry', 'active', '2026-08-08', 'No Client Hall', 'Beacon', 'NY', 500000, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-bailey', 'Bailey', 'Bickley', 'bailey@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_amount_cents, created_at, updated_at
    )
    VALUES ('invoice-1', 'project-1', 'INV-1', 'sent', 850000, 250000, 'client_pays', 24680, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-1', 'invoice-1', 'Retainer', 250000, 'paid', '2026-05-29T13:00:00.000Z', 'stripe',
      250000, 7280, 7280, 257280,
      250000, ?, ?
    )
  `).run(now, now);

  const unauthorized = await route.GET(new Request("https://studio.bythereeses.com/api/agent/projects?q=alex"));
  assert.equal(unauthorized.status, 401);

  const unauthorizedCreate = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects", {
    method: "POST",
    body: JSON.stringify({
      name: "Unauthorized Project",
      primaryClient: { firstName: "Nope", email: "nope@example.com" },
    }),
  }));
  assert.equal(unauthorizedCreate.status, 401);

  const createResponse = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects", {
    method: "POST",
    headers: { authorization: "Bearer secret" },
    body: JSON.stringify({
      name: "Morgan and Riley Wedding",
      type: "wedding",
      stage: "inquiry",
      status: "active",
      eventDate: "2026-11-07",
      venueName: "Stone Mill",
      venueAddress: "12 River Road",
      city: "Beacon",
      state: "NY",
      budgetCents: 1200000,
      notes: "Created from inquiry call.",
      primaryClient: {
        firstName: "Morgan",
        lastName: "Lee",
        preferredName: "Morgan",
        email: "morgan@example.com",
        phone: "555-0199",
        instagramHandle: "morganlee",
        communicationPreference: "Email for contracts; text for timeline logistics.",
        referralSource: "Planner referral",
        role: "bride",
      },
      intakeSource: {
        kind: "discovery_call",
        title: "Morgan inquiry call",
        body: "Morgan and Riley want a documentary wedding proposal and calm timeline.",
        summary: "Inquiry notes for project intake.",
        occurredAt: "2026-05-29T13:00:00.000Z",
        externalUrl: "r2://calls/morgan-inquiry.txt",
        sourceType: "call_transcript",
        sourceId: "call-morgan-1",
      },
    }),
  }));
  assert.equal(createResponse.status, 201);
  const createBody = await createResponse.json();
  assert.equal(createBody.project.name, "Morgan and Riley Wedding");
  assert.equal(createBody.project.primaryClient.email, "morgan@example.com");
  assert.equal(createBody.project.intakeSource.kind, "discovery_call");
  assert.equal(createBody.project.sourceType, "project_source");
  assert.equal(createBody.project.sourceId, createBody.project.intakeSource.id);

  const createdProject = database.prepare(`
    SELECT name, type, stage, status, event_date, venue_name, venue_address, city, state, budget_cents, notes
    FROM projects
    WHERE id = ?
  `).get(createBody.project.id);
  assert.deepEqual(createdProject, {
    name: "Morgan and Riley Wedding",
    type: "wedding",
    stage: "inquiry",
    status: "active",
    event_date: "2026-11-07",
    venue_name: "Stone Mill",
    venue_address: "12 River Road",
    city: "Beacon",
    state: "NY",
    budget_cents: 1200000,
    notes: "Created from inquiry call.",
  });

  assert.equal(createBody.project.primaryClient.instagramHandle, "@morganlee");
  assert.equal(createBody.project.primaryClient.communicationPreference, "Email for contracts; text for timeline logistics.");
  assert.equal(createBody.project.primaryClient.referralSource, "Planner referral");

  const createdClient = database.prepare(`
    SELECT first_name, last_name, preferred_name, email, phone, instagram_handle, communication_preference, referral_source
    FROM clients
    WHERE id = ?
  `).get(createBody.project.primaryClient.id);
  assert.deepEqual(createdClient, {
    first_name: "Morgan",
    last_name: "Lee",
    preferred_name: "Morgan",
    email: "morgan@example.com",
    phone: "555-0199",
    instagram_handle: "@morganlee",
    communication_preference: "Email for contracts; text for timeline logistics.",
    referral_source: "Planner referral",
  });

  assert.deepEqual(database.prepare(`
    SELECT role, is_primary_contact
    FROM project_participants
    WHERE project_id = ? AND client_id = ?
  `).get(createBody.project.id, createBody.project.primaryClient.id), {
    role: "bride",
    is_primary_contact: 1,
  });

  assert.deepEqual(database.prepare(`
    SELECT type, title, event_date, venue_name, venue_address, city, state
    FROM project_events
    WHERE project_id = ?
  `).get(createBody.project.id), {
    type: "wedding",
    title: "Wedding day",
    event_date: "2026-11-07",
    venue_name: "Stone Mill",
    venue_address: "12 River Road",
    city: "Beacon",
    state: "NY",
  });

  assert.deepEqual(database.prepare(`
    SELECT project_id, kind, title, body, summary, occurred_at, external_url, captured_by, source_type, source_id
    FROM project_sources
    WHERE id = ?
  `).get(createBody.project.intakeSource.id), {
    project_id: createBody.project.id,
    kind: "discovery_call",
    title: "Morgan inquiry call",
    body: "Morgan and Riley want a documentary wedding proposal and calm timeline.",
    summary: "Inquiry notes for project intake.",
    occurred_at: "2026-05-29T13:00:00.000Z",
    external_url: "r2://calls/morgan-inquiry.txt",
    captured_by: "The Reeses Studio Agent",
    source_type: "call_transcript",
    source_id: "call-morgan-1",
  });

  assert.deepEqual(database.prepare(`
    SELECT action, actor_type, actor_name
    FROM activity_logs
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(createBody.project.id), {
    action: "project.created_by_agent",
    actor_type: "agent",
    actor_name: "The Reeses Studio Agent",
  });

  const reuseResponse = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects", {
    method: "POST",
    headers: { authorization: "Bearer secret" },
    body: JSON.stringify({
      name: "Morgan Engagement Session",
      type: "portrait",
      primaryClient: {
        firstName: "Morgan Edited",
        lastName: "Lee",
        email: "MORGAN@example.com",
        phone: "555-0000",
      },
    }),
  }));
  assert.equal(reuseResponse.status, 201);
  const reuseBody = await reuseResponse.json();
  assert.equal(reuseBody.project.primaryClient.id, createBody.project.primaryClient.id);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM clients WHERE email = 'morgan@example.com'").get().count,
    1,
  );
  assert.deepEqual(database.prepare(`
    SELECT first_name, phone
    FROM clients
    WHERE id = ?
  `).get(createBody.project.primaryClient.id), {
    first_name: "Morgan",
    phone: "555-0199",
  });

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, preferred_name, created_at, updated_at)
    VALUES ('client-legacy', 'Legacy', 'Client', 'legacy@example.com', '555-0200', 'Legacy', ?, ?)
  `).run(now, now);

  const legacyReuseResponse = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects", {
    method: "POST",
    headers: { authorization: "Bearer secret" },
    body: JSON.stringify({
      name: "Legacy Client Wedding",
      primaryClient: {
        firstName: "Legacy Edited",
        lastName: "Client",
        email: "legacy@example.com",
        phone: "555-0300",
      },
    }),
  }));
  assert.equal(legacyReuseResponse.status, 201);
  const legacyReuseBody = await legacyReuseResponse.json();
  assert.equal(legacyReuseBody.project.primaryClient.id, "client-legacy");
  assert.deepEqual(database.prepare(`
    SELECT id, email, phone
    FROM clients
    WHERE lower(trim(email)) = 'legacy@example.com'
  `).all(), [
    { id: "client-legacy", email: "legacy@example.com", phone: "555-0200" },
  ]);

  const existingClientResponse = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects", {
    method: "POST",
    headers: { authorization: "Bearer secret" },
    body: JSON.stringify({
      name: "Bailey and Parker Wedding",
      type: "wedding",
      eventDate: "2027-05-15",
      budgetCents: 750000,
      primaryClient: {
        clientId: "client-bailey",
        role: "bride",
      },
    }),
  }));
  assert.equal(existingClientResponse.status, 201);
  const existingClientBody = await existingClientResponse.json();
  assert.equal(existingClientBody.project.primaryClient.id, "client-bailey");
  assert.equal(existingClientBody.project.primaryClient.email, "bailey@example.com");
  assert.deepEqual(database.prepare(`
    SELECT role, is_primary_contact
    FROM project_participants
    WHERE project_id = ? AND client_id = 'client-bailey'
  `).get(existingClientBody.project.id), {
    role: "bride",
    is_primary_contact: 1,
  });

  const enrichExistingResponse = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects", {
    method: "POST",
    headers: { authorization: "Bearer secret" },
    body: JSON.stringify({
      name: "Alex Rehearsal Dinner",
      type: "rehearsal",
      primaryClient: {
        firstName: "Alexandra",
        lastName: "Taylor",
        preferredName: "Alex",
        email: "ALEX@example.com",
        phone: "555-0144",
      },
    }),
  }));
  assert.equal(enrichExistingResponse.status, 201);
  const enrichExistingBody = await enrichExistingResponse.json();
  assert.equal(enrichExistingBody.project.primaryClient.id, "client-1");
  assert.deepEqual(database.prepare(`
    SELECT first_name, last_name, preferred_name, email, phone
    FROM clients
    WHERE id = 'client-1'
  `).get(), {
    first_name: "Alex",
    last_name: "Taylor",
    preferred_name: "Alex",
    email: "alex@example.com",
    phone: "555-0144",
  });

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/agent/projects?q=Garden&limit=5", {
    headers: { authorization: "Bearer secret" },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.pagination, {
    totalCount: 7,
    filteredCount: 1,
    currentPage: 1,
    totalPages: 1,
    pageSize: 5,
    rangeStart: 1,
    rangeEnd: 1,
  });
  assert.deepEqual(body.projects, [
    {
      id: "project-1",
      name: "Alex Wedding",
      type: "wedding",
      stage: "planning",
      status: "active",
      eventDate: "2026-09-19",
      venueName: "The Garden House",
      location: "Hudson, NY",
      budgetCents: 850000,
      primaryClient: {
        id: "client-1",
        name: "Alex Taylor",
        email: "alex@example.com",
        instagramHandle: null,
        communicationPreference: null,
        referralSource: null,
      },
      clientCount: 1,
      proposalCount: 0,
      invoiceCount: 1,
      openBalanceCents: 617400,
    },
  ]);

  const orphanResponse = await route.GET(new Request("https://studio.bythereeses.com/api/agent/projects?q=orphan&limit=5&page=2", {
    headers: { authorization: "Bearer secret" },
  }));
  assert.equal(orphanResponse.status, 200);
  const orphanBody = await orphanResponse.json();
  assert.deepEqual(orphanBody.pagination, {
    totalCount: 7,
    filteredCount: 1,
    currentPage: 1,
    totalPages: 1,
    pageSize: 5,
    rangeStart: 1,
    rangeEnd: 1,
  });
  assert.deepEqual(orphanBody.projects, [
    {
      id: "project-orphan",
      name: "Orphan Project",
      type: "wedding",
      stage: "inquiry",
      status: "active",
      eventDate: "2026-08-08",
      venueName: "No Client Hall",
      location: "Beacon, NY",
      budgetCents: 500000,
      primaryClient: null,
      clientCount: 0,
      proposalCount: 0,
      invoiceCount: 0,
      openBalanceCents: 0,
    },
  ]);

  console.log("agent project search route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
