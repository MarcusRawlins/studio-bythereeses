import { AppShell } from "@/components/AppShell";
import { formatDate, formatMoney } from "@/lib/format";
import { invoiceStatusOptions, listInvoices } from "@/lib/sales";
import { Plus, ReceiptText } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams ? await searchParams : {};
  const search = firstQueryValue(params.q) ?? "";
  const status = firstQueryValue(params.status) ?? "all";
  const rows = await listInvoices(search, status);
  const outstandingCents = rows.reduce((sum, { invoice }) => sum + Math.max(invoice.totalCents - invoice.amountPaidCents, 0), 0);

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 sm:flex-row sm:items-end">
          <div>
            <h1 className="brand-page-title text-4xl">Invoices</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">Track retainers, payment schedules, balances, and client invoice status.</p>
          </div>
          <Link href="/invoices/new" prefetch={false} className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 transition">
            <Plus className="h-4 w-4" />
            Create invoice
          </Link>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <ReceiptText className="h-4 w-4" />
              Outstanding
            </div>
            <div className="mt-3 text-3xl font-semibold">{formatMoney(outstandingCents)}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Total balance across invoice records.</p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Paid</div>
            <div className="mt-3 text-3xl font-semibold">{formatMoney(rows.reduce((sum, { invoice }) => sum + invoice.amountPaidCents, 0))}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Marked paid locally.</p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Open invoices</div>
            <div className="mt-3 text-3xl font-semibold">{rows.filter(({ invoice }) => invoice.status !== "paid" && invoice.status !== "void").length}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Draft, sent, partial, or overdue.</p>
          </div>
        </section>

        <section className="border-b border-[var(--line)] pb-5">
          <form action="/invoices" className="grid gap-3 md:grid-cols-[1fr_210px_auto]">
            <label className="space-y-1.5 text-sm font-medium">
              Search invoices
              <input name="q" defaultValue={search} placeholder="Invoice, project, client" className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none transition focus:border-[var(--foreground)]" />
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              Status
              <select name="status" defaultValue={status} className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none transition focus:border-[var(--foreground)]">
                <option value="all">All statuses</option>
                {invoiceStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button className="brand-primary-button self-end rounded-sm px-4 py-2.5 transition">Apply</button>
          </form>
        </section>

        <section className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)] shadow-sm">
          <div className="grid grid-cols-[1fr_1fr_140px_140px_130px] border-b border-[var(--line)] bg-[#eee8de] px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)] max-lg:hidden">
            <div>Invoice</div>
            <div>Project</div>
            <div>Due</div>
            <div>Status</div>
            <div>Balance</div>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {rows.map(({ invoice, project, client, proposal }) => (
              <Link key={invoice.id} href={`/invoices/${invoice.id}`} prefetch={false} className="grid gap-2 px-4 py-4 transition hover:bg-[#f6efe5] lg:grid-cols-[1fr_1fr_140px_140px_130px] lg:items-center">
                <div>
                  <div className="font-semibold">{invoice.invoiceNumber}</div>
                  <div className="mt-1 text-sm text-[var(--ink-muted)]">{proposal?.title ?? "Standalone invoice"}</div>
                </div>
                <div>
                  <div className="text-sm font-medium">{project.name}</div>
                  <div className="mt-1 text-xs text-[var(--ink-muted)]">{client.firstName} {client.lastName}</div>
                </div>
                <div className="text-sm text-[var(--ink-muted)]">{formatDate(invoice.dueDate)}</div>
                <div className="text-sm capitalize text-[var(--ink-muted)]">{invoice.status.replaceAll("_", " ")}</div>
                <div className="text-sm font-semibold">{formatMoney(invoice.totalCents - invoice.amountPaidCents)}</div>
              </Link>
            ))}
            {!rows.length && <div className="p-8 text-sm text-[var(--ink-muted)]">No invoices yet.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
