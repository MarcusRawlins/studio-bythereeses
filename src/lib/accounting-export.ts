// Phase 9a — QuickBooks Online / Xero import-friendly accountant export.
//
// Read-only + period-scoped. NO Stripe API call, NO accounting-platform API call — this
// only reads our DB and writes a generic transaction CSV (both QBO Online and Xero ingest
// this shape; IIF is QuickBooks-Desktop-only/legacy and out of scope). Direct QBO/Xero
// API sync (OAuth, posting journal entries) is deferred — it needs Tyler's platform
// credentials + choice (roadmap: 🅣).
//
// One row per money event (income, processor fee, refund, dispute loss, expense) so the
// accountant sees every line that hits the books. Debit/Credit are positive dollar
// amounts in the standard double-entry sense.

import { db } from "@/db/client";
import { expenses, invoicePayments, invoices, paymentDisputes, paymentRefunds, projects, schedulerBookings, schedulerMeetingTypes, vendors } from "@/db/schema";
import { and, type Column, eq, gte, inArray, lte, type SQL } from "drizzle-orm";

export type AccountingExportRow = {
  date: string | null;
  type: "Income" | "Processor fee" | "Refund" | "Dispute loss" | "Expense";
  description: string;
  reference: string | null;
  account: string;
  debitCents: number;
  creditCents: number;
  party: string | null;
  memo: string | null;
};

export type AccountingExportInput = {
  fromDate?: string | null;
  toDate?: string | null;
};

const ACCOUNT_INCOME = "Sales - Photography income";
const ACCOUNT_MERCHANT_FEES = "Merchant fees";
const ACCOUNT_REFUNDS = "Refunds and contra-revenue";
const ACCOUNT_DISPUTES = "Disputed chargebacks";

function isoFloorForDate(date: string) {
  return `${date}T00:00:00.000Z`;
}

function isoCeilingForDate(date: string) {
  return `${date}T23:59:59.999Z`;
}

function periodConditions(column: Column, input: AccountingExportInput) {
  const conditions: SQL[] = [];
  if (input.fromDate) conditions.push(gte(column, isoFloorForDate(input.fromDate)));
  if (input.toDate) conditions.push(lte(column, isoCeilingForDate(input.toDate)));
  return conditions;
}

export async function getAccountingExportRows(input: AccountingExportInput = {}): Promise<AccountingExportRow[]> {
  const rows: AccountingExportRow[] = [];

  // Income + processor fees from settled invoice payments (paid + refunded, scoped by
  // paidAt so the income stays in its original period; refunds are their own lines).
  const invoiceIncome = await db
    .select({ payment: invoicePayments, invoice: invoices, project: projects })
    .from(invoicePayments)
    .innerJoin(invoices, eq(invoicePayments.invoiceId, invoices.id))
    .innerJoin(projects, eq(invoices.projectId, projects.id))
    .where(and(
      inArray(invoicePayments.status, ["paid", "refunded"]),
      ...periodConditions(invoicePayments.paidAt, input),
    )) as Array<{ payment: typeof invoicePayments.$inferSelect; invoice: typeof invoices.$inferSelect; project: typeof projects.$inferSelect }>;
  for (const row of invoiceIncome) {
    rows.push({
      date: row.payment.paidAt,
      type: "Income",
      description: `${row.invoice.invoiceNumber} - ${row.payment.label}`,
      reference: row.payment.externalPaymentId,
      account: ACCOUNT_INCOME,
      debitCents: 0,
      creditCents: Math.max(row.payment.paidAmountCents, 0),
      party: row.project.name,
      memo: null,
    });
    if (row.payment.processingFeeCents > 0) {
      rows.push({
        date: row.payment.paidAt,
        type: "Processor fee",
        description: `Processing fee - ${row.invoice.invoiceNumber}`,
        reference: row.payment.externalPaymentId,
        account: ACCOUNT_MERCHANT_FEES,
        debitCents: Math.max(row.payment.processingFeeCents, 0),
        creditCents: 0,
        party: row.project.name,
        memo: null,
      });
    }
  }

  // Income + processor fees from paid scheduler bookings.
  const bookingIncome = await db
    .select({ booking: schedulerBookings, meetingType: schedulerMeetingTypes })
    .from(schedulerBookings)
    .innerJoin(schedulerMeetingTypes, eq(schedulerBookings.meetingTypeId, schedulerMeetingTypes.id))
    .where(and(
      eq(schedulerBookings.paymentStatus, "paid"),
      ...periodConditions(schedulerBookings.paidAt, input),
    )) as Array<{ booking: typeof schedulerBookings.$inferSelect; meetingType: typeof schedulerMeetingTypes.$inferSelect }>;
  for (const row of bookingIncome) {
    rows.push({
      date: row.booking.paidAt,
      type: "Income",
      description: row.meetingType.name,
      reference: row.booking.externalPaymentId,
      account: ACCOUNT_INCOME,
      debitCents: 0,
      creditCents: Math.max(row.booking.paidAmountCents, 0),
      party: row.booking.attendeeName,
      memo: null,
    });
    if (row.booking.processingFeeCents > 0) {
      rows.push({
        date: row.booking.paidAt,
        type: "Processor fee",
        description: `Processing fee - ${row.meetingType.name}`,
        reference: row.booking.externalPaymentId,
        account: ACCOUNT_MERCHANT_FEES,
        debitCents: Math.max(row.booking.processingFeeCents, 0),
        creditCents: 0,
        party: row.booking.attendeeName,
        memo: null,
      });
    }
  }

  // Refund lines (Debit contra-revenue) — succeeded only, scoped by money-event date.
  const refundRows = await db
    .select()
    .from(paymentRefunds)
    .where(and(
      eq(paymentRefunds.status, "succeeded"),
      ...periodConditions(paymentRefunds.createdAt, input),
    ));
  for (const row of refundRows) {
    rows.push({
      date: row.createdAt.slice(0, 10),
      type: "Refund",
      description: "Refund to client",
      reference: row.stripeRefundId,
      account: ACCOUNT_REFUNDS,
      debitCents: Math.max(row.amountCents, 0),
      creditCents: 0,
      party: null,
      memo: row.reason,
    });
  }

  // Dispute-loss lines (Debit) — lost, not reinstated, scoped by money-event date.
  const disputeRows = await db
    .select()
    .from(paymentDisputes)
    .where(and(
      eq(paymentDisputes.status, "lost"),
      eq(paymentDisputes.fundsReinstated, 0),
      ...periodConditions(paymentDisputes.createdAt, input),
    ));
  for (const row of disputeRows) {
    rows.push({
      date: row.createdAt.slice(0, 10),
      type: "Dispute loss",
      description: "Lost dispute / chargeback",
      reference: row.stripeDisputeId,
      account: ACCOUNT_DISPUTES,
      debitCents: Math.max(row.amountCents, 0),
      creditCents: 0,
      party: null,
      memo: row.reason,
    });
  }

  // Expense lines (Debit expense-by-category).
  const expenseRows = await db
    .select({ expense: expenses, vendor: vendors, project: projects })
    .from(expenses)
    .innerJoin(vendors, eq(expenses.vendorId, vendors.id))
    .leftJoin(projects, eq(expenses.projectId, projects.id))
    .where(and(
      eq(expenses.status, "paid"),
      ...periodConditions(expenses.paidAt, input),
    )) as Array<{ expense: typeof expenses.$inferSelect; vendor: typeof vendors.$inferSelect; project: typeof projects.$inferSelect | null }>;
  for (const row of expenseRows) {
    rows.push({
      date: row.expense.paidAt,
      type: "Expense",
      description: row.expense.description,
      reference: row.expense.externalPaymentId,
      account: `Expenses - ${row.expense.category || "general"}`,
      debitCents: Math.max(row.expense.amountCents, 0),
      creditCents: 0,
      party: row.vendor.name,
      memo: row.project?.name ?? null,
    });
  }

  return rows.sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")) || a.type.localeCompare(b.type));
}

function csvCell(value: string | number | null | undefined) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function centsCsv(value: number) {
  return value ? (value / 100).toFixed(2) : "";
}

export function accountingExportCsv(rows: AccountingExportRow[], options: AccountingExportInput = {}) {
  const header = ["Date", "Type", "Description", "Reference", "Account", "Debit", "Credit", "Party", "Memo"];
  const comment = [
    `# The Reeses Studio accounting export`,
    `period ${options.fromDate || "all"} to ${options.toDate || "all"}`,
    `amounts in USD; import into QuickBooks Online or Xero as a generic transaction CSV`,
  ].join(" | ");
  const body = rows.map((row) => [
    row.date,
    row.type,
    row.description,
    row.reference,
    row.account,
    centsCsv(row.debitCents),
    centsCsv(row.creditCents),
    row.party,
    row.memo,
  ]);
  return [[comment], header, ...body].map((row) => row.map(csvCell).join(",")).join("\n");
}
