import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-activity-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: ActivityPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO activity_logs (id, project_id, client_id, action, actor_type, actor_name, metadata, created_at)
    VALUES
      ('activity-1', 'project-1', 'client-1', 'invoice.checkout_session_created', 'agent', 'The Reeses Studio Agent', '{"invoiceId":"invoice-1","paymentId":"payment-1"}', '2026-05-31T13:00:00.000Z'),
      ('activity-2', 'project-1', NULL, 'project.stage_updated', 'admin', 'Tyler Reese', '{"stage":"planning"}', '2026-05-31T12:30:00.000Z')
  `).run();

  const markup = renderToStaticMarkup(await ActivityPage({
    searchParams: Promise.resolve({ actor: "agent" }),
  }));

  assert.match(markup, /Audit log/);
  assert.match(markup, /Canonical record of Studio changes, client-facing events, and agent activity/);
  assert.match(markup, /Invoice checkout session created/);
  assert.match(markup, /The Reeses Studio Agent/);
  assert.match(markup, /Alex Wedding/);
  assert.match(markup, /Alex Taylor/);
  assert.match(markup, /invoice-1/);
  assert.doesNotMatch(markup, /Project stage updated/);

  console.log("activity page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
