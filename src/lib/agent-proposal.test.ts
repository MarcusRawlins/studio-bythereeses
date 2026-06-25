import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-proposal-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { createProposalFromAgent, updateProposalFromAgent } = await import("./sales");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    UPDATE projects
    SET event_date = '2026-09-19', venue_name = 'The Garden House'
    WHERE id = 'project-1'
  `).run();
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-2', 'Other Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'discovery_call', 'Proposal discovery call',
      'Client wants documentary coverage and a simple payment plan.', 'Proposal source summary', 'Studio UI', ?, ?
    ), (
      'other-source', 'project-2', 'discovery_call', 'Other discovery call',
      'Wrong project source.', 'Wrong source summary', 'Studio UI', ?, ?
    )
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO templates (id, type, name, trigger, subject, body, status, created_at, updated_at)
    VALUES (
      'template-package-1', 'proposal_package', 'Signature Collection Template',
      'discovery call complete', 'Signature Collection',
      'Proposal package for {{client.name}} at {{project.venue_name}} on {{project.event_date}}: {{proposal.total}}.',
      'active', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO templates (id, type, name, trigger, subject, body, status, created_at, updated_at)
    VALUES (
      'template-contract-1', 'contract', 'Wedding Agreement',
      'proposal ready', 'Agreement',
      'Agreement for {{client.name}} and {{project.name}} at {{project.venue_name}}. Package {{proposal.package_name}} for {{proposal.total}}.',
      'active', ?, ?
    )
  `).run(now, now);

  const result = await createProposalFromAgent("project-1", {
    title: "Alex Wedding Proposal",
    proposalPackageTemplateId: "template-package-1",
    validUntil: "2099-06-15",
    contractTemplateId: "template-contract-1",
    lineItems: [
      { name: "Wedding photography coverage", quantity: 1, unitPriceCents: 900000 },
      { name: "Engagement session", quantity: 1, unitPriceCents: 150000, isOptional: true },
    ],
    sourceType: "project_source",
    sourceId: "source-1",
  });

  assert.equal(result.projectId, "project-1");
  assert.equal(result.status, "draft");
  assert.equal(result.totalCents, 900000);
  assert.deepEqual(result.missingFields, ["invoice"]);

  const proposal = database.prepare("SELECT title, package_name, scope_summary, total_cents, contract_status, contract_template_id, contract_title, contract_body, source_type, source_id FROM proposals").get();
  assert.deepEqual(proposal, {
    title: "Alex Wedding Proposal",
    package_name: "Signature Collection",
    scope_summary: "Proposal package for Alex Taylor at The Garden House on 2026-09-19: $9,000.",
    total_cents: 900000,
    contract_status: "ready",
    contract_template_id: "template-contract-1",
    contract_title: "Wedding Agreement",
    contract_body: "Agreement for Alex Taylor and Alex Wedding at The Garden House. Package Signature Collection for $9,000.",
    source_type: "project_source",
    source_id: "source-1",
  });

  const lineItems = database.prepare("SELECT name, is_optional FROM proposal_line_items ORDER BY sort_order").all();
  assert.deepEqual(lineItems, [
    { name: "Wedding photography coverage", is_optional: 0 },
    { name: "Engagement session", is_optional: 1 },
  ]);

  const activity = database.prepare("SELECT action, actor_type FROM activity_logs").all();
  assert.deepEqual(activity, [{ action: "proposal.created_by_agent", actor_type: "agent" }]);

  const updated = await updateProposalFromAgent("project-1", result.proposalId, {
    title: "Alex Wedding Proposal Revised",
    proposalPackageTemplateId: "template-package-1",
    validUntil: "2099-06-30",
    scopeSummary: null,
    contractTemplateId: "template-contract-1",
    contractBody: null,
    lineItems: [
      { name: "Wedding photography coverage", quantity: 1, unitPriceCents: 950000 },
      { name: "Rehearsal dinner coverage", quantity: 1, unitPriceCents: 125000 },
    ],
    sourceType: "project_source",
    sourceId: "source-1",
  });

  assert.equal(updated.proposalId, result.proposalId);
  assert.equal(updated.projectId, "project-1");
  assert.equal(updated.status, "draft");
  assert.equal(updated.totalCents, 1075000);
  assert.deepEqual(updated.missingFields, ["invoice"]);

  const updatedProposal = database.prepare(`
    SELECT title, package_name, valid_until, scope_summary, total_cents, contract_status, contract_template_id, contract_title, contract_body, source_type, source_id
    FROM proposals
    WHERE id = ?
  `).get(result.proposalId);
  assert.deepEqual(updatedProposal, {
    title: "Alex Wedding Proposal Revised",
    package_name: "Signature Collection",
    valid_until: "2099-06-30",
    scope_summary: "Proposal package for Alex Taylor at The Garden House on 2026-09-19: $10,750.",
    total_cents: 1075000,
    contract_status: "ready",
    contract_template_id: "template-contract-1",
    contract_title: "Wedding Agreement",
    contract_body: "Agreement for Alex Taylor and Alex Wedding at The Garden House. Package Signature Collection for $10,750.",
    source_type: "project_source",
    source_id: "source-1",
  });

  const updatedLineItems = database.prepare("SELECT name, unit_price_cents, is_optional, sort_order FROM proposal_line_items WHERE proposal_id = ? ORDER BY sort_order").all(result.proposalId);
  assert.deepEqual(updatedLineItems, [
    { name: "Wedding photography coverage", unit_price_cents: 950000, is_optional: 0, sort_order: 0 },
    { name: "Rehearsal dinner coverage", unit_price_cents: 125000, is_optional: 0, sort_order: 1 },
  ]);

  const updatedActivity = database.prepare("SELECT action, actor_type FROM activity_logs ORDER BY created_at, rowid").all();
  assert.deepEqual(updatedActivity, [
    { action: "proposal.created_by_agent", actor_type: "agent" },
    { action: "proposal.updated_by_agent", actor_type: "agent" },
  ]);

  await assert.rejects(
    () => createProposalFromAgent("missing-project", { title: "Missing", lineItems: [] }),
    /Project not found/,
  );
  await assert.rejects(
    () => createProposalFromAgent("project-1", {
      title: "Wrong source proposal",
      lineItems: [{ name: "Coverage", unitPriceCents: 100000 }],
      sourceType: "project_source",
      sourceId: "other-source",
    }),
    /Project source not found/,
  );
  await assert.rejects(
    () => updateProposalFromAgent("project-1", result.proposalId, {
      title: "Wrong source update",
      sourceType: "project_source",
      sourceId: "other-source",
    }),
    /Project source not found/,
  );
  await assert.rejects(
    () => createProposalFromAgent("project-1", {
      title: "Half-linked proposal",
      lineItems: [{ name: "Coverage", unitPriceCents: 100000 }],
      sourceId: "source-1",
    }),
    /Project source links require sourceType when sourceId is set/,
  );
  const unlinkedProposal = await createProposalFromAgent("project-1", {
    title: "Unlinked proposal",
    lineItems: [{ name: "Coverage", unitPriceCents: 100000 }],
  });
  await assert.rejects(
    () => updateProposalFromAgent("project-1", unlinkedProposal.proposalId, {
      sourceId: "source-1",
    }),
    /Project source links require sourceType when sourceId is set/,
  );
  await assert.rejects(
    () => updateProposalFromAgent("project-2", result.proposalId, { title: "Wrong project" }),
    /Proposal not found/,
  );

  database.prepare("UPDATE proposals SET status = 'accepted', accepted_at = ? WHERE id = ?").run(now, result.proposalId);
  await assert.rejects(
    () => updateProposalFromAgent("project-1", result.proposalId, { title: "After acceptance" }),
    /Accepted or signed proposals cannot be updated by agent/,
  );

  console.log("agent proposal tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
