import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-invoice-fees-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { createInvoiceFromForm, invoiceClientPayableCents, updateInvoicePaymentFromForm } = await import("./sales");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO app_settings (
      id, business_name, public_brand_name, contact_email, timezone, payment_methods_json, created_at, updated_at
    ) VALUES ('business', 'The Reeses', 'The Reeses', 'hello@bythereeses.com', 'America/New_York', ?, ?, ?)
  `).run(JSON.stringify({
    stripe: { enabled: true, passFees: true, displayName: "Credit card", instructions: "" },
    zelle: { enabled: false, passFees: false, displayName: "Zelle", instructions: "" },
    venmo: { enabled: false, passFees: false, displayName: "Venmo", instructions: "" },
    cashCheck: { enabled: false, passFees: false, displayName: "Cash or check", instructions: "" },
  }), now, now);

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Fee Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);

  const formData = new FormData();
  formData.set("projectId", "project-1");
  formData.set("invoiceNumber", "INV-FEES");
  formData.set("status", "draft");
  formData.set("total", "1000");
  formData.set("retainerAmount", "300");
  formData.set("installmentCount", "1");
  formData.set("acceptedPaymentMethod", "stripe");

  const result = await createInvoiceFromForm(formData);
  const invoice = database.prepare(`
    SELECT
      total_cents,
      card_fee_policy,
      card_fee_percent_bps,
      card_fee_fixed_cents,
      card_fee_amount_cents
    FROM invoices
    WHERE id = ?
  `).get(result.invoiceId);

  assert.deepEqual(invoice, {
    total_cents: 100000,
    card_fee_policy: "client_pays",
    card_fee_percent_bps: 290,
    card_fee_fixed_cents: 30,
    card_fee_amount_cents: 2930,
  });
  assert.equal(invoiceClientPayableCents(invoice as { total_cents?: number; totalCents?: number; card_fee_amount_cents?: number; cardFeeAmountCents?: number }), 102930);

  const retainerPayment = database.prepare(`
    SELECT id FROM invoice_payments
    WHERE invoice_id = ? AND label = 'Retainer'
  `).get(result.invoiceId) as { id: string };

  const paymentForm = new FormData();
  paymentForm.set("invoiceId", result.invoiceId);
  paymentForm.set("projectId", "project-1");
  paymentForm.set("paymentId", retainerPayment.id);
  paymentForm.set("status", "paid");
  paymentForm.set("paymentMethod", "stripe");
  paymentForm.set("externalPaymentId", "pi_retainer_123");
  paymentForm.set("notes", "Paid by card through Stripe.");

  await updateInvoicePaymentFromForm(paymentForm);

  const paidPayment = database.prepare(`
    SELECT
      status,
      amount_cents,
      paid_amount_cents,
      client_fee_cents,
      processing_fee_cents,
      gross_collected_cents,
      net_deposit_cents,
      external_payment_id,
      payment_method
    FROM invoice_payments
    WHERE id = ?
  `).get(retainerPayment.id);

  assert.deepEqual(paidPayment, {
    status: "paid",
    amount_cents: 30000,
    paid_amount_cents: 30000,
    client_fee_cents: 900,
    processing_fee_cents: 900,
    gross_collected_cents: 30900,
    net_deposit_cents: 30000,
    external_payment_id: "pi_retainer_123",
    payment_method: "stripe",
  });

  const paidInvoice = database.prepare(`
    SELECT amount_paid_cents, status
    FROM invoices
    WHERE id = ?
  `).get(result.invoiceId);
  assert.deepEqual(paidInvoice, {
    amount_paid_cents: 30000,
    status: "partially_paid",
  });

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-zero-fee', 'Zero Fee Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-zero-fee', 'project-zero-fee', 'INV-ZERO-FEE', 'sent', 30000, 0,
      'studio_absorbs', 0, 0, 0,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at
    ) VALUES (
      'payment-zero-fee', 'invoice-zero-fee', 'Retainer', 30000, '2026-06-01', 'pending', ?, ?
    )
  `).run(now, now);

  const zeroFeePaymentForm = new FormData();
  zeroFeePaymentForm.set("invoiceId", "invoice-zero-fee");
  zeroFeePaymentForm.set("projectId", "project-zero-fee");
  zeroFeePaymentForm.set("paymentId", "payment-zero-fee");
  zeroFeePaymentForm.set("status", "paid");
  zeroFeePaymentForm.set("paymentMethod", "stripe");

  await updateInvoicePaymentFromForm(zeroFeePaymentForm);

  assert.deepEqual(database.prepare(`
    SELECT client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents
    FROM invoice_payments
    WHERE id = 'payment-zero-fee'
  `).get(), {
    client_fee_cents: 0,
    processing_fee_cents: 0,
    gross_collected_cents: 30000,
    net_deposit_cents: 30000,
  });

  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-zero-fixed-fee', 'project-zero-fee', 'INV-ZERO-FIXED-FEE', 'sent', 30000, 0,
      'client_pays', 290, 0, 870,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at
    ) VALUES (
      'payment-zero-fixed-fee', 'invoice-zero-fixed-fee', 'Retainer', 30000, '2026-06-01', 'pending', ?, ?
    )
  `).run(now, now);

  const zeroFixedPaymentForm = new FormData();
  zeroFixedPaymentForm.set("invoiceId", "invoice-zero-fixed-fee");
  zeroFixedPaymentForm.set("projectId", "project-zero-fee");
  zeroFixedPaymentForm.set("paymentId", "payment-zero-fixed-fee");
  zeroFixedPaymentForm.set("status", "paid");
  zeroFixedPaymentForm.set("paymentMethod", "stripe");

  await updateInvoicePaymentFromForm(zeroFixedPaymentForm);

  assert.deepEqual(database.prepare(`
    SELECT client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents
    FROM invoice_payments
    WHERE id = 'payment-zero-fixed-fee'
  `).get(), {
    client_fee_cents: 870,
    processing_fee_cents: 870,
    gross_collected_cents: 30870,
    net_deposit_cents: 30000,
  });

  console.log("invoice fee tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
