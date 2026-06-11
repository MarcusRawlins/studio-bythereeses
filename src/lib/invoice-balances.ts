type InvoiceClientPayableLike = {
  totalCents?: number | null;
  total_cents?: number | null;
  amountPaidCents?: number | null;
  amount_paid_cents?: number | null;
  cardFeeAmountCents?: number | null;
  card_fee_amount_cents?: number | null;
};

type InvoicePaymentSettlementLike = {
  status?: string | null;
  amountCents?: number | null;
  amount_cents?: number | null;
  paidAmountCents?: number | null;
  paid_amount_cents?: number | null;
  grossCollectedCents?: number | null;
  gross_collected_cents?: number | null;
};

type InvoicePaymentOpenLike = {
  status?: string | null;
  amountCents?: number | null;
  amount_cents?: number | null;
  paidAmountCents?: number | null;
  paid_amount_cents?: number | null;
};

function positiveCents(value: number | null | undefined) {
  return Math.max(value ?? 0, 0);
}

export function invoiceClientPayableCents(invoice: InvoiceClientPayableLike) {
  return positiveCents(invoice.totalCents ?? invoice.total_cents)
    + positiveCents(invoice.cardFeeAmountCents ?? invoice.card_fee_amount_cents);
}

export function invoicePaymentClientSettledCents(payment: InvoicePaymentSettlementLike) {
  const amountCents = positiveCents(payment.amountCents ?? payment.amount_cents);
  const paidAmountCents = positiveCents(payment.paidAmountCents ?? payment.paid_amount_cents);
  const grossCollectedCents = positiveCents(payment.grossCollectedCents ?? payment.gross_collected_cents);

  if (payment.status === "waived") return amountCents;
  return Math.max(grossCollectedCents, paidAmountCents);
}

export function invoiceClientPayableBalanceCents(
  invoice: InvoiceClientPayableLike,
  payments: InvoicePaymentSettlementLike[],
) {
  const paymentSettledCents = payments.reduce((sum, payment) => sum + invoicePaymentClientSettledCents(payment), 0);
  const settledCents = Math.max(paymentSettledCents, positiveCents(invoice.amountPaidCents ?? invoice.amount_paid_cents));
  return Math.max(invoiceClientPayableCents(invoice) - settledCents, 0);
}

export function invoicePaymentOpenCents(payment: InvoicePaymentOpenLike) {
  if (payment.status === "paid" || payment.status === "waived") return 0;
  return Math.max(
    positiveCents(payment.amountCents ?? payment.amount_cents)
      - positiveCents(payment.paidAmountCents ?? payment.paid_amount_cents),
    0,
  );
}

export function invoicePaymentClientPayableOpenCents({
  payment,
  openServiceTotalCents,
  remainingClientFeeCents,
}: {
  payment: InvoicePaymentOpenLike;
  openServiceTotalCents: number;
  remainingClientFeeCents: number;
}) {
  const openCents = invoicePaymentOpenCents(payment);
  if (!openCents || !openServiceTotalCents || !remainingClientFeeCents) return openCents;

  return openCents + Math.round(remainingClientFeeCents * (openCents / openServiceTotalCents));
}
