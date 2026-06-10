import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-scheduler-booking-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: SchedulerBookingDetailPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Reed', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Paid Scheduler Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
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
      id, meeting_type_id, project_id, client_id, attendee_name, attendee_email,
      start_at, end_at, status, source, payment_status, payment_method, paid_at,
      paid_amount_cents, gross_collected_cents, net_deposit_cents, external_payment_id,
      payment_notes, created_at, updated_at
    ) VALUES (
      'booking-1', 'meeting-1', 'project-1', 'client-1', 'Alex Reed', 'alex@example.com',
      '2026-06-01T14:00:00.000Z', '2026-06-01T14:45:00.000Z', 'confirmed', 'booking_link',
      'paid', 'stripe', '2026-05-29T13:00:00.000Z', 25000, 25755, 25000,
      'pi_scheduler_page_123', 'Stripe payment evidence.', ?, ?
    )
  `).run(now, now);

  const markup = renderToStaticMarkup(await SchedulerBookingDetailPage({
    params: Promise.resolve({ id: "booking-1" }),
  }));

  assert.match(markup, /id="payment-booking-1"/);
  assert.match(markup, /Stripe payment evidence/);

  console.log("scheduler booking page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
