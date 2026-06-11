import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-inbox-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: InboxPage } = await import("./page");
  const database = rawDb();
  const now = "2026-06-01T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO agent_tasks (
      id, project_id, title, status, priority, assigned_agent, created_at, updated_at
    ) VALUES
      ('task-proposal', 'project-1', 'Draft proposal from discovery call', 'queued', 'high', 'Proposal Agent', ?, ?),
      ('task-timeline', 'project-1', 'Draft wedding timeline', 'queued', 'high', 'Timeline Agent', ?, ?),
      ('task-comms', 'project-1', 'Draft follow-up email', 'in_progress', 'normal', 'Communications Agent', ?, ?)
  `).run(now, now, now, now, now, now);

  const markup = renderToStaticMarkup(await InboxPage({
    searchParams: Promise.resolve({ status: "queued", assignedAgent: "Proposal Agent" }),
  }));

  assert.match(markup, /Agent tasks/);
  assert.match(markup, /Status/);
  assert.match(markup, /Assigned agent/);
  assert.match(markup, /Proposal Agent/);
  assert.match(markup, /Communications Agent/);
  assert.match(markup, /Draft proposal from discovery call/);
  assert.doesNotMatch(markup, /Draft wedding timeline/);
  assert.doesNotMatch(markup, /Draft follow-up email/);
  assert.match(markup, /1 filtered task/);
  assert.match(markup, /href="\/inbox"/);

  console.log("inbox page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
