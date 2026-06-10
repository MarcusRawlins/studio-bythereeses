import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-proposal-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
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
    INSERT INTO templates (id, type, name, trigger, subject, body, status, created_at, updated_at)
    VALUES (
      'template-package-1', 'proposal_package', 'Signature Collection Template',
      'discovery call complete', 'Signature Collection',
      'Updated package for {{client.name}} at {{project.venue_name}} on {{project.event_date}}: {{proposal.total}}.',
      'active', ?, ?
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

  const wrongForm = new FormData();
  wrongForm.set("projectId", "project-2");
  wrongForm.set("title", "Wrong Project Update");
  wrongForm.set("lineItemName", "Wrong item");
  wrongForm.set("lineItemQuantity", "1");
  wrongForm.set("lineItemUnitPrice", "7000");

  const originalConsoleError = console.error;
  console.error = () => {};
  const wrongResponse = await POST(new Request("https://studio.test/api/proposals/proposal-1", {
    method: "POST",
    body: wrongForm,
  }), { params: Promise.resolve({ id: "proposal-1" }) }).finally(() => {
    console.error = originalConsoleError;
  });

  assert.equal(wrongResponse.status, 400);
  assert.deepEqual(await wrongResponse.json(), { error: "Proposal does not belong to this project." });
  assert.deepEqual(database.prepare(`
    SELECT title, total_cents
    FROM proposals
    WHERE id = 'proposal-1'
  `).get(), { title: "Original Proposal", total_cents: 500000 });
  assert.deepEqual(database.prepare(`
    SELECT name, unit_price_cents
    FROM proposal_line_items
    WHERE proposal_id = 'proposal-1'
  `).all(), [{ name: "Original coverage", unit_price_cents: 500000 }]);

  const formData = new FormData();
  formData.set("projectId", "project-1");
  formData.set("title", "Canonical Update");
  formData.set("proposalPackageTemplateId", "template-package-1");
  formData.set("lineItemName", "Updated coverage");
  formData.set("lineItemQuantity", "1");
  formData.set("lineItemUnitPrice", "6500");

  const response = await POST(new Request("https://studio.test/api/proposals/proposal-1", {
    method: "POST",
    body: formData,
  }), { params: Promise.resolve({ id: "proposal-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.test/proposals/proposal-1");
  assert.deepEqual(database.prepare(`
    SELECT title, package_name, scope_summary, total_cents
    FROM proposals
    WHERE id = 'proposal-1'
  `).get(), {
    title: "Canonical Update",
    package_name: "Signature Collection",
    scope_summary: "Updated package for Alex Taylor at The Garden House on 2026-09-19: $6,500.",
    total_cents: 650000,
  });

  database.prepare(`
    UPDATE proposals
    SET status = 'accepted', contract_status = 'signed', accepted_at = ?, signed_at = ?
    WHERE id = 'proposal-1'
  `).run(now, now);
  console.error = () => {};
  const signedResponse = await POST(new Request("https://studio.test/api/proposals/proposal-1", {
    method: "POST",
    body: formData,
  }), { params: Promise.resolve({ id: "proposal-1" }) }).finally(() => {
    console.error = originalConsoleError;
  });
  assert.equal(signedResponse.status, 400);
  assert.deepEqual(await signedResponse.json(), { error: "Accepted or signed proposals cannot be edited." });

  console.log("proposal route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
