import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-client-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "agent-token";

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getStudioProjectContext } = await import("@/lib/studio-mcp");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (
      id, first_name, last_name, email, phone, preferred_name,
      instagram_handle, communication_preference, referral_source, notes,
      created_at, updated_at
    )
    VALUES (
      'client-1', 'Alex', 'Taylor', 'alex@example.com', '555-0100', 'Alex',
      '@alexold', 'Email preferred', 'HoneyBook import', 'Old note',
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-2', 'Alex Anniversary', 'portrait', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-2', 'project-2', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO proposals (id, project_id, title, status, total_cents, created_at, updated_at)
    VALUES ('proposal-1', 'project-1', 'Alex Proposal', 'sent', 900000, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, proposal_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    )
    VALUES (
      'invoice-1', 'project-1', 'proposal-1', 'INV-ALEX', 'sent', 900000, 300000,
      'client_pays', 290, 30, 26130,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents,
      created_at, updated_at
    ) VALUES (
      'payment-paid', 'invoice-1', 'Retainer', 300000, '2026-06-15', 'paid',
      '2026-06-15T14:00:00.000Z', 'stripe',
      300000, 8730, 8730, 308730, 300000,
      ?, ?
    ), (
      'payment-final', 'invoice-1', 'Balance', 600000, '2026-08-19', 'pending',
      NULL, NULL,
      0, 0, 0, 0, 0,
      ?, ?
    )
  `).run(now, now, now, now);

  const contextResponse = await route.GET(new Request("https://studio.bythereeses.com/api/agent/clients/client-1", {
    method: "GET",
    headers: { authorization: "Bearer agent-token" },
  }), {
    params: Promise.resolve({ id: "client-1" }),
  });
  assert.equal(contextResponse.status, 200);
  const contextBody = await contextResponse.json() as {
    clientContext: {
      client: {
        id: string;
        email: string;
        instagramHandle: string | null;
        communicationPreference: string | null;
        referralSource: string | null;
      };
      projects: Array<{ project: { id: string } }>;
      proposals: Array<{ id: string; projectName: string }>;
      invoices: Array<{ id: string; openBalanceCents: number; nextPaymentDueDate: string | null }>;
    };
  };
  assert.equal(contextBody.clientContext.client.id, "client-1");
  assert.equal(contextBody.clientContext.client.email, "alex@example.com");
  assert.equal(contextBody.clientContext.client.instagramHandle, "@alexold");
  assert.equal(contextBody.clientContext.client.communicationPreference, "Email preferred");
  assert.equal(contextBody.clientContext.client.referralSource, "HoneyBook import");
  assert.deepEqual(contextBody.clientContext.projects.map((row) => row.project.id), ["project-1", "project-2"]);
  assert.deepEqual(contextBody.clientContext.proposals.map((proposal) => proposal.id), ["proposal-1"]);
  assert.deepEqual(contextBody.clientContext.invoices.map((invoice) => ({
    id: invoice.id,
    openBalanceCents: invoice.openBalanceCents,
    nextPaymentDueDate: invoice.nextPaymentDueDate,
  })), [{
    id: "invoice-1",
    openBalanceCents: 617400,
    nextPaymentDueDate: "2026-08-19",
  }]);

  const response = await route.PATCH(new Request("https://studio.bythereeses.com/api/agent/clients/client-1", {
    method: "PATCH",
    headers: {
      authorization: "Bearer agent-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      firstName: "Alexandra",
      email: "LEX@EXAMPLE.COM",
      phone: "555-0199",
      instagramHandle: "lex.reese",
      communicationPreference: "Text for logistics; email for contracts.",
      referralSource: "Planner referral",
    }),
  }), {
    params: Promise.resolve({ id: "client-1" }),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    client: {
      id: string;
      firstName: string;
      email: string;
      phone: string | null;
      instagramHandle: string | null;
      communicationPreference: string | null;
      referralSource: string | null;
    };
    linkedProjectIds?: string[];
  };
  assert.equal(body.client.id, "client-1");
  assert.equal(body.client.firstName, "Alexandra");
  assert.equal(body.client.email, "lex@example.com");
  assert.equal(body.client.phone, "555-0199");
  assert.equal(body.client.instagramHandle, "@lex.reese");
  assert.equal(body.client.communicationPreference, "Text for logistics; email for contracts.");
  assert.equal(body.client.referralSource, "Planner referral");
  assert.deepEqual(body.linkedProjectIds, ["project-1", "project-2"]);

  const projectContext = await getStudioProjectContext("project-1");
  assert.equal(projectContext.clients[0].firstName, "Alexandra");
  assert.equal(projectContext.clients[0].email, "lex@example.com");
  assert.equal(projectContext.clients[0].instagramHandle, "@lex.reese");
  const secondProjectContext = await getStudioProjectContext("project-2");
  assert.equal(secondProjectContext.clients[0].firstName, "Alexandra");
  assert.equal(secondProjectContext.clients[0].email, "lex@example.com");
  assert.equal(secondProjectContext.clients[0].instagramHandle, "@lex.reese");

  const unauthorized = await route.PATCH(new Request("https://studio.bythereeses.com/api/agent/clients/client-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Nope" }),
  }), {
    params: Promise.resolve({ id: "client-1" }),
  });
  assert.equal(unauthorized.status, 401);

  const unauthorizedRead = await route.GET(new Request("https://studio.bythereeses.com/api/agent/clients/client-1", {
    method: "GET",
  }), {
    params: Promise.resolve({ id: "client-1" }),
  });
  assert.equal(unauthorizedRead.status, 401);

  console.log("agent client route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
