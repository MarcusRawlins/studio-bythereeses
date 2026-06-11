import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-data-health-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "health-token";

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-orphan', 'Bailey', 'Bickley', 'bailey@example.com', ?, ?)
  `).run(now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blockedOrigin = await route.GET(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/agent/data-health", {
    headers: { authorization: "Bearer health-token" },
  }));
  assert.equal(blockedOrigin.status, 404);

  const unauthorized = await route.GET(new Request("https://studio.bythereeses.com/api/agent/data-health"));
  assert.equal(unauthorized.status, 401);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/agent/data-health", {
    headers: {
      authorization: "Bearer health-token",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.dataHealth.summary.clientCount, 1);
  assert.equal(body.dataHealth.summary.issueCount, 1);
  assert.deepEqual(body.dataHealth.issues.map((issue: { type: string }) => issue.type), ["client_without_project"]);

  console.log("agent data health route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
