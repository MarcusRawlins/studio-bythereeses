import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-templates-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: TemplatesPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO templates (id, type, name, trigger, subject, body, status, created_at, updated_at)
    VALUES
      ('template-package', 'proposal_package', 'Signature Collection', 'Discovery call complete', 'Collection overview', 'Package copy.', 'active', ?, ?),
      ('template-reminder', 'reminder', 'Invoice Follow-up', '3 days before due date', NULL, 'Reminder copy.', 'draft', ?, ?)
  `).run(now, now, now, now);

  const markup = renderToStaticMarkup(await TemplatesPage());

  assert.match(markup, /Proposal packages/);
  assert.match(markup, /Reminder templates/);
  assert.match(markup, /value="proposal_package"/);
  assert.match(markup, /value="reminder"/);
  assert.match(markup, /Signature Collection/);
  assert.match(markup, /Invoice Follow-up/);
  assert.match(markup, /\{\{client.name\}\}/);
  assert.match(markup, /\{\{project.name\}\}/);

  console.log("templates page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
