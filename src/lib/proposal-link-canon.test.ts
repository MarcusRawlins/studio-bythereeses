import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-proposal-link-canon-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

function linkForm(projectId: string, clientId: string | null = "client-1") {
  const formData = new FormData();
  formData.set("proposalId", "proposal-1");
  formData.set("projectId", projectId);
  if (clientId) formData.set("clientId", clientId);
  formData.set("label", "Client proposal link");
  return formData;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { createProposalLinkFromForm } = await import("./sales");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Proposal Link Wedding', 'wedding', 'proposal_sent', 'active', ?, ?),
      ('project-2', 'Wrong Proposal Link Wedding', 'wedding', 'proposal_sent', 'active', ?, ?)
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
      'proposal-1', 'project-1', 'Proposal Link Package', 'draft', 500000, 'ready', 'Agreement text.', 'not_created', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposal_line_items (id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at)
    VALUES ('line-1', 'proposal-1', 'Wedding coverage', 1, 500000, 0, 0, ?, ?)
  `).run(now, now);

  await assert.rejects(
    () => createProposalLinkFromForm(linkForm("project-2", "client-2")),
    /Proposal does not belong to this project/,
  );
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM proposal_access_tokens").get(), { count: 0 });
  assert.equal(database.prepare("SELECT status FROM proposals WHERE id = 'proposal-1'").get().status, "draft");

  await assert.rejects(
    () => createProposalLinkFromForm(linkForm("project-1", "client-2")),
    /Proposal client is not linked to this project/,
  );
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM proposal_access_tokens").get(), { count: 0 });

  const result = await createProposalLinkFromForm(linkForm("project-1", "client-1"));
  assert.equal(result.proposalId, "proposal-1");
  assert.equal(result.projectId, "project-1");
  assert.match(result.url, /\/proposal\//);

  assert.deepEqual(database.prepare(`
    SELECT proposal_id, project_id, client_id, label
    FROM proposal_access_tokens
  `).get(), {
    proposal_id: "proposal-1",
    project_id: "project-1",
    client_id: "client-1",
    label: "Client proposal link",
  });
  assert.equal(database.prepare("SELECT status FROM proposals WHERE id = 'proposal-1'").get().status, "sent");

  const replacement = await createProposalLinkFromForm(linkForm("project-1", "client-1"));
  assert.equal(replacement.proposalId, "proposal-1");
  assert.match(replacement.url, /\/proposal\//);

  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM proposal_access_tokens
    WHERE proposal_id = 'proposal-1' AND project_id = 'project-1' AND client_id = 'client-1' AND revoked_at IS NULL
  `).get(), { count: 1 });
  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM proposal_access_tokens
    WHERE proposal_id = 'proposal-1' AND project_id = 'project-1' AND client_id = 'client-1' AND revoked_at IS NOT NULL
  `).get(), { count: 1 });

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
  const noContractForm = linkForm("project-1", "client-1");
  noContractForm.set("proposalId", "proposal-no-contract");
  await assert.rejects(
    () => createProposalLinkFromForm(noContractForm),
    /Proposal contract must be ready before creating a client link/,
  );

  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, total_cents, contract_status, contract_body, invoice_status, created_at, updated_at
    ) VALUES (
      'proposal-optional-only', 'project-1', 'Optional Only Package', 'draft', 150000, 'ready', 'Agreement text.', 'not_created', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposal_line_items (id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at)
    VALUES ('line-optional-only', 'proposal-optional-only', 'Engagement session', 1, 150000, 1, 0, ?, ?)
  `).run(now, now);
  const optionalOnlyForm = linkForm("project-1", "client-1");
  optionalOnlyForm.set("proposalId", "proposal-optional-only");
  await assert.rejects(
    () => createProposalLinkFromForm(optionalOnlyForm),
    /Proposal package must include at least one priced required line item/,
  );

  console.log("proposal link canon tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
