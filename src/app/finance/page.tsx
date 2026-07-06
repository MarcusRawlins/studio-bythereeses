import { AppShell } from "@/components/AppShell";
import { getBookkeepingReport } from "@/lib/bookkeeping";
import { formatDate, formatMoney } from "@/lib/format";
import { getPaymentLedgerReport, listProjectOptions } from "@/lib/sales";
import { getRefundInitiationReconciliationWithContext } from "@/lib/stripe-refund-initiation";
import { AlertTriangle, Download, Landmark, Pencil, Plus, ReceiptText, TrendingUp } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const ledgerStatusOptions = [
  { value: "all", label: "All payments" },
  { value: "needs_reconciliation", label: "Needs reconciliation" },
  { value: "unpaid", label: "Unpaid" },
  { value: "pending", label: "Pending" },
  { value: "paid", label: "Paid" },
  { value: "refunded", label: "Refunded" },
  { value: "waived", label: "Waived" },
];

function periodHref(path: string, params: Record<string, string | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function paymentMissingEvidence(row: Awaited<ReturnType<typeof getPaymentLedgerReport>>["rows"][number]) {
  if (row.payment.status !== "paid") return [];
  const missing: string[] = [];
  if (!row.payment.externalPaymentId) missing.push("Missing settlement ID");
  if (!row.paymentSourceType || !row.paymentSourceId) missing.push("Missing source");
  return missing;
}

function expenseMissingEvidence(row: Awaited<ReturnType<typeof getBookkeepingReport>>["expenses"][number]) {
  if (row.expense.status !== "paid") return [];
  const missing: string[] = [];
  if (!row.expense.externalPaymentId) missing.push("Missing settlement ID");
  if (!row.expense.receiptUrl) missing.push("Missing receipt");
  if (!row.expense.sourceType || !row.expense.sourceId) missing.push("Missing source");
  return missing;
}

export default async function FinancePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams ? await searchParams : {};
  const status = firstQueryValue(params.status) ?? "all";
  const expenseStatus = firstQueryValue(params.expenseStatus) ?? "paid";
  const fromDate = firstQueryValue(params.fromDate) ?? "";
  const toDate = firstQueryValue(params.toDate) ?? "";
  const asOfDate = firstQueryValue(params.asOfDate) ?? "";
  const saved = firstQueryValue(params.saved);
  const selectedExpenseId = firstQueryValue(params.expenseId) ?? "";
  const [report, books, projectOptions, refundReconciliation] = await Promise.all([
    getPaymentLedgerReport({ status, fromDate, toDate, asOfDate }),
    getBookkeepingReport({ status: expenseStatus, fromDate, toDate }),
    listProjectOptions(),
    // Phase 9b §4.4: always-on read of the two refund-initiation reconciliation tripwires
    // (succeeded-but-unrecorded, stuck-submitting). No flag; empty/inert until a refund has
    // actually been initiated, so this is a no-op section while REFUND_INITIATION_ENABLED is off.
    getRefundInitiationReconciliationWithContext(),
  ]);
  const exportHref = periodHref("/api/finance/payment-ledger.csv", { status, fromDate, toDate });
  const arAgingExportHref = periodHref("/api/finance/ar-aging.csv", { status, fromDate, toDate, asOfDate });
  const bookkeepingSummaryExportHref = periodHref("/api/finance/bookkeeping-summary.csv", { expenseStatus, fromDate, toDate });
  const expenseExportHref = periodHref("/api/finance/expenses.csv", { expenseStatus, fromDate, toDate });
  const firstExpenseRows = books.expenses.slice(0, 8);
  const selectedExpenseRow = selectedExpenseId
    ? books.expenses.find((row) => row.expense.id === selectedExpenseId)
    : undefined;
  const visibleExpenseRows = selectedExpenseRow && !firstExpenseRows.some((row) => row.expense.id === selectedExpenseRow.expense.id)
    ? [selectedExpenseRow, ...firstExpenseRows]
    : firstExpenseRows;

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 sm:flex-row sm:items-end">
          <div>
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Books</div>
            <h1 className="brand-page-title mt-2 text-5xl md:text-6xl">Finance</h1>
            <p className="mt-2 font-[var(--serif)] text-xl italic text-[var(--ink-2)]">
              Accounts receivable, expenses, and book-of-record cash movement.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href="/finance/intelligence" className="brand-secondary-button inline-flex items-center justify-center gap-2 px-4 py-2.5 transition">
              Intelligence
            </a>
            <a href={exportHref} className="brand-secondary-button inline-flex items-center justify-center gap-2 px-4 py-2.5 transition">
              <Download className="h-4 w-4" />
              Payments CSV
            </a>
            <a href={arAgingExportHref} className="brand-secondary-button inline-flex items-center justify-center gap-2 px-4 py-2.5 transition">
              <Download className="h-4 w-4" />
              A/R Aging CSV
            </a>
            <a href={bookkeepingSummaryExportHref} className="brand-secondary-button inline-flex items-center justify-center gap-2 px-4 py-2.5 transition">
              <Download className="h-4 w-4" />
              Books Summary CSV
            </a>
            <a href={expenseExportHref} className="brand-primary-button inline-flex items-center justify-center gap-2 px-4 py-2.5 transition">
              <Download className="h-4 w-4" />
              Expenses CSV
            </a>
          </div>
        </header>

        {saved === "expense" && (
          <div className="border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3 text-sm font-medium">
            Expense saved to the canonical Studio ledger.
          </div>
        )}

        {refundReconciliation.totalCount > 0 && (
          <section className="border border-[var(--warning)] bg-[var(--paper)] p-4">
            <div className="flex items-center gap-2 text-[var(--warning)]">
              <AlertTriangle className="h-4 w-4" />
              <div className="studio-caps text-[0.58rem]">Refund initiation reconciliation</div>
            </div>
            <h2 className="mt-1 text-lg font-semibold">Needs manual reconciliation</h2>
            <div className="mt-4 divide-y divide-[var(--line)]">
              {refundReconciliation.stuckSubmitting.map((row) => (
                <div key={row.initiationId} className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[1fr_auto] sm:items-center">
                  <div>
                    <div className="text-sm font-semibold">Refund stuck in-flight — reconcile against Stripe</div>
                    <div className="mt-1 text-xs text-[var(--ink-3)]">
                      {row.paymentLabel ?? "Payment"} {row.invoiceNumber ? `· ${row.invoiceNumber}` : ""} · initiation {row.initiationId}
                    </div>
                  </div>
                  <div className="text-left sm:text-right">
                    <div className="text-sm font-semibold">{formatMoney(row.amountCents)}</div>
                    {row.href
                      ? <Link href={row.href} prefetch={false} className="mt-1 inline-flex text-xs font-semibold text-[var(--accent)] underline-offset-4 hover:underline">View payment</Link>
                      : <div className="mt-1 text-xs text-[var(--ink-3)]">{formatDate(row.updatedAt)}</div>}
                  </div>
                </div>
              ))}
              {refundReconciliation.initiatedNotRecorded.map((row) => (
                <div key={row.initiationId} className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[1fr_auto] sm:items-center">
                  <div>
                    <div className="text-sm font-semibold">Initiated refund not yet recorded</div>
                    <div className="mt-1 text-xs text-[var(--ink-3)]">
                      {row.paymentLabel ?? "Payment"} {row.invoiceNumber ? `· ${row.invoiceNumber}` : ""} · {row.stripeRefundId ?? "no Stripe refund id yet"}
                    </div>
                  </div>
                  <div className="text-left sm:text-right">
                    <div className="text-sm font-semibold">{formatMoney(row.amountCents)}</div>
                    {row.href
                      ? <Link href={row.href} prefetch={false} className="mt-1 inline-flex text-xs font-semibold text-[var(--accent)] underline-offset-4 hover:underline">View payment</Link>
                      : <div className="mt-1 text-xs text-[var(--ink-3)]">{formatDate(row.updatedAt)}</div>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="studio-card">
            <div className="studio-caps flex items-center gap-2 text-[0.58rem] text-[var(--ink-3)]">
              <ReceiptText className="h-4 w-4" />
              Open receivable
            </div>
            <div className="studio-stat-number mt-3">{formatMoney(report.totals.clientPayableOpenCents)}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Client-payable balance still pending.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Paid services</div>
            <div className="studio-stat-number mt-3">{formatMoney(books.totals.revenueCents)}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Service dollars recorded paid.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Gross collected</div>
            <div className="studio-stat-number mt-3">{formatMoney(books.totals.grossCollectedCents)}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Client payment plus passed-through fees.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Client-paid fees</div>
            <div className="studio-stat-number mt-3">{formatMoney(books.totals.clientFeeCents)}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Card fees assigned to clients.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Processor fees</div>
            <div className="studio-stat-number mt-3">{formatMoney(books.totals.processingFeeCents)}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Fees recorded on paid settlement rows.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Net deposits</div>
            <div className="studio-stat-number mt-3">{formatMoney(books.totals.netDepositCents)}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Actual cash expected after processor fees.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Expenses</div>
            <div className="studio-stat-number mt-3">{formatMoney(books.totals.paidExpenseCents)}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Paid costs in the expense ledger.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Accounts payable</div>
            <div className="studio-stat-number mt-3">{formatMoney(books.totals.openPayableCents)}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Unpaid vendor costs still owed.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps flex items-center gap-2 text-[0.58rem] text-[var(--ink-3)]">
              <TrendingUp className="h-4 w-4" />
              Net income
            </div>
            <div className="studio-stat-number mt-3">{formatMoney(books.totals.netIncomeCents)}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Net deposits minus paid expenses.</p>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
          <div className="border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">A/R aging</div>
                <h2 className="mt-1 text-lg font-semibold">Open receivables</h2>
              </div>
              <div className="text-xs text-[var(--ink-3)]">As of {formatDate(report.aging.asOfDate)}</div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-5">
              {report.aging.buckets.map((bucket) => (
                <div key={bucket.bucket} className="border border-[var(--line)] bg-[var(--paper-2)] p-3">
                  <div className="studio-caps text-[0.55rem] text-[var(--ink-3)]">{bucket.label}</div>
                  <div className="mt-2 text-lg font-semibold">{formatMoney(bucket.openCents)}</div>
                  <div className="mt-1 text-xs text-[var(--ink-3)]">{bucket.count} record{bucket.count === 1 ? "" : "s"}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Collections watch</div>
            <h2 className="mt-1 text-lg font-semibold">Oldest open payments</h2>
            <div className="mt-4 divide-y divide-[var(--line)]">
              {report.aging.rows.slice(0, 5).map((row) => (
                <Link key={`${row.sourceType}-${row.sourceId}`} href={row.href} prefetch={false} className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[1fr_auto] sm:items-center">
                  <div>
                    <div className="text-sm font-semibold">{row.projectName}</div>
                    <div className="mt-1 text-xs text-[var(--ink-3)]">{row.clientName} · {row.invoiceNumber} · {row.paymentLabel}</div>
                  </div>
                  <div className="text-left sm:text-right">
                    <div className="text-sm font-semibold">{formatMoney(row.openCents)}</div>
                    <div className="mt-1 text-xs text-[var(--ink-3)]">{row.daysPastDue} days · {formatDate(row.dueDate)}</div>
                  </div>
                </Link>
              ))}
              {!report.aging.rows.length && <p className="py-3 text-sm text-[var(--ink-3)]">No open receivables need attention.</p>}
            </div>
          </div>
        </section>

        <section className="border border-[var(--line)] bg-[var(--paper)] p-4">
          <form action="/finance" className="grid gap-3 md:grid-cols-[160px_160px_160px_160px_160px_auto] md:items-end">
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">From</span>
              <input name="fromDate" type="date" defaultValue={fromDate} className="studio-input" />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">To</span>
              <input name="toDate" type="date" defaultValue={toDate} className="studio-input" />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">A/R as of</span>
              <input name="asOfDate" type="date" defaultValue={asOfDate} className="studio-input" />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Payments</span>
              <select name="status" defaultValue={status} className="studio-input">
                {ledgerStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Expenses</span>
              <select name="expenseStatus" defaultValue={expenseStatus} className="studio-input">
                <option value="needs_reconciliation">Needs reconciliation</option>
                <option value="paid">Paid</option>
                <option value="unpaid">Unpaid</option>
                <option value="refunded">Refunded</option>
                <option value="void">Void</option>
                <option value="all">All</option>
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <button className="brand-primary-button px-4 py-2.5 transition">Apply period</button>
              <Link href="/finance" prefetch={false} className="brand-secondary-button px-4 py-2.5 transition">Clear</Link>
            </div>
          </form>
        </section>

        <section className="grid gap-5 lg:grid-cols-3">
          <div className="border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Tax posture</div>
            <h2 className="mt-1 text-lg font-semibold">Deductibility</h2>
            <div className="mt-4 grid gap-3">
              <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] pb-3">
                <span className="text-sm text-[var(--ink-3)]">Tax deductible</span>
                <span className="font-semibold">{formatMoney(books.totals.taxDeductibleExpenseCents)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-[var(--ink-3)]">Not deductible</span>
                <span className="font-semibold">{formatMoney(books.totals.nonDeductibleExpenseCents)}</span>
              </div>
            </div>
          </div>

          <div className="border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Expense categories</div>
            <h2 className="mt-1 text-lg font-semibold">Top categories</h2>
            <div className="mt-4 divide-y divide-[var(--line)]">
              {books.expensesByCategory.slice(0, 5).map((row) => (
                <div key={row.category} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <div>
                    <div className="text-sm font-medium capitalize">{row.category}</div>
                    <div className="text-xs text-[var(--ink-3)]">{row.count} record{row.count === 1 ? "" : "s"} · {formatMoney(row.taxDeductibleExpenseCents)} deductible</div>
                  </div>
                  <div className="font-semibold">{formatMoney(row.expenseCents)}</div>
                </div>
              ))}
              {!books.expensesByCategory.length && <p className="py-3 text-sm text-[var(--ink-3)]">No expenses in this period.</p>}
            </div>
          </div>

          <div className="border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Vendors</div>
            <h2 className="mt-1 text-lg font-semibold">Top vendors</h2>
            <div className="mt-4 divide-y divide-[var(--line)]">
              {books.expensesByVendor.slice(0, 5).map((row) => (
                <div key={row.vendorId} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <div>
                    <div className="text-sm font-medium">{row.vendorName}</div>
                    <div className="text-xs text-[var(--ink-3)]">{row.count} record{row.count === 1 ? "" : "s"} · {formatMoney(row.taxDeductibleExpenseCents)} deductible</div>
                  </div>
                  <div className="font-semibold">{formatMoney(row.expenseCents)}</div>
                </div>
              ))}
              {!books.expensesByVendor.length && <p className="py-3 text-sm text-[var(--ink-3)]">No vendor spend in this period.</p>}
            </div>
          </div>
        </section>

        <section className="grid gap-5 border-b border-[var(--line)] pb-5 lg:grid-cols-[1fr_1.15fr]">
          <form action="/api/finance/expenses" method="post" className="space-y-4 border border-[var(--line)] bg-[var(--paper)] p-4">
            <input type="hidden" name="fromDate" value={fromDate} />
            <input type="hidden" name="toDate" value={toDate} />
            <input type="hidden" name="asOfDate" value={asOfDate} />
            <input type="hidden" name="ledgerStatus" value={status} />
            <input type="hidden" name="expenseStatus" value={expenseStatus} />
            <div>
              <div className="studio-caps flex items-center gap-2 text-[0.58rem] text-[var(--ink-3)]">
                <Plus className="h-4 w-4" />
                New expense
              </div>
              <h2 className="mt-1 text-lg font-semibold">Record a cost</h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Vendor</span>
                <input name="vendorName" required placeholder="Adobe, Canon, second shooter" className="studio-input" />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Project</span>
                <select name="projectId" className="studio-input" defaultValue="">
                  <option value="">Studio overhead</option>
                  {projectOptions.map(({ project }) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Category</span>
                <select name="category" className="studio-input" defaultValue="general">
                  <option value="general">General</option>
                  <option value="equipment">Equipment</option>
                  <option value="software">Software</option>
                  <option value="contractor">Contractor</option>
                  <option value="travel">Travel</option>
                  <option value="marketing">Marketing</option>
                  <option value="office">Office</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Amount</span>
                <input name="amount" required inputMode="decimal" placeholder="125.00" className="studio-input" />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Paid date</span>
                <input name="paidAt" type="date" className="studio-input" />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Method</span>
                <input name="paymentMethod" placeholder="Amex, ACH, cash" className="studio-input" />
              </label>
            </div>
            <label className="grid gap-1.5 text-sm font-medium">
              <span>Description</span>
              <input name="description" placeholder="What was purchased" className="studio-input" />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Status</span>
                <select name="status" className="studio-input" defaultValue="paid">
                  <option value="paid">Paid</option>
                  <option value="unpaid">Unpaid</option>
                  <option value="refunded">Refunded</option>
                  <option value="void">Void</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Reference</span>
                <input name="externalPaymentId" placeholder="Card charge or bank reference" className="studio-input" />
              </label>
            </div>
            <label className="grid gap-1.5 text-sm font-medium">
              <span>Receipt URL</span>
              <input name="receiptUrl" placeholder="https://..." className="studio-input" />
            </label>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input name="taxDeductible" type="checkbox" defaultChecked className="h-4 w-4" />
              Tax deductible
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              <span>Notes</span>
              <textarea name="notes" rows={3} placeholder="Bookkeeping notes or receipt context" className="studio-input" />
            </label>
            <button className="brand-primary-button inline-flex items-center justify-center gap-2 px-4 py-2.5 transition">
              <Plus className="h-4 w-4" />
              Save expense
            </button>
          </form>

          <div className="space-y-5">
          {selectedExpenseRow ? (
            <form action="/api/finance/expenses" method="post" className="space-y-4 border border-[var(--accent)] bg-[var(--accent-soft)] p-4">
              <input type="hidden" name="_action" value="update" />
              <input type="hidden" name="expenseId" value={selectedExpenseRow.expense.id} />
              <input type="hidden" name="fromDate" value={fromDate} />
              <input type="hidden" name="toDate" value={toDate} />
              <input type="hidden" name="asOfDate" value={asOfDate} />
              <input type="hidden" name="ledgerStatus" value={status} />
              <input type="hidden" name="expenseStatus" value={expenseStatus} />
              <div>
                <div className="studio-caps flex items-center gap-2 text-[0.58rem] text-[var(--ink-3)]">
                  <Pencil className="h-4 w-4" />
                  Edit selected expense
                </div>
                <h2 className="mt-1 text-lg font-semibold">{selectedExpenseRow.vendor.name}</h2>
                <p className="mt-1 text-xs text-[var(--ink-3)]">Corrected costs update the same canonical ledger row.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium">
                  <span>Vendor</span>
                  <input name="vendorName" required defaultValue={selectedExpenseRow.vendor.name} className="studio-input" />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  <span>Project</span>
                  <select name="projectId" className="studio-input" defaultValue={selectedExpenseRow.expense.projectId ?? ""}>
                    <option value="">Studio overhead</option>
                    {projectOptions.map(({ project }) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  <span>Category</span>
                  <select name="category" className="studio-input" defaultValue={selectedExpenseRow.expense.category}>
                    <option value="general">General</option>
                    <option value="equipment">Equipment</option>
                    <option value="software">Software</option>
                    <option value="contractor">Contractor</option>
                    <option value="travel">Travel</option>
                    <option value="marketing">Marketing</option>
                    <option value="office">Office</option>
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  <span>Amount</span>
                  <input name="amount" required inputMode="decimal" defaultValue={(selectedExpenseRow.expense.amountCents / 100).toFixed(2)} className="studio-input" />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  <span>Paid date</span>
                  <input name="paidAt" type="date" defaultValue={selectedExpenseRow.expense.paidAt ?? ""} className="studio-input" />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  <span>Method</span>
                  <input name="paymentMethod" defaultValue={selectedExpenseRow.expense.paymentMethod ?? ""} className="studio-input" />
                </label>
              </div>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Description</span>
                <input name="description" defaultValue={selectedExpenseRow.expense.description} className="studio-input" />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium">
                  <span>Status</span>
                  <select name="status" className="studio-input" defaultValue={selectedExpenseRow.expense.status}>
                    <option value="paid">Paid</option>
                    <option value="unpaid">Unpaid</option>
                    <option value="refunded">Refunded</option>
                    <option value="void">Void</option>
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  <span>Reference</span>
                  <input name="externalPaymentId" defaultValue={selectedExpenseRow.expense.externalPaymentId ?? ""} className="studio-input" />
                </label>
              </div>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Receipt URL</span>
                <input name="receiptUrl" defaultValue={selectedExpenseRow.expense.receiptUrl ?? ""} className="studio-input" />
              </label>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input name="taxDeductible" type="checkbox" defaultChecked={Boolean(selectedExpenseRow.expense.taxDeductible)} className="h-4 w-4" />
                Tax deductible
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Notes</span>
                <textarea name="notes" rows={3} defaultValue={selectedExpenseRow.expense.notes ?? ""} className="studio-input" />
              </label>
              <button className="brand-primary-button inline-flex items-center justify-center gap-2 px-4 py-2.5 transition">
                <Pencil className="h-4 w-4" />
                Update expense
              </button>
            </form>
          ) : null}

          <section className="border border-[var(--line)] bg-[var(--paper)]">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--paper-2)] px-4 py-3">
              <div>
                <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Expense ledger</div>
                <h2 className="mt-1 font-semibold">Costs by vendor</h2>
              </div>
              <form action="/finance" className="flex items-end gap-2">
                <input type="hidden" name="status" value={status} />
                <input type="hidden" name="fromDate" value={fromDate} />
                <input type="hidden" name="toDate" value={toDate} />
                <input type="hidden" name="asOfDate" value={asOfDate} />
                <label className="grid gap-1 text-xs font-medium">
                  <span className="studio-caps text-[0.55rem] text-[var(--ink-3)]">Status</span>
                  <select name="expenseStatus" defaultValue={expenseStatus} className="studio-input min-w-32 py-1.5 text-xs">
                    <option value="needs_reconciliation">Needs reconciliation</option>
                    <option value="paid">Paid</option>
                    <option value="unpaid">Unpaid</option>
                    <option value="refunded">Refunded</option>
                    <option value="void">Void</option>
                    <option value="all">All</option>
                  </select>
                </label>
                <button className="brand-secondary-button px-3 py-1.5 text-xs transition">Apply</button>
              </form>
            </div>
            <div className="divide-y divide-[var(--line)]">
              {visibleExpenseRows.map((row) => {
                const isSelectedExpense = row.expense.id === selectedExpenseId;
                const missingEvidence = expenseMissingEvidence(row);
                const expenseEditHref = `${periodHref("/finance", {
                  expenseId: row.expense.id,
                  status,
                  expenseStatus,
                  fromDate,
                  toDate,
                  asOfDate,
                })}#expense-${row.expense.id}`;

                return (
                <div
                  key={row.expense.id}
                  id={`expense-${row.expense.id}`}
                  className={isSelectedExpense
                    ? "scroll-mt-6 grid gap-3 border-l-4 border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center"
                    : "scroll-mt-6 grid gap-3 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center"}
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="font-semibold">{row.vendor.name}</div>
                      {isSelectedExpense ? <span className="studio-chip">Selected</span> : null}
                    </div>
                    <div className="mt-1 text-sm text-[var(--ink-3)]">
                      {row.expense.description} · {row.project?.name ?? "Studio overhead"}
                    </div>
                    {(row.expense.receiptUrl || row.expense.sourceType) && (
                      <div className="mt-1 truncate text-xs text-[var(--ink-3)]">
                        {row.expense.receiptUrl ?? `${row.expense.sourceType}: ${row.expense.sourceId ?? "unlinked"}`}
                      </div>
                    )}
                    {missingEvidence.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {missingEvidence.map((label) => (
                          <span key={label} className="studio-caps border border-[var(--warning)] px-2 py-1 text-[0.52rem] text-[var(--warning)]">
                            {label}
                          </span>
                        ))}
                      </div>
                    )}
                    {isSelectedExpense && row.expense.notes ? (
                      <div className="mt-2 text-xs text-[var(--ink-2)]">{row.expense.notes}</div>
                    ) : null}
                  </div>
                  <div className="text-left sm:text-right">
                    <div className="font-semibold">{formatMoney(row.expense.amountCents)}</div>
                    <div className="mt-1 text-xs text-[var(--ink-3)]">{formatDate(row.expense.paidAt)} · {row.expense.category}</div>
                    <Link href={expenseEditHref} prefetch={false} className="mt-2 inline-flex text-xs font-semibold text-[var(--accent)] underline-offset-4 hover:underline">
                      Edit expense
                    </Link>
                  </div>
                </div>
                );
              })}
              {!books.expenses.length && <div className="p-8 text-sm text-[var(--ink-3)]">No expenses match this filter.</div>}
            </div>
          </section>
          </div>
        </section>

        <section className="border-b border-[var(--line)] pb-5">
          <form action="/finance" className="grid gap-3 md:grid-cols-[240px_auto]">
            <input type="hidden" name="expenseStatus" value={expenseStatus} />
            <input type="hidden" name="fromDate" value={fromDate} />
            <input type="hidden" name="toDate" value={toDate} />
            <input type="hidden" name="asOfDate" value={asOfDate} />
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Ledger status</span>
              <select name="status" defaultValue={status} className="studio-input">
                {ledgerStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button className="brand-primary-button self-end px-4 py-2.5 transition md:w-fit">Apply</button>
          </form>
        </section>

        <section className="overflow-hidden border border-[var(--line)] bg-[var(--paper)]">
          <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[var(--paper-2)] px-4 py-3">
            <Landmark className="h-4 w-4 text-[var(--ink-3)]" />
            <div>
              <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Payment ledger</div>
              <div className="mt-1 text-sm text-[var(--ink-3)]">Expected net deposit: {formatMoney(report.totals.netDepositCents)}</div>
            </div>
          </div>
          <div className="studio-caps grid grid-cols-[1.1fr_1.2fr_120px_110px_110px_110px_110px_1fr] border-b border-[var(--line)] bg-[var(--paper-2)] px-4 py-3 text-[0.58rem] text-[var(--ink-3)] max-xl:hidden">
            <div>Record</div>
            <div>Project</div>
            <div>Due</div>
            <div>Status</div>
            <div>Paid</div>
            <div>Gross</div>
            <div>Net</div>
            <div>Reference</div>
          </div>
            <div className="divide-y divide-[var(--line)]">
            {report.rows.map((row) => {
              const missingEvidence = paymentMissingEvidence(row);
              return (
                <Link key={`${row.sourceType}-${row.sourceId}`} href={row.href} prefetch={false} className="grid gap-3 px-4 py-4 transition hover:bg-[var(--paper-2)] xl:grid-cols-[1.1fr_1.2fr_120px_110px_110px_110px_110px_1fr] xl:items-center">
                  <div>
                    <div className="font-semibold">{row.invoice.invoiceNumber}</div>
                    <div className="mt-1 text-sm text-[var(--ink-3)]">{row.payment.label}</div>
                  </div>
                  <div>
                    <div className="text-sm font-medium">{row.project.name}</div>
                    <div className="mt-1 text-xs text-[var(--ink-3)]">{row.clientName}</div>
                  </div>
                  <div className="text-sm text-[var(--ink-3)]">{formatDate(row.payment.dueDate)}</div>
                  <div><span className="studio-chip">{row.payment.status.replaceAll("_", " ")}</span></div>
                  <div className="text-sm font-semibold">{formatMoney(row.payment.paidAmountCents)}</div>
                  <div className="text-sm text-[var(--ink-3)]">{formatMoney(row.payment.grossCollectedCents)}</div>
                  <div className="text-sm text-[var(--ink-3)]">{formatMoney(row.payment.netDepositCents)}</div>
                  <div className="min-w-0 text-xs text-[var(--ink-3)]">
                    <div className="truncate">{row.payment.externalPaymentId ?? "Not reconciled"}</div>
                    <div className="mt-1">{row.payment.paymentMethod ?? "Method TBD"}</div>
                    {row.paymentSourceType && row.paymentSourceId && (
                      <div className="mt-1 truncate">{row.paymentSourceType}: {row.paymentSourceId}</div>
                    )}
                    {missingEvidence.length > 0 && (
                      <div className="mt-1">
                        <div className="studio-caps text-[0.55rem] text-[var(--warning)]">Settlement missing</div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {missingEvidence.map((label) => (
                            <span key={label} className="studio-caps border border-[var(--warning)] px-2 py-1 text-[0.52rem] text-[var(--warning)]">
                              {label}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </Link>
              );
            })}
            {!report.rows.length && <div className="p-8 text-sm text-[var(--ink-3)]">No payment ledger rows match this filter.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
