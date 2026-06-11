import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-proposal-link-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";
process.env.NEXT_PUBLIC_APP_URL = "https://studio.bythereeses.com";

function request(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Agent Proposal Link Wedding', 'wedding', 'proposal_sent', 'active', ?, ?),
      ('project-2', 'Other Agent Proposal Link Wedding', 'wedding', 'proposal_sent', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-1', 'Avery', 'Stone', 'avery@example.com', ?, ?),
      ('client-2', 'Wrong', 'Client', 'wrong@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-1', 'project-1', 'client-1', 'primary', 1, ?),
      ('participant-2', 'project-2', 'client-2', 'primary', 1, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, total_cents, contract_status, contract_body, invoice_status, created_at, updated_at
    ) VALUES (
      'proposal-1', 'project-1', 'Agent Proposal Link Package', 'draft', 500000, 'ready', 'Agreement text.', 'not_created', ?, ?
    ), (
      'proposal-2', 'project-2', 'Other Agent Proposal Link Package', 'draft', 400000, 'ready', 'Agreement text.', 'not_created', ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO proposal_line_items (id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at)
    VALUES
      ('line-1', 'proposal-1', 'Wedding coverage', 1, 500000, 0, 0, ?, ?),
      ('line-2', 'proposal-2', 'Wedding coverage', 1, 400000, 0, 0, ?, ?)
  `).run(now, now, now, now);

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects/project-1/proposals/proposal-1/link", {
    method: "POST",
    body: JSON.stringify({ clientId: "client-1" }),
  }), {
    params: Promise.resolve({ id: "project-1", proposalId: "proposal-1" }),
  });
  assert.equal(unauthorized.status, 401);

  const wrongProject = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/proposals/proposal-2/link", {
    method: "POST",
    body: JSON.stringify({ clientId: "client-1" }),
  }), {
    params: Promise.resolve({ id: "project-1", proposalId: "proposal-2" }),
  });
  assert.equal(wrongProject.status, 400);
  assert.deepEqual(await wrongProject.json(), { error: "Proposal does not belong to this project." });
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM proposal_access_tokens").get(), { count: 0 });

  const response = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/proposals/proposal-1/link", {
    method: "POST",
    body: JSON.stringify({
      clientId: "client-1",
      label: "Agent-created client proposal link",
    }),
  }), {
    params: Promise.resolve({ id: "project-1", proposalId: "proposal-1" }),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.link.proposalId, "proposal-1");
  assert.equal(body.link.projectId, "project-1");
  assert.equal(body.link.clientId, "client-1");
  assert.match(body.link.url, /^https:\/\/studio\.bythereeses\.com\/proposal\//);

  assert.deepEqual(database.prepare(`
    SELECT proposal_id, project_id, client_id, label, length(token_hash) AS hash_length, revoked_at
    FROM proposal_access_tokens
  `).get(), {
    proposal_id: "proposal-1",
    project_id: "project-1",
    client_id: "client-1",
    label: "Agent-created client proposal link",
    hash_length: 64,
    revoked_at: null,
  });
  assert.equal(database.prepare("SELECT status FROM proposals WHERE id = 'proposal-1'").get().status, "sent");
  assert.equal(database.prepare("SELECT action FROM activity_logs ORDER BY created_at DESC LIMIT 1").get().action, "proposal.link_created");

  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, total_cents, contract_status, contract_body, invoice_status, created_at, updated_at
    ) VALUES (
      'proposal-no-contract', 'project-1', 'No Contract Package', 'draft', 500000, 'ready', NULL, 'not_created', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposal_line_items (id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at)
    VALUES ('line-no-contract', 'proposal-no-contract', 'Wedding coverage', 1, 500000, 0, 0, ?, ?)
  `).run(now, now);
  const noContract = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/proposals/proposal-no-contract/link", {
    method: "POST",
    body: JSON.stringify({ clientId: "client-1" }),
  }), {
    params: Promise.resolve({ id: "project-1", proposalId: "proposal-no-contract" }),
  });
  assert.equal(noContract.status, 400);
  assert.deepEqual(await noContract.json(), { error: "Proposal contract must be ready before creating a client link." });

  console.log("agent proposal link route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
