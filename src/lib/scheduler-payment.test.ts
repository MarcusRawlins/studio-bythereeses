import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-scheduler-payment-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { recordSchedulerBookingPaymentAction, recordSchedulerBookingPaymentFromAgent, updateSchedulerBookingPaymentFromAgent } = await import("./scheduler");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Reed', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Paid Scheduler Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
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
      start_at, end_at, status, source, created_at, updated_at
    ) VALUES (
      'booking-1', 'meeting-1', 'project-1', 'client-1', 'Alex Reed', 'alex@example.com',
      '2026-06-01T14:00:00.000Z', '2026-06-01T14:45:00.000Z', 'confirmed', 'booking_link', ?, ?
    )
  `).run(now, now);

  await assert.rejects(
    () => recordSchedulerBookingPaymentFromAgent("booking-1", {
      status: "paid",
      paymentMethod: "stripe",
      paidAmountCents: 25000,
      paidAt: "2026-05-29T13:00:00.000Z",
      externalPaymentId: "pi_scheduler_123",
    }),
    /Payments require Tyler approval/,
  );
  await assert.rejects(
    () => updateSchedulerBookingPaymentFromAgent("booking-1", {
      status: "paid",
      paidAmountCents: 24000,
    }),
    /Payments require Tyler approval/,
  );
  assert.deepEqual(database.prepare(`
    SELECT payment_status, paid_amount_cents, paid_at, external_payment_id
    FROM scheduler_bookings
    WHERE id = 'booking-1'
  `).get(), {
    payment_status: "unpaid",
    paid_amount_cents: 0,
    paid_at: null,
    external_payment_id: null,
  });

  const adminForm = new FormData();
  adminForm.set("bookingId", "booking-1");
  adminForm.set("status", "paid");
  adminForm.set("paymentMethod", "zelle");
  adminForm.set("paidAmount", "250.00");
  adminForm.set("paidAt", "2026-05-30T15:00:00.000Z");
  adminForm.set("externalPaymentId", "zelle-admin-456");
  adminForm.set("notes", "Reconciled manually from Zelle.");

  await assert.rejects(
    () => recordSchedulerBookingPaymentAction(adminForm),
    (error) => {
      assert.match(error instanceof Error ? error.message : String(error), /NEXT_REDIRECT/);
      assert.match(String((error as { digest?: unknown }).digest), /\/scheduler\/bookings\/booking-1#payment-booking-1/);
      return true;
    },
  );

  assert.deepEqual(database.prepare(`
    SELECT payment_status, payment_method, paid_amount_cents, external_payment_id, payment_notes
    FROM scheduler_bookings
    WHERE id = 'booking-1'
  `).get(), {
    payment_status: "paid",
    payment_method: "zelle",
    paid_amount_cents: 25000,
    external_payment_id: "zelle-admin-456",
    payment_notes: "Reconciled manually from Zelle.",
  });

  console.log("scheduler payment tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
