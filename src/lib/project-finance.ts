import { db } from "@/db/client";
import { expenses, invoicePayments, invoices, schedulerBookings, schedulerMeetingTypes } from "@/db/schema";
import { invoiceClientPayableBalanceCents } from "@/lib/invoice-balances";
import { asc, eq, inArray } from "drizzle-orm";

type InvoicePaymentLike = {
  invoiceId?: string;
  amountCents: number;
  paidAmountCents: number;
  grossCollectedCents: number;
  clientFeeCents: number;
  processingFeeCents: number;
  netDepositCents: number;
  status: string;
};

type SchedulerBookingPaymentLike = {
  booking: {
    paidAmountCents: number;
    grossCollectedCents: number;
    clientFeeCents: number;
    processingFeeCents: number;
    netDepositCents: number;
    paymentStatus: string;
  };
  meetingType: {
    priceCents: number | null;
  };
};

type InvoiceFinancialLike = {
  id: string;
  totalCents: number;
  amountPaidCents: number;
  cardFeeAmountCents: number;
};

type ExpenseLike = {
  amountCents: number;
  taxDeductible: boolean | null;
  status: string;
};

export type ProjectFinancialSummary = {
  scheduledCents: number;
  paidCents: number;
  grossCollectedCents: number;
  clientFeeCents: number;
  processingFeeCents: number;
  netDepositCents: number;
  openCents: number;
  clientPayableOpenCents: number;
  expenseCents: number;
  paidExpenseCents: number;
  openPayableCents: number;
  taxDeductibleExpenseCents: number;
  nonDeductibleExpenseCents: number;
  collectedProfitCents: number;
  projectedProfitCents: number;
  invoiceCount: number;
  invoicePaymentCount: number;
  schedulerPaymentCount: number;
  expenseCount: number;
};

function invoicePaymentOpenCents(payment: InvoicePaymentLike) {
  if (payment.status === "paid" || payment.status === "waived") return 0;
  return Math.max(payment.amountCents - payment.paidAmountCents, 0);
}

export function summarizeProjectFinancials({
  invoiceCount,
  invoices: invoiceRows = [],
  invoicePayments: paymentRows,
  schedulerBookings: bookingRows,
  expenses: expenseRows,
}: {
  invoiceCount: number;
  invoices?: InvoiceFinancialLike[];
  invoicePayments: InvoicePaymentLike[];
  schedulerBookings: SchedulerBookingPaymentLike[];
  expenses: ExpenseLike[];
}): ProjectFinancialSummary {
  const invoicePaymentSummary = paymentRows.reduce((sum, payment) => ({
    scheduledCents: sum.scheduledCents + payment.amountCents,
    paidCents: sum.paidCents + payment.paidAmountCents,
    grossCollectedCents: sum.grossCollectedCents + payment.grossCollectedCents,
    clientFeeCents: sum.clientFeeCents + payment.clientFeeCents,
    processingFeeCents: sum.processingFeeCents + payment.processingFeeCents,
    netDepositCents: sum.netDepositCents + payment.netDepositCents,
    openCents: sum.openCents + invoicePaymentOpenCents(payment),
  }), {
    scheduledCents: 0,
    paidCents: 0,
    grossCollectedCents: 0,
    clientFeeCents: 0,
    processingFeeCents: 0,
    netDepositCents: 0,
    openCents: 0,
  });

  const paymentsByInvoiceId = new Map<string, InvoicePaymentLike[]>();
  for (const payment of paymentRows) {
    if (!payment.invoiceId) continue;
    paymentsByInvoiceId.set(payment.invoiceId, [...(paymentsByInvoiceId.get(payment.invoiceId) ?? []), payment]);
  }
  const invoiceClientPayableOpenCents = invoiceRows.length
    ? invoiceRows.reduce((sum, invoice) => (
        sum + invoiceClientPayableBalanceCents(invoice, paymentsByInvoiceId.get(invoice.id) ?? [])
      ), 0)
    : invoicePaymentSummary.openCents;

  const schedulerPaymentSummary = bookingRows.reduce((sum, row) => {
    const amountCents = row.booking.paidAmountCents || row.meetingType.priceCents || 0;
    const openCents = row.booking.paymentStatus === "paid" || row.booking.paymentStatus === "waived"
      ? 0
      : Math.max(amountCents - row.booking.paidAmountCents, 0);
    return {
      scheduledCents: sum.scheduledCents + amountCents,
      paidCents: sum.paidCents + row.booking.paidAmountCents,
      grossCollectedCents: sum.grossCollectedCents + row.booking.grossCollectedCents,
      clientFeeCents: sum.clientFeeCents + row.booking.clientFeeCents,
      processingFeeCents: sum.processingFeeCents + row.booking.processingFeeCents,
      netDepositCents: sum.netDepositCents + row.booking.netDepositCents,
      openCents: sum.openCents + openCents,
    };
  }, {
    scheduledCents: 0,
    paidCents: 0,
    grossCollectedCents: 0,
    clientFeeCents: 0,
    processingFeeCents: 0,
    netDepositCents: 0,
    openCents: 0,
  });

  const expenseSummary = expenseRows.reduce((sum, expense) => ({
    expenseCents: sum.expenseCents + expense.amountCents,
    paidExpenseCents: sum.paidExpenseCents + (expense.status === "paid" ? expense.amountCents : 0),
    openPayableCents: sum.openPayableCents + (expense.status === "unpaid" ? expense.amountCents : 0),
    taxDeductibleExpenseCents: sum.taxDeductibleExpenseCents + (expense.taxDeductible ? expense.amountCents : 0),
    nonDeductibleExpenseCents: sum.nonDeductibleExpenseCents + (expense.taxDeductible ? 0 : expense.amountCents),
  }), {
    expenseCents: 0,
    paidExpenseCents: 0,
    openPayableCents: 0,
    taxDeductibleExpenseCents: 0,
    nonDeductibleExpenseCents: 0,
  });

  const scheduledCents = invoicePaymentSummary.scheduledCents + schedulerPaymentSummary.scheduledCents;
  const paidCents = invoicePaymentSummary.paidCents + schedulerPaymentSummary.paidCents;
  const netDepositCents = invoicePaymentSummary.netDepositCents + schedulerPaymentSummary.netDepositCents;

  return {
    scheduledCents,
    paidCents,
    grossCollectedCents: invoicePaymentSummary.grossCollectedCents + schedulerPaymentSummary.grossCollectedCents,
    clientFeeCents: invoicePaymentSummary.clientFeeCents + schedulerPaymentSummary.clientFeeCents,
    processingFeeCents: invoicePaymentSummary.processingFeeCents + schedulerPaymentSummary.processingFeeCents,
    netDepositCents,
    openCents: invoicePaymentSummary.openCents + schedulerPaymentSummary.openCents,
    clientPayableOpenCents: invoiceClientPayableOpenCents + schedulerPaymentSummary.openCents,
    expenseCents: expenseSummary.expenseCents,
    paidExpenseCents: expenseSummary.paidExpenseCents,
    openPayableCents: expenseSummary.openPayableCents,
    taxDeductibleExpenseCents: expenseSummary.taxDeductibleExpenseCents,
    nonDeductibleExpenseCents: expenseSummary.nonDeductibleExpenseCents,
    collectedProfitCents: netDepositCents - expenseSummary.paidExpenseCents,
    projectedProfitCents: scheduledCents - expenseSummary.expenseCents,
    invoiceCount,
    invoicePaymentCount: paymentRows.length,
    schedulerPaymentCount: bookingRows.filter((row) => row.booking.paidAmountCents > 0 || (row.meetingType.priceCents ?? 0) > 0).length,
    expenseCount: expenseRows.length,
  };
}

export async function getProjectFinancialSummary(projectId: string) {
  const projectInvoices = await db.query.invoices.findMany({
    where: eq(invoices.projectId, projectId),
    orderBy: asc(invoices.createdAt),
  });
  if (!projectInvoices.length) {
    const projectExpenses = await db.query.expenses.findMany({
      where: eq(expenses.projectId, projectId),
      orderBy: asc(expenses.paidAt),
    });
    if (!projectExpenses.length) return null;
  }

  const invoiceIds = projectInvoices.map((invoice) => invoice.id);
  const [paymentRows, bookingRows, expenseRows] = await Promise.all([
    invoiceIds.length
      ? db.query.invoicePayments.findMany({
          where: inArray(invoicePayments.invoiceId, invoiceIds),
          orderBy: asc(invoicePayments.dueDate),
        })
      : [],
    db
      .select({
        booking: schedulerBookings,
        meetingType: schedulerMeetingTypes,
      })
      .from(schedulerBookings)
      .innerJoin(schedulerMeetingTypes, eq(schedulerBookings.meetingTypeId, schedulerMeetingTypes.id))
      .where(eq(schedulerBookings.projectId, projectId))
      .orderBy(asc(schedulerBookings.startAt)) as Promise<SchedulerBookingPaymentLike[]>,
    db.query.expenses.findMany({
      where: eq(expenses.projectId, projectId),
      orderBy: asc(expenses.paidAt),
    }),
  ]);

  if (!projectInvoices.length && !bookingRows.length && !expenseRows.length) return null;

  return summarizeProjectFinancials({
    invoiceCount: projectInvoices.length,
    invoices: projectInvoices,
    invoicePayments: paymentRows,
    schedulerBookings: bookingRows,
    expenses: expenseRows,
  });
}
