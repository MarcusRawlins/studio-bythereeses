import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-proposal-canon-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

function proposalForm(projectId: string) {
  const formData = new FormData();
  formData.set("proposalId", "proposal-1");
  formData.set("projectId", projectId);
  formData.set("title", "Updated Proposal");
  formData.set("packageName", "Updated Package");
  formData.set("lineItemName", "Updated coverage");
  formData.set("lineItemQuantity", "1");
  formData.set("lineItemUnitPrice", "6000");
  formData.set("scopeSummary", "Updated scope.");
  return formData;
}

function templatedContractProposalForm(projectId: string) {
  const formData = proposalForm(projectId);
  formData.set("title", "Rendered Template Proposal");
  formData.set("packageName", "Signature Collection");
  formData.set("contractTemplateId", "template-contract-1");
  formData.set("lineItemUnitPrice", "9000");
  return formData;
}

function workflowForm(projectId: string, action: string) {
  const formData = new FormData();
  formData.set("proposalId", "proposal-1");
  formData.set("projectId", projectId);
  formData.set("workflowAction", action);
  return formData;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { updateProposalFromForm, updateProposalWorkflowFromForm } = await import("./sales");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Canonical Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Wrong Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    UPDATE projects
    SET event_date = '2026-09-19',
      venue_name = 'The Garden House',
      venue_address = '1 Garden Lane',
      city = 'Hudson',
      state = 'NY'
    WHERE id = 'project-1'
  `).run();
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, preferred_name, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', '555-0100', 'Alex', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO templates (id, type, name, trigger, body, status, created_at, updated_at)
    VALUES (
      'template-contract-1',
      'contract',
      'Wedding Agreement',
      'Proposal ready',
      'Agreement for {{client.name}} and {{project.name}} at {{project.venue_name}} on {{project.event_date}}. Package: {{proposal.package_name}} for {{proposal.total}}.',
      'active',
      ?,
      ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, package_name, total_cents, contract_status, invoice_status, created_at, updated_at
    ) VALUES (
      'proposal-1', 'project-1', 'Original Proposal', 'draft', 'Original Package', 500000, 'ready', 'not_created', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposal_line_items (
      id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at
    ) VALUES (
      'line-1', 'proposal-1', 'Original coverage', 1, 500000, 0, 0, ?, ?
    )
  `).run(now, now);

  await assert.rejects(
    () => updateProposalFromForm(proposalForm("project-2")),
    /Proposal does not belong to this project/,
  );

  assert.deepEqual(database.prepare(`
    SELECT title, package_name, total_cents, status
    FROM proposals
    WHERE id = 'proposal-1'
  `).get(), {
    title: "Original Proposal",
    package_name: "Original Package",
    total_cents: 500000,
    status: "draft",
  });

  assert.deepEqual(database.prepare(`
    SELECT name, unit_price_cents
    FROM proposal_line_items
    WHERE proposal_id = 'proposal-1'
  `).all(), [
    { name: "Original coverage", unit_price_cents: 500000 },
  ]);

  await assert.rejects(
    () => updateProposalWorkflowFromForm(workflowForm("project-2", "send")),
    /Proposal does not belong to this project/,
  );

  assert.deepEqual(database.prepare(`
    SELECT status, sent_at
    FROM proposals
    WHERE id = 'proposal-1'
  `).get(), {
    status: "draft",
    sent_at: null,
  });

  const result = await updateProposalFromForm(proposalForm("project-1"));
  assert.deepEqual(result, { proposalId: "proposal-1", projectId: "project-1" });
  assert.deepEqual(database.prepare(`
    SELECT title, package_name, total_cents
    FROM proposals
    WHERE id = 'proposal-1'
  `).get(), {
    title: "Updated Proposal",
    package_name: "Updated Package",
    total_cents: 600000,
  });

  await updateProposalFromForm(templatedContractProposalForm("project-1"));
  assert.deepEqual(database.prepare(`
    SELECT contract_template_id, contract_title, contract_body, total_cents
    FROM proposals
    WHERE id = 'proposal-1'
  `).get(), {
    contract_template_id: "template-contract-1",
    contract_title: "Wedding Agreement",
    contract_body: "Agreement for Alex Taylor and Canonical Wedding at The Garden House on 2026-09-19. Package: Signature Collection for $9,000.",
    total_cents: 900000,
  });

  const workflowResult = await updateProposalWorkflowFromForm(workflowForm("project-1", "send"));
  assert.deepEqual(workflowResult, { proposalId: "proposal-1", projectId: "project-1" });
  assert.equal(database.prepare("SELECT status FROM proposals WHERE id = 'proposal-1'").get().status, "sent");

  database.prepare(`
    UPDATE proposals
    SET status = 'accepted', contract_status = 'signed', accepted_at = ?, signed_at = ?
    WHERE id = 'proposal-1'
  `).run(now, now);

  await assert.rejects(
    () => updateProposalFromForm(proposalForm("project-1")),
    /Accepted or signed proposals cannot be edited/,
  );
  await assert.rejects(
    () => updateProposalWorkflowFromForm(workflowForm("project-1", "reset_draft")),
    /Accepted or signed proposals cannot be moved back to draft/,
  );
  assert.deepEqual(database.prepare(`
    SELECT title, package_name, total_cents, status, contract_status
    FROM proposals
    WHERE id = 'proposal-1'
  `).get(), {
    title: "Rendered Template Proposal",
    package_name: "Signature Collection",
    total_cents: 900000,
    status: "accepted",
    contract_status: "signed",
  });

  console.log("proposal canon tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
