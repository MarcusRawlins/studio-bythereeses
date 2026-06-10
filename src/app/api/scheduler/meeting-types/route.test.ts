import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-scheduler-meeting-type-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();

  const formData = new FormData();
  formData.set("_action", "create");
  formData.set("name", "Paid Studio Consult");
  formData.set("slug", "paid-studio-consult");
  formData.set("durationMinutes", "45");
  formData.set("bufferMinutes", "15");
  formData.set("locationType", "zoom");
  formData.set("locationLabel", "Zoom");
  formData.set("collectPayment", "on");
  formData.set("priceDollars", "250");
  formData.set("stripePaymentLink", "https://pay.stripe.com/test_scheduler_consult");
  formData.set("isActive", "on");

  const response = await route.POST(new Request("https://studio.bythereeses.com/api/scheduler/meeting-types", {
    method: "POST",
    body: formData,
  }));

  assert.equal(response.status, 303);

  const row = database.prepare(`
    SELECT collect_payment, price_cents, stripe_payment_link
    FROM scheduler_meeting_types
    WHERE slug = 'paid-studio-consult'
  `).get();

  assert.deepEqual(row, {
    collect_payment: 1,
    price_cents: 25000,
    stripe_payment_link: "https://pay.stripe.com/test_scheduler_consult",
  });

  console.log("scheduler meeting type route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
