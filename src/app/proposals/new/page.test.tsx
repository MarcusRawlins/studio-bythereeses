import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-new-proposal-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: NewProposalPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO templates (id, type, name, trigger, subject, body, status, created_at, updated_at)
    VALUES (
      'template-package-1', 'proposal_package', 'Signature Collection',
      'discovery call complete', 'Collection overview',
      'Package summary.', 'active', ?, ?
    )
  `).run(now, now);

  const markup = renderToStaticMarkup(await NewProposalPage({ searchParams: Promise.resolve({}) }));

  assert.match(markup, /name="proposalPackageTemplateId"/);
  assert.match(markup, /Proposal package template/);
  assert.match(markup, /Signature Collection/);

  console.log("new proposal page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
