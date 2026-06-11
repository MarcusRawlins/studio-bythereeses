import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-revenue-payment-canon-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { recordSchedulerBookingPaymentFromAgent } = await import("./scheduler");
  const { recordInvoicePaymentFromAgent } = await import("./sales");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Cross', 'alex.cross@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Cross Revenue Wedding', 'wedding', 'proposal_sent', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_amount_cents, created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-CROSS', 'sent', 100000, 0,
      'client_pays', 2930, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
    VALUES ('payment-1', 'invoice-1', 'Retainer', 30000, '2026-06-01', 'pending', ?, ?)
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
      start_at, end_at, status, source, created_at, updated_at
    ) VALUES (
      'booking-1', 'meeting-1', 'project-1', 'client-1', 'Alex Cross', 'alex.cross@example.com',
      '2026-06-03T14:00:00.000Z', '2026-06-03T14:45:00.000Z', 'confirmed', 'booking_link', ?, ?
    )
  `).run(now, now);

  await assert.rejects(
    () => recordInvoicePaymentFromAgent("invoice-1", {
      paymentId: "payment-1",
      status: "paid",
      externalPaymentId: "pi_cross_invoice",
    }),
    /Payments require Tyler approval/,
  );
  await assert.rejects(
    () => recordSchedulerBookingPaymentFromAgent("booking-1", {
      status: "paid",
      externalPaymentId: "pi_cross_scheduler",
    }),
    /Payments require Tyler approval/,
  );

  assert.deepEqual(database.prepare(`
    SELECT status, paid_amount_cents, external_payment_id
    FROM invoice_payments
    WHERE id = 'payment-1'
  `).get(), {
    status: "pending",
    paid_amount_cents: 0,
    external_payment_id: null,
  });
  assert.deepEqual(database.prepare(`
    SELECT payment_status, paid_amount_cents, external_payment_id
    FROM scheduler_bookings
    WHERE id = 'booking-1'
  `).get(), {
    payment_status: "unpaid",
    paid_amount_cents: 0,
    external_payment_id: null,
  });

  console.log("revenue payment canonicalization tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
