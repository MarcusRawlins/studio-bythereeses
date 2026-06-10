import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-stripe-webhook-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_studio";

function stripeSignature(rawBody: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET ?? "")
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

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
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'proposal_sent', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-WEBHOOK', 'partially_paid', 100000, 30000,
      'client_pays', 290, 30, 2930,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, external_payment_id, stripe_checkout_url, stripe_checkout_session_id,
      stripe_checkout_status, created_at, updated_at
    ) VALUES (
      'payment-retainer', 'invoice-1', 'Retainer', 30000, '2026-06-01', 'paid',
      '2026-06-02T10:00:00.000Z', 'stripe', 30000, 900, 900, 30900,
      30000, 'pi_retainer', NULL, NULL, 'paid', ?, ?
    ), (
      'payment-final', 'invoice-1', 'Final payment', 70000, '2026-08-19', 'pending',
      NULL, NULL, 0, 0, 0, 0,
      0, NULL, 'https://checkout.stripe.com/c/pay/cs_test_final',
      'cs_test_final', 'link_ready', ?, ?
    )
  `).run(now, now, now, now);

  const event = {
    id: "evt_checkout_paid",
    type: "checkout.session.completed",
    created: 1780000000,
    data: {
      object: {
        id: "cs_test_final",
        object: "checkout.session",
        status: "complete",
        payment_status: "paid",
        amount_total: 72030,
        payment_intent: "pi_final",
        metadata: {
          invoice_id: "invoice-1",
          payment_id: "payment-final",
          project_id: "project-1",
          service_open_cents: "70000",
          client_payable_open_cents: "72030",
        },
      },
    },
  };
  const rawBody = JSON.stringify(event);
  const response = await route.POST(new Request("https://studio.bythereeses.com/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": stripeSignature(rawBody) },
    body: rawBody,
  }));
  assert.equal(response.status, 200);
  const responseBody = await response.json();
  assert.equal(responseBody.received, true);
  assert.equal(responseBody.result.ignored, false);

  assert.deepEqual(database.prepare(`
    SELECT status, payment_method, paid_amount_cents, client_fee_cents, processing_fee_cents,
      gross_collected_cents, net_deposit_cents, external_payment_id, stripe_checkout_status
    FROM invoice_payments
    WHERE id = 'payment-final'
  `).get(), {
    status: "paid",
    payment_method: "stripe",
    paid_amount_cents: 70000,
    client_fee_cents: 2030,
    processing_fee_cents: 2030,
    gross_collected_cents: 72030,
    net_deposit_cents: 70000,
    external_payment_id: "pi_final",
    stripe_checkout_status: "paid",
  });

  assert.deepEqual(database.prepare("SELECT status, amount_paid_cents, paid_at FROM invoices WHERE id = 'invoice-1'").get(), {
    status: "paid",
    amount_paid_cents: 100000,
    paid_at: "2026-05-28T20:26:40.000Z",
  });
  assert.deepEqual(database.prepare("SELECT stage FROM projects WHERE id = 'project-1'").get(), { stage: "proposal_sent" });

  const paymentActivity = database.prepare("SELECT action, actor_type, metadata FROM activity_logs WHERE action = 'invoice.payment_recorded_from_stripe_checkout'").get() as {
    action: string;
    actor_type: string;
    metadata: string;
  };
  assert.equal(paymentActivity.actor_type, "system");
  assert.deepEqual(JSON.parse(paymentActivity.metadata), {
    invoiceId: "invoice-1",
    paymentId: "payment-final",
    checkoutSessionId: "cs_test_final",
    paymentIntentId: "pi_final",
    paidAt: "2026-05-28T20:26:40.000Z",
    paidAmountCents: 70000,
    clientFeeCents: 2030,
    processingFeeCents: 2030,
    grossCollectedCents: 72030,
    netDepositCents: 70000,
  });

  const duplicate = await route.POST(new Request("https://studio.bythereeses.com/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": stripeSignature(rawBody) },
    body: rawBody,
  }));
  assert.equal(duplicate.status, 200);
  assert.equal(database.prepare("SELECT COUNT(*) FROM activity_logs WHERE action = 'invoice.payment_recorded_from_stripe_checkout'").pluck().get(), 1);

  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-expired', 'project-1', 'INV-EXPIRED', 'sent', 15000, 0,
      'client_pays', 290, 30, 465,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, external_payment_id, stripe_checkout_url, stripe_checkout_session_id,
      stripe_checkout_status, created_at, updated_at
    ) VALUES (
      'payment-album', 'invoice-expired', 'Album balance', 15000, '2026-09-01', 'pending',
      NULL, NULL, 0, 0, 0, 0,
      0, NULL, 'https://checkout.stripe.com/c/pay/cs_test_album',
      'cs_test_album', 'link_ready', ?, ?
    )
  `).run(now, now);
  const expiredEvent = {
    id: "evt_checkout_expired",
    type: "checkout.session.expired",
    created: 1780003600,
    data: {
      object: {
        id: "cs_test_album",
        object: "checkout.session",
        status: "expired",
        payment_status: "unpaid",
        metadata: {
          invoice_id: "invoice-expired",
          payment_id: "payment-album",
          project_id: "project-1",
        },
      },
    },
  };
  const expiredRawBody = JSON.stringify(expiredEvent);
  const expired = await route.POST(new Request("https://studio.bythereeses.com/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": stripeSignature(expiredRawBody) },
    body: expiredRawBody,
  }));
  assert.equal(expired.status, 200);
  assert.deepEqual(database.prepare(`
    SELECT status, paid_amount_cents, stripe_checkout_status
    FROM invoice_payments
    WHERE id = 'payment-album'
  `).get(), {
    status: "pending",
    paid_amount_cents: 0,
    stripe_checkout_status: "expired",
  });
  const expiredActivity = database.prepare("SELECT action, actor_type, metadata FROM activity_logs WHERE action = 'invoice.checkout_session_expired'").get() as {
    action: string;
    actor_type: string;
    metadata: string;
  };
  assert.equal(expiredActivity.actor_type, "system");
  assert.deepEqual(JSON.parse(expiredActivity.metadata), {
    invoiceId: "invoice-expired",
    paymentId: "payment-album",
    checkoutSessionId: "cs_test_album",
    expiredAt: "2026-05-28T21:26:40.000Z",
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  const badSignature = await route.POST(new Request("https://studio.bythereeses.com/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1780000000,v1=bad" },
    body: rawBody,
  })).finally(() => {
    console.error = originalConsoleError;
  });
  assert.equal(badSignature.status, 400);

  console.log("stripe webhook route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
