import assert from "node:assert/strict";
import { summarizeInvoicePaymentMetrics } from "./dashboard";

const now = new Date("2026-05-08T12:00:00.000Z");

const summary = summarizeInvoicePaymentMetrics([
  {
    invoiceId: "invoice-overdue",
    invoiceNumber: "INV-OVERDUE",
    paymentId: "payment-overdue",
    label: "Retainer",
    amountCents: 250000,
    dueDate: "2026-05-01",
    status: "pending",
  },
  {
    invoiceId: "invoice-soon",
    invoiceNumber: "INV-SOON",
    paymentId: "payment-soon",
    label: "Final payment",
    amountCents: 750000,
    dueDate: "2026-05-20",
    status: "pending",
  },
  {
    invoiceId: "invoice-paid",
    invoiceNumber: "INV-PAID",
    paymentId: "payment-paid",
    label: "Paid payment",
    amountCents: 120000,
    dueDate: "2026-05-05",
    status: "paid",
  },
], now);

assert.equal(summary.outstandingPaymentCents, 1000000);
assert.equal(summary.overduePaymentCount, 1);
assert.equal(summary.dueSoonPaymentCount, 1);
assert.deepEqual(summary.nextPaymentDue, {
  invoiceId: "invoice-overdue",
  invoiceNumber: "INV-OVERDUE",
  paymentId: "payment-overdue",
  label: "Retainer",
  amountCents: 250000,
  dueDate: "2026-05-01",
});

