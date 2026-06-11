import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-proposal-create-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (
      id, name, type, stage, status, event_date, venue_name, city, state, created_at, updated_at
    ) VALUES (
      'project-1', 'Alex Wedding', 'wedding', 'planning', 'active',
      '2026-09-19', 'The Garden House', 'Hudson', 'NY', ?, ?
    )
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
    INSERT INTO templates (id, type, name, trigger, subject, body, status, created_at, updated_at)
    VALUES (
      'template-package-1',
      'proposal_package',
      'Signature Collection Template',
      'discovery call complete',
      'Signature Collection',
      'Proposal for {{client.name}} at {{project.venue_name}} on {{project.event_date}}: {{proposal.total}}.',
      'active',
      ?,
      ?
    )
  `).run(now, now);

  const formData = new FormData();
  formData.set("projectId", "project-1");
  formData.set("title", "Alex Wedding Proposal");
  formData.set("proposalPackageTemplateId", "template-package-1");
  formData.set("lineItemName", "Wedding photography coverage");
  formData.set("lineItemQuantity", "1");
  formData.set("lineItemUnitPrice", "9000");

  const response = await POST(new Request("https://studio.test/api/proposals", {
    method: "POST",
    body: formData,
  }));

  assert.equal(response.status, 303);
  const proposalId = response.headers.get("location")?.split("/").pop();
  assert.ok(proposalId);
  assert.deepEqual(database.prepare(`
    SELECT title, package_name, scope_summary, total_cents
    FROM proposals
    WHERE id = ?
  `).get(proposalId), {
    title: "Alex Wedding Proposal",
    package_name: "Signature Collection",
    scope_summary: "Proposal for Alex Taylor at The Garden House on 2026-09-19: $9,000.",
    total_cents: 900000,
  });
  const activity = database.prepare(`
    SELECT metadata
    FROM activity_logs
    WHERE action = 'proposal.created'
  `).get() as { metadata: string };
  assert.equal(JSON.parse(activity.metadata).proposalPackageTemplateId, "template-package-1");

  console.log("proposal create route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
