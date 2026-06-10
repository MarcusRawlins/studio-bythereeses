import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-studio-mcp-client-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { handleStudioMcpMessage } = await import("./studio-mcp");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, preferred_name, notes, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', '555-0100', 'Alex', 'Old note', ?, ?)
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

  const list = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  assert.ok(
    (list?.result?.tools as Array<{ name: string }>).some((tool) => tool.name === "studio_update_client"),
    "MCP tool list should expose canonical client updates",
  );
  assert.ok(
    (list?.result?.tools as Array<{ name: string }>).some((tool) => tool.name === "studio_get_client_context"),
    "MCP tool list should expose canonical client context reads",
  );

  const clientContextResponse = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: {
      name: "studio_get_client_context",
      arguments: { clientId: "client-1" },
    },
  });
  assert.equal(clientContextResponse?.error, undefined);
  const clientContextPayload = clientContextResponse?.result?.structuredContent as {
    clientContext: {
      client: { id: string; email: string };
      projects: Array<{ project: { id: string } }>;
      invoices: Array<{ id: string; openBalanceCents: number; nextPaymentDueDate: string | null }>;
    };
  };
  assert.equal(clientContextPayload.clientContext.client.id, "client-1");
  assert.equal(clientContextPayload.clientContext.client.email, "alex@example.com");
  assert.deepEqual(clientContextPayload.clientContext.projects.map((row) => row.project.id), ["project-1"]);
  assert.deepEqual(clientContextPayload.clientContext.invoices.map((invoice) => ({
    id: invoice.id,
    openBalanceCents: invoice.openBalanceCents,
    nextPaymentDueDate: invoice.nextPaymentDueDate,
  })), [{
    id: "invoice-1",
    openBalanceCents: 617400,
    nextPaymentDueDate: "2026-08-19",
  }]);

  const response = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "studio_update_client",
      arguments: {
        clientId: "client-1",
        firstName: "Alexandra",
        email: "LEX@EXAMPLE.COM",
        phone: "555-0199",
        instagramHandle: "lex.reese",
        communicationPreference: "Email for contracts; text for logistics.",
        referralSource: "Planner referral",
      },
    },
  });

  assert.equal(response?.error, undefined);
  const payload = response?.result?.structuredContent as {
    client: {
      id: string;
      firstName: string;
      email: string;
      phone: string | null;
      instagramHandle: string | null;
      communicationPreference: string | null;
      referralSource: string | null;
    };
  };
  assert.equal(payload.client.id, "client-1");
  assert.equal(payload.client.firstName, "Alexandra");
  assert.equal(payload.client.email, "lex@example.com");
  assert.equal(payload.client.phone, "555-0199");
  assert.equal(payload.client.instagramHandle, "@lex.reese");
  assert.equal(payload.client.communicationPreference, "Email for contracts; text for logistics.");
  assert.equal(payload.client.referralSource, "Planner referral");

  const context = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "studio_get_project_context",
      arguments: { projectId: "project-1" },
    },
  });
  const projectContext = context?.result?.structuredContent as {
    projectContext: { clients: Array<{ firstName: string; email: string; instagramHandle: string | null }> };
  };
  assert.equal(projectContext.projectContext.clients[0].firstName, "Alexandra");
  assert.equal(projectContext.projectContext.clients[0].email, "lex@example.com");
  assert.equal(projectContext.projectContext.clients[0].instagramHandle, "@lex.reese");

  console.log("studio mcp client tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
