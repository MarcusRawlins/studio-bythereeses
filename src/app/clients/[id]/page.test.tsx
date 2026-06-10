import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-client-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: ClientDetailPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T14:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, created_at, updated_at)
    VALUES
      ('client-1', 'Alex', 'Taylor', 'alex@example.com', '555-0100', ?, ?),
      ('client-duplicate', 'Alex', 'Taylor Duplicate', 'alex.duplicate@example.com', '555-0199', ?, ?)
  `).run(now, now, now, now);

  const markup = renderToStaticMarkup(await ClientDetailPage({
    params: Promise.resolve({ id: "client-1" }),
  }));

  assert.match(markup, /Merge duplicate/);
  assert.match(markup, /Create project/);
  assert.match(markup, /action="\/api\/clients\/client-1\/projects"/);
  assert.match(markup, /name="projectName"/);
  assert.match(markup, /action="\/api\/clients\/client-1\/links"/);
  assert.match(markup, /action="\/api\/clients\/client-1\/merge"/);
  assert.match(markup, /name="duplicateClientId"/);
  assert.match(markup, /value="client-duplicate"/);
  assert.match(markup, /Alex Taylor Duplicate/);
  assert.match(markup, /alex\.duplicate@example\.com/);

  console.log("client detail page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
