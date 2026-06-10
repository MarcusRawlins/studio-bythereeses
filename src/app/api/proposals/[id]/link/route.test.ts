import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-proposal-link-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

function form(projectId: string, clientId: string) {
  const formData = new FormData();
  formData.set("projectId", projectId);
  formData.set("clientId", clientId);
  formData.set("label", "Route proposal link");
  return formData;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Proposal Link Route Wedding', 'wedding', 'proposal_sent', 'active', ?, ?),
      ('project-2', 'Wrong Proposal Link Route Wedding', 'wedding', 'proposal_sent', 'active', ?, ?)
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
      'proposal-1', 'project-1', 'Proposal Link Route Package', 'draft', 500000, 'ready', 'Agreement text.', 'not_created', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposal_line_items (id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at)
    VALUES ('line-1', 'proposal-1', 'Wedding coverage', 1, 500000, 0, 0, ?, ?)
  `).run(now, now);

  const originalConsoleError = console.error;
  console.error = () => {};
  const wrongResponse = await POST(new Request("https://studio.test/api/proposals/proposal-1/link", {
    method: "POST",
    body: form("project-2", "client-2"),
  }), { params: Promise.resolve({ id: "proposal-1" }) }).finally(() => {
    console.error = originalConsoleError;
  });

  assert.equal(wrongResponse.status, 400);
  assert.deepEqual(await wrongResponse.json(), { error: "Proposal does not belong to this project." });
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM proposal_access_tokens").get(), { count: 0 });
  assert.equal(database.prepare("SELECT status FROM proposals WHERE id = 'proposal-1'").get().status, "draft");

  const response = await POST(new Request("https://studio.test/api/proposals/proposal-1/link", {
    method: "POST",
    body: form("project-1", "client-1"),
  }), { params: Promise.resolve({ id: "proposal-1" }) });

  assert.equal(response.status, 303);
  const location = response.headers.get("location") ?? "";
  assert.match(location, /^https:\/\/studio\.test\/proposals\/proposal-1\?share=/);
  assert.deepEqual(database.prepare(`
    SELECT proposal_id, project_id, client_id, label
    FROM proposal_access_tokens
  `).get(), {
    proposal_id: "proposal-1",
    project_id: "project-1",
    client_id: "client-1",
    label: "Route proposal link",
  });

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
  console.error = () => {};
  const noContractResponse = await POST(new Request("https://studio.test/api/proposals/proposal-no-contract/link", {
    method: "POST",
    body: form("project-1", "client-1"),
  }), { params: Promise.resolve({ id: "proposal-no-contract" }) }).finally(() => {
    console.error = originalConsoleError;
  });
  assert.equal(noContractResponse.status, 400);
  assert.deepEqual(await noContractResponse.json(), { error: "Proposal contract must be ready before creating a client link." });

  console.log("proposal link route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
