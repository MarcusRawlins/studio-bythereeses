import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-proposals-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: ProposalsPage } = await import("./page");
  const { listProposals } = await import("@/lib/sales");
  const database = rawDb();
  const now = "2026-06-01T09:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-linked', 'Alex Wedding', 'wedding', 'proposal_sent', 'active', ?, ?),
      ('project-orphan', 'Needs Primary Client Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-linked', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, package_name, total_cents, contract_status, invoice_status, created_at, updated_at
    ) VALUES
      ('proposal-linked', 'project-linked', 'Alex Wedding Proposal', 'draft', 'Signature Collection', 900000, 'not_started', 'not_created', ?, ?),
      ('proposal-orphan', 'project-orphan', 'Orphan Project Proposal', 'draft', 'Repairable Collection', 500000, 'not_started', 'not_created', ?, ?)
  `).run(now, now, now, now);

  assert.deepEqual((await listProposals()).map((row) => ({
    proposalId: row.proposal.id,
    projectName: row.project.name,
    clientId: row.client?.id ?? null,
  })), [
    {
      proposalId: "proposal-linked",
      projectName: "Alex Wedding",
      clientId: "client-1",
    },
    {
      proposalId: "proposal-orphan",
      projectName: "Needs Primary Client Wedding",
      clientId: null,
    },
  ]);

  const markup = renderToStaticMarkup(await ProposalsPage({
    searchParams: Promise.resolve({}),
  }));

  assert.match(markup, /Orphan Project Proposal/);
  assert.match(markup, /Needs Primary Client Wedding/);
  assert.match(markup, /Needs primary client/);
  assert.match(markup, /Alex Wedding Proposal/);
  assert.match(markup, /Alex Taylor/);

  console.log("proposals page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
