import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-templates-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO templates (id, type, name, trigger, subject, body, status, created_at, updated_at)
    VALUES
      ('template-package', 'proposal_package', 'Signature Collection', 'discovery call complete', 'Collection overview', 'Package for {{project.name}}.', 'active', ?, ?),
      ('template-archived', 'proposal_package', 'Old Collection', 'manual', NULL, 'Archived package.', 'archived', ?, ?),
      ('template-reminder', 'reminder', 'Invoice Follow-up', '3 days before due date', NULL, 'Balance reminder for {{invoice.balanceDue}}.', 'draft', ?, ?)
  `).run(now, now, now, now, now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blockedOrigin = await route.GET(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/agent/templates", {
    headers: { authorization: "Bearer secret" },
  }));
  assert.equal(blockedOrigin.status, 404);

  const unauthorized = await route.GET(new Request("https://studio.bythereeses.com/api/agent/templates"));
  assert.equal(unauthorized.status, 401);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/agent/templates?type=proposal_package", {
    headers: {
      authorization: "Bearer secret",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.templates, [
    {
      id: "template-package",
      type: "proposal_package",
      name: "Signature Collection",
      trigger: "discovery call complete",
      subject: "Collection overview",
      body: "Package for {{project.name}}.",
      status: "active",
      updatedAt: now,
    },
  ]);

  console.log("agent templates route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
