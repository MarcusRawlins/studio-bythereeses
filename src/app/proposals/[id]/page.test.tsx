import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-proposal-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: ProposalDetailPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T15:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'proposal_sent', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, package_name, total_cents,
      contract_status, invoice_status, selected_optional_line_item_ids_json,
      signed_at, signer_name, created_at, updated_at
    ) VALUES (
      'proposal-1', 'project-1', 'Alex Wedding Proposal', 'ready', 'Wedding Collection',
      970000, 'ready', 'not_created', NULL, NULL, NULL, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposal_line_items (
      id, proposal_id, name, description, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at
    ) VALUES
      ('included-coverage', 'proposal-1', 'Wedding coverage', 'Eight hours.', 1, 850000, 0, 0, ?, ?),
      ('optional-engagement', 'proposal-1', 'Engagement session', 'Selected by client.', 1, 120000, 0, 1, ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO templates (id, type, name, trigger, subject, body, status, created_at, updated_at)
    VALUES (
      'template-package-1', 'proposal_package', 'Signature Collection',
      'discovery call complete', 'Collection overview',
      'Package summary.', 'active', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    UPDATE proposals
    SET
      status = 'accepted',
      contract_status = 'signed',
      selected_optional_line_item_ids_json = ?,
      signed_at = ?,
      signer_name = 'Alex Taylor',
      updated_at = ?
    WHERE id = 'proposal-1'
  `).run(JSON.stringify(["optional-engagement"]), now, now);

  const markup = renderToStaticMarkup(await ProposalDetailPage({
    params: Promise.resolve({ id: "proposal-1" }),
    searchParams: Promise.resolve({}),
  }));

  assert.match(markup, /Selected add-ons/);
  assert.match(markup, /Engagement session/);
  assert.match(markup, /Selected by client/);
  assert.match(markup, /\$1,200/);
  assert.match(markup, /name="proposalPackageTemplateId"/);
  assert.match(markup, /Signature Collection/);
  assert.match(markup, /Generate invoice from accepted package/);
  assert.match(markup, /name="workflowAction" value="create_invoice"/);

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-orphan', 'Needs Primary Client Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, package_name, total_cents,
      contract_status, invoice_status, created_at, updated_at
    ) VALUES (
      'proposal-orphan', 'project-orphan', 'Orphan Project Proposal', 'draft', 'Repairable Collection',
      500000, 'ready', 'not_created', ?, ?
    )
  `).run(now, now);

  const orphanMarkup = renderToStaticMarkup(await ProposalDetailPage({
    params: Promise.resolve({ id: "proposal-orphan" }),
    searchParams: Promise.resolve({}),
  }));

  assert.match(orphanMarkup, /Orphan Project Proposal/);
  assert.match(orphanMarkup, /Needs Primary Client Wedding · Needs primary client/);
  assert.match(orphanMarkup, /Create invoice/);
  assert.match(orphanMarkup, /Add a primary client before creating a client proposal link/);
  assert.doesNotMatch(orphanMarkup, /name="clientId"/);

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-no-contract', 'No Contract Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-no-contract', 'Nora', 'Client', 'nora@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-no-contract', 'project-no-contract', 'client-no-contract', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, package_name, total_cents,
      contract_status, contract_body, invoice_status, created_at, updated_at
    ) VALUES (
      'proposal-no-contract', 'project-no-contract', 'No Contract Proposal', 'draft', 'Repairable Collection',
      500000, 'ready', NULL, 'not_created', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposal_line_items (
      id, proposal_id, name, description, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at
    ) VALUES (
      'line-no-contract', 'proposal-no-contract', 'Wedding coverage', NULL, 1, 500000, 0, 0, ?, ?
    )
  `).run(now, now);

  const noContractMarkup = renderToStaticMarkup(await ProposalDetailPage({
    params: Promise.resolve({ id: "proposal-no-contract" }),
    searchParams: Promise.resolve({}),
  }));

  assert.match(noContractMarkup, /Add contract language before creating a client proposal link/);
  assert.doesNotMatch(noContractMarkup, /Create client proposal link/);
  assert.doesNotMatch(noContractMarkup, /name="clientId" value="client-no-contract"/);

  console.log("proposal detail page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
