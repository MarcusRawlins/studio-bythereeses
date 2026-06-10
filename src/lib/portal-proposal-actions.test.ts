import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-portal-proposal-actions-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.NEXT_PUBLIC_APP_URL = "https://studio.test";

async function main() {
  const { rawDb } = await import("@/db/client");
  const { createPortalProposalAccessLink } = await import("./portal");
  const database = rawDb();
  const now = "2026-05-29T17:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Portal Proposal Wedding', 'wedding', 'proposal_sent', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('other-project', 'Other Wedding', 'wedding', 'proposal_sent', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, total_cents, contract_status, contract_body, invoice_status, created_at, updated_at
    ) VALUES (
      'proposal-1', 'project-1', 'Portal Proposal', 'ready', 900000, 'ready', 'Agreement text.', 'not_created', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposal_line_items (id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at)
    VALUES ('line-1', 'proposal-1', 'Wedding coverage', 1, 900000, 0, 0, ?, ?)
  `).run(now, now);

  const link = await createPortalProposalAccessLink("project-1", "proposal-1", "client-1");
  assert.ok(link);
  assert.equal(new URL(link.url).origin, "https://studio.test");
  assert.equal(new URL(link.url).pathname.startsWith("/proposal/"), true);
  assert.equal(link.proposalId, "proposal-1");
  assert.equal(link.projectId, "project-1");

  assert.equal(
    database.prepare("SELECT count(*) AS count FROM proposal_access_tokens WHERE proposal_id = 'proposal-1' AND project_id = 'project-1' AND client_id = 'client-1'").get().count,
    1,
  );
  assert.equal(
    database.prepare("SELECT status FROM proposals WHERE id = 'proposal-1'").get().status,
    "sent",
  );

  const denied = await createPortalProposalAccessLink("other-project", "proposal-1", "client-1");
  assert.equal(denied, null);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM proposal_access_tokens WHERE proposal_id = 'proposal-1'").get().count,
    1,
  );

  console.log("portal proposal action tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
