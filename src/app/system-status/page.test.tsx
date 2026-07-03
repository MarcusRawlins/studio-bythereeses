import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-system-status-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.ORIGIN_PROXY_SECRET = "origin-secret";
process.env.STUDIO_AGENT_API_TOKEN = "agent-secret";
process.env.ADMIN_SESSION_SECRET = "admin-secret";
process.env.CRON_SECRET = "cron-secret";
process.env.STRIPE_SECRET_KEY = "stripe-secret";
process.env.STRIPE_WEBHOOK_SECRET = "stripe-webhook-secret";

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: SystemStatusPage } = await import("./page");
  const database = rawDb();
  const now = "2026-07-03T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);

  const markup = renderToStaticMarkup(await SystemStatusPage());

  assert.match(markup, /System status/);
  assert.match(markup, /Studio admin gate/);
  assert.match(markup, /Worker origin guard/);
  assert.match(markup, /Agent and MCP API/);
  assert.match(markup, /D1 backup/);
  assert.match(markup, /Proposal links/);
  assert.match(markup, /shared token/);
  assert.match(markup, /1<\/div>/);
  assert.doesNotMatch(markup, /agent-secret|admin-secret|origin-secret|stripe-secret|stripe-webhook-secret|cron-secret/);

  console.log("system status page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
