import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-admin-payment-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

function paymentForm(values: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }
  return formData;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Admin Payment Wedding', 'wedding', 'proposal_sent', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-2', 'Other Admin Payment Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-ADMIN-PAY', 'sent', 100000, 0,
      'client_pays', 290, 30, 2930,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
    VALUES ('payment-1', 'invoice-1', 'Retainer', 30000, '2026-06-01', 'pending', ?, ?)
  `).run(now, now);

  const response = await route.POST(new Request("https://studio.bythereeses.com/api/invoices/invoice-1/payments", {
    method: "POST",
    body: paymentForm({
      projectId: "project-1",
      paymentId: "payment-1",
      status: "paid",
      paymentMethod: "stripe",
      paidAmount: "300.00",
      paidAt: "2026-06-02T10:00:00.000Z",
      externalPaymentId: "pi_admin_123",
      stripeCheckoutUrl: "https://checkout.stripe.com/c/pay/cs_test_admin",
      stripeCheckoutSessionId: "cs_test_admin",
      stripeCheckoutStatus: "paid",
      notes: "Recorded from Studio invoice page.",
    }),
  }), { params: Promise.resolve({ id: "invoice-1" }) });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://studio.bythereeses.com/invoices/invoice-1#payment-payment-1");

  const project = database.prepare("SELECT stage FROM projects WHERE id = 'project-1'").get();
  assert.deepEqual(project, { stage: "retainer_paid" });

  const invoice = database.prepare("SELECT amount_paid_cents, status FROM invoices WHERE id = 'invoice-1'").get();
  assert.deepEqual(invoice, {
    amount_paid_cents: 30000,
    status: "partially_paid",
  });

  const activityCount = database.prepare("SELECT COUNT(*) AS count FROM activity_logs").get();
  assert.deepEqual(activityCount, { count: 2 });
  const paymentActivity = database.prepare("SELECT action, actor_type, metadata FROM activity_logs WHERE action = 'invoice.payment_updated'").get();
  assert.deepEqual(paymentActivity, {
    action: "invoice.payment_updated",
    actor_type: "admin",
    metadata: JSON.stringify({
      invoiceId: "invoice-1",
      paymentId: "payment-1",
      status: "paid",
      paymentMethod: "stripe",
      paidAt: "2026-06-02T10:00:00.000Z",
      paidAmountCents: 30000,
      clientFeeCents: 900,
      processingFeeCents: 900,
      grossCollectedCents: 30900,
      netDepositCents: 30000,
      externalPaymentId: "pi_admin_123",
      stripeCheckoutUrl: "https://checkout.stripe.com/c/pay/cs_test_admin",
      stripeCheckoutSessionId: "cs_test_admin",
      stripeCheckoutStatus: "paid",
    }),
  });

  const storedCheckout = database.prepare(`
    SELECT stripe_checkout_url, stripe_checkout_session_id, stripe_checkout_status
    FROM invoice_payments
    WHERE id = 'payment-1'
  `).get();
  assert.deepEqual(storedCheckout, {
    stripe_checkout_url: "https://checkout.stripe.com/c/pay/cs_test_admin",
    stripe_checkout_session_id: "cs_test_admin",
    stripe_checkout_status: "paid",
  });
  const stageActivity = database.prepare("SELECT action, actor_type, metadata FROM activity_logs WHERE action = 'project.stage_auto_advanced_from_invoice_payment'").get();
  assert.deepEqual(stageActivity, {
    action: "project.stage_auto_advanced_from_invoice_payment",
    actor_type: "admin",
    metadata: JSON.stringify({
      invoiceId: "invoice-1",
      paymentId: "payment-1",
      paymentLabel: "Retainer",
      previousStage: "proposal_sent",
      nextStage: "retainer_paid",
      paidAmountCents: 30000,
    }),
  });

  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at)
    VALUES ('payment-2', 'invoice-1', 'Final payment', 70000, '2026-07-01', 'pending', ?, ?)
  `).run(now, now);

  const originalConsoleError = console.error;
  console.error = () => {};
  const overpaid = await route.POST(new Request("https://studio.bythereeses.com/api/invoices/invoice-1/payments", {
    method: "POST",
    body: paymentForm({
      projectId: "project-1",
      paymentId: "payment-2",
      status: "paid",
      paymentMethod: "stripe",
      paidAmount: "800.00",
      externalPaymentId: "pi_admin_overpaid",
    }),
  }), { params: Promise.resolve({ id: "invoice-1" }) }).finally(() => {
    console.error = originalConsoleError;
  });
  assert.equal(overpaid.status, 400);
  assert.deepEqual(await overpaid.json(), { error: "Paid amount cannot exceed scheduled payment amount." });
  assert.deepEqual(database.prepare(`
    SELECT status, paid_amount_cents, external_payment_id
    FROM invoice_payments
    WHERE id = 'payment-2'
  `).get(), {
    status: "pending",
    paid_amount_cents: 0,
    external_payment_id: null,
  });

  console.error = () => {};
  const wrongProject = await route.POST(new Request("https://studio.bythereeses.com/api/invoices/invoice-1/payments", {
    method: "POST",
    body: paymentForm({
      projectId: "project-2",
      paymentId: "payment-1",
      status: "paid",
    }),
  }), { params: Promise.resolve({ id: "invoice-1" }) }).finally(() => {
    console.error = originalConsoleError;
  });
  assert.equal(wrongProject.status, 400);
  const wrongProjectBody = await wrongProject.json();
  assert.equal(wrongProjectBody.error, "Invoice does not belong to this project.");

  console.log("admin invoice payment route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
