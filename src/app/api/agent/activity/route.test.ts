import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-activity-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "activity-token";

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
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
      ('activity-agent', 'project-1', 'client-1', 'invoice.checkout_session_created', 'agent', 'The Reeses Studio Agent', '{"invoiceId":"invoice-1"}', '2026-05-31T13:00:00.000Z'),
      ('activity-admin', 'project-1', NULL, 'project.stage_updated', 'admin', 'Tyler Reese', '{"stage":"planning"}', '2026-05-31T12:30:00.000Z')
  `).run();

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blockedOrigin = await route.GET(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/agent/activity", {
    headers: { authorization: "Bearer activity-token" },
  }));
  assert.equal(blockedOrigin.status, 404);

  const unauthorized = await route.GET(new Request("https://studio.bythereeses.com/api/agent/activity"));
  assert.equal(unauthorized.status, 401);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/agent/activity?actor=agent&projectId=project-1&limit=5", {
    headers: {
      authorization: "Bearer activity-token",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.activity.map((item: {
    id: string;
    label: string;
    actorType: string;
    actorName: string;
    project: { id: string; name: string } | null;
    client: { id: string; name: string; email: string } | null;
    metadata: Record<string, unknown> | null;
  }) => ({
    id: item.id,
    label: item.label,
    actorType: item.actorType,
    actorName: item.actorName,
    project: item.project,
    client: item.client,
    metadata: item.metadata,
  })), [
    {
      id: "activity-agent",
      label: "Invoice checkout session created",
      actorType: "agent",
      actorName: "The Reeses Studio Agent",
      project: { id: "project-1", name: "Alex Wedding" },
      client: { id: "client-1", name: "Alex Taylor", email: "alex@example.com" },
      metadata: { invoiceId: "invoice-1" },
    },
  ]);

  console.log("agent activity route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
