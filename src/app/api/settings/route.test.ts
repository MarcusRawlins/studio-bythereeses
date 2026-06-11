import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-settings-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();

  const formData = new FormData();
  formData.set("businessName", "  The Reeses LLC  ");
  formData.set("publicBrandName", " The Reeses Studio ");
  formData.set("contactEmail", " HELLO@BYTHEREESES.COM ");
  formData.set("websiteUrl", "bythereeses.com");
  formData.set("instagramUrl", "@thereeses");
  formData.set("timezone", "America/New_York");
  formData.set("stripeEnabled", "on");
  formData.set("stripePassFees", "on");
  formData.set("stripeDisplayName", " Credit card ");
  formData.set("zelleEnabled", "on");
  formData.set("zelleDisplayName", " Zelle ");
  formData.set("zelleInstructions", " hello@bythereeses.com ");
  formData.set("venmoDisplayName", " Venmo ");
  formData.set("venmoInstructions", " @bythereeses ");
  formData.set("cashCheckEnabled", "on");
  formData.set("cashCheckDisplayName", " Cash or check ");
  formData.set("cashCheckInstructions", " Mail checks to the studio. ");

  const response = await route.POST(new Request("https://studio.bythereeses.com/api/settings", {
    method: "POST",
    body: formData,
  }));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.bythereeses.com/settings?saved=1");

  const row = database.prepare(`
    SELECT business_name, public_brand_name, contact_email, website_url, instagram_url, timezone, payment_methods_json
    FROM app_settings
    WHERE id = 'business'
  `).get() as {
    business_name: string;
    public_brand_name: string;
    contact_email: string;
    website_url: string;
    instagram_url: string;
    timezone: string;
    payment_methods_json: string;
  };

  assert.equal(row.business_name, "The Reeses LLC");
  assert.equal(row.public_brand_name, "The Reeses Studio");
  assert.equal(row.contact_email, "hello@bythereeses.com");
  assert.equal(row.website_url, "https://bythereeses.com");
  assert.equal(row.instagram_url, "https://instagram.com/thereeses");
  assert.equal(row.timezone, "America/New_York");
  assert.deepEqual(JSON.parse(row.payment_methods_json), {
    stripe: { enabled: true, passFees: true, displayName: "Credit card", instructions: "" },
    zelle: { enabled: true, passFees: false, displayName: "Zelle", instructions: "hello@bythereeses.com" },
    venmo: { enabled: false, passFees: false, displayName: "Venmo", instructions: "@bythereeses" },
    cashCheck: { enabled: true, passFees: false, displayName: "Cash or check", instructions: "Mail checks to the studio." },
  });

  console.log("settings route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
