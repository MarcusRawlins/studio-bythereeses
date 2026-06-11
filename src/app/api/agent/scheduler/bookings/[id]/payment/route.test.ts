import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-scheduler-payment-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";

function request(url: string, body: unknown, method = "POST", token = "secret") {
  return new Request(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, collect_payment, price_cents,
      stripe_payment_link, created_at, updated_at
    ) VALUES (
      'meeting-1', 'paid-consult', 'Paid Consultation', 45, 15, 1, 25000,
      'https://pay.stripe.com/test_paid_consult', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, attendee_name, attendee_email,
      start_at, end_at, status, source, created_at, updated_at
    ) VALUES (
      'booking-1', 'meeting-1', 'Alex Reed', 'alex@example.com',
      '2026-06-01T14:00:00.000Z', '2026-06-01T14:45:00.000Z', 'confirmed', 'booking_link', ?, ?
    )
  `).run(now, now);

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/scheduler/bookings/booking-1/payment", {
    method: "POST",
    body: JSON.stringify({ status: "paid" }),
  }), { params: Promise.resolve({ id: "booking-1" }) });
  assert.equal(unauthorized.status, 401);

  const createResponse = await route.POST(request("https://studio.bythereeses.com/api/agent/scheduler/bookings/booking-1/payment", {
    status: "paid",
    paidAmountCents: 25000,
  }), { params: Promise.resolve({ id: "booking-1" }) });
  assert.equal(createResponse.status, 400);
  assert.match((await createResponse.json()).error, /Payments require Tyler approval/);

  const updateResponse = await route.PATCH(request("https://studio.bythereeses.com/api/agent/scheduler/bookings/booking-1/payment", {
    status: "paid",
    paidAmountCents: 24000,
  }, "PATCH"), { params: Promise.resolve({ id: "booking-1" }) });
  assert.equal(updateResponse.status, 400);
  assert.match((await updateResponse.json()).error, /Payments require Tyler approval/);

  assert.deepEqual(database.prepare(`
    SELECT payment_status, paid_amount_cents, paid_at
    FROM scheduler_bookings
    WHERE id = 'booking-1'
  `).get(), {
    payment_status: "unpaid",
    paid_amount_cents: 0,
    paid_at: null,
  });

  console.log("agent scheduler booking payment route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
