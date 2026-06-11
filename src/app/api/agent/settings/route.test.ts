import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-settings-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO app_settings (
      id, business_name, public_brand_name, contact_email, website_url, instagram_url,
      timezone, payment_methods_json, created_at, updated_at
    ) VALUES (
      'business', 'The Reeses Studio', 'The Reeses Studio', 'hello@bythereeses.com',
      'https://bythereeses.com', 'https://instagram.com/thereeses',
      'America/New_York', ?, ?, ?
    )
  `).run(JSON.stringify({
    stripe: { enabled: true, passFees: true, displayName: "Credit card", instructions: "" },
    zelle: { enabled: true, passFees: false, displayName: "Zelle", instructions: "hello@bythereeses.com" },
    venmo: { enabled: false, passFees: false, displayName: "Venmo", instructions: "@bythereeses" },
    cashCheck: { enabled: true, passFees: false, displayName: "Cash or check", instructions: "Mail checks to the studio." },
  }), now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blockedOrigin = await route.GET(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/agent/settings", {
    headers: { authorization: "Bearer secret" },
  }));
  assert.equal(blockedOrigin.status, 404);

  const unauthorized = await route.GET(new Request("https://studio.bythereeses.com/api/agent/settings"));
  assert.equal(unauthorized.status, 401);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/agent/settings", {
    headers: {
      authorization: "Bearer secret",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.settings.business, {
    businessName: "The Reeses Studio",
    publicBrandName: "The Reeses Studio",
    contactEmail: "hello@bythereeses.com",
    websiteUrl: "https://bythereeses.com",
    instagramUrl: "https://instagram.com/thereeses",
    timezone: "America/New_York",
  });
  assert.deepEqual(body.settings.paymentMethods, [
    { key: "stripe", displayName: "Credit card", instructions: "", passFees: true },
    { key: "zelle", displayName: "Zelle", instructions: "hello@bythereeses.com", passFees: false },
    { key: "cashCheck", displayName: "Cash or check", instructions: "Mail checks to the studio.", passFees: false },
  ]);
  assert.equal(JSON.stringify(body).includes("token"), false);
  assert.equal(JSON.stringify(body).includes("secret"), false);

  console.log("agent settings route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
