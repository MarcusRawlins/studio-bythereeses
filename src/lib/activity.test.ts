import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-activity-log-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { listStudioActivityLog } = await import("./activity");
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
      ('activity-1', 'project-1', 'client-1', 'invoice.checkout_session_created', 'agent', 'The Reeses Studio Agent', '{"invoiceId":"invoice-1"}', '2026-05-31T13:00:00.000Z'),
      ('activity-2', 'project-1', NULL, 'project.stage_updated', 'admin', 'Tyler Reese', '{"stage":"planning"}', '2026-05-31T12:30:00.000Z'),
      ('activity-3', NULL, NULL, 'system.backup_completed', 'system', 'Backup Automation', NULL, '2026-05-31T12:00:00.000Z')
  `).run();

  const allRows = await listStudioActivityLog({ limit: 2 });
  assert.deepEqual(allRows.map((row) => row.id), ["activity-1", "activity-2"]);
  assert.deepEqual(allRows[0], {
    id: "activity-1",
    action: "invoice.checkout_session_created",
    label: "Invoice checkout session created",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
    createdAt: "2026-05-31T13:00:00.000Z",
    metadata: { invoiceId: "invoice-1" },
    project: { id: "project-1", name: "Alex Wedding" },
    client: { id: "client-1", name: "Alex Taylor", email: "alex@example.com" },
  });

  const agentRows = await listStudioActivityLog({ actorType: "agent" });
  assert.deepEqual(agentRows.map((row) => row.id), ["activity-1"]);

  const projectRows = await listStudioActivityLog({ projectId: "project-1" });
  assert.deepEqual(projectRows.map((row) => row.id), ["activity-1", "activity-2"]);

  console.log("activity log tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
