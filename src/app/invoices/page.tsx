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
  const outstandingCents = rows.reduce((sum, row) => sum + (row.clientPayableBalanceCents ?? 0), 0);

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 sm:flex-row sm:items-end">
          <div>
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">The Reeses Studio</div>
            <h1 className="brand-page-title mt-2 text-5xl md:text-6xl">Invoices</h1>
            <p className="mt-2 font-[var(--serif)] text-xl italic text-[var(--ink-2)]">Track retainers, payment schedules, balances, and client invoice status.</p>
          </div>
          <Link href="/invoices/new" prefetch={false} className="brand-primary-button inline-flex items-center justify-center gap-2 px-4 py-2.5 transition">
            <Plus className="h-4 w-4" />
            Create invoice
          </Link>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="studio-card">
            <div className="studio-caps flex items-center gap-2 text-[0.58rem] text-[var(--ink-3)]">
              <ReceiptText className="h-4 w-4" />
              Outstanding
            </div>
            <div className="studio-stat-number mt-3">{formatMoney(outstandingCents)}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Total balance across invoice records.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Paid</div>
            <div className="studio-stat-number mt-3">{formatMoney(rows.reduce((sum, { invoice }) => sum + invoice.amountPaidCents, 0))}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Marked paid locally.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Open invoices</div>
            <div className="studio-stat-number mt-3">{rows.filter(({ invoice }) => invoice.status !== "paid" && invoice.status !== "void").length}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Draft, sent, partial, or overdue.</p>
          </div>
        </section>

        <section className="border-b border-[var(--line)] pb-5">
          <form action="/invoices" className="grid gap-3 md:grid-cols-[1fr_210px_auto]">
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Search invoices</span>
              <input name="q" defaultValue={search} placeholder="Invoice, project, client" className="studio-input" />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Status</span>
              <select name="status" defaultValue={status} className="studio-input">
                <option value="all">All statuses</option>
                {invoiceStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button className="brand-primary-button self-end px-4 py-2.5 transition">Apply</button>
          </form>
        </section>

        <section className="overflow-hidden border border-[var(--line)] bg-[var(--paper)]">
          <div className="studio-caps grid grid-cols-[1fr_1fr_140px_140px_130px] border-b border-[var(--line)] bg-[var(--paper-2)] px-4 py-3 text-[0.58rem] text-[var(--ink-3)] max-lg:hidden">
            <div>Invoice</div>
            <div>Project</div>
            <div>Due</div>
            <div>Status</div>
            <div>Balance</div>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {rows.map(({ invoice, project, client, proposal, clientPayableBalanceCents }) => (
              <Link key={invoice.id} href={`/invoices/${invoice.id}`} prefetch={false} className="grid gap-2 px-4 py-4 transition hover:bg-[var(--paper-2)] lg:grid-cols-[1fr_1fr_140px_140px_130px] lg:items-center">
                <div>
                  <div className="font-semibold">{invoice.invoiceNumber}</div>
                  <div className="mt-1 text-sm text-[var(--ink-3)]">{proposal?.title ?? "Standalone invoice"}</div>
                </div>
                <div>
                  <div className="text-sm font-medium">{project.name}</div>
                  {client ? (
                    <div className="mt-1 text-xs text-[var(--ink-3)]">{client.firstName} {client.lastName}</div>
                  ) : (
                    <div className="mt-1 text-xs font-semibold text-[var(--warning)]">Needs primary client</div>
                  )}
                </div>
                <div className="text-sm text-[var(--ink-3)]">{formatDate(invoice.dueDate)}</div>
                <div><span className="studio-chip">{invoice.status.replaceAll("_", " ")}</span></div>
                <div className="text-sm font-semibold">{formatMoney(clientPayableBalanceCents)}</div>
              </Link>
            ))}
            {!rows.length && <div className="p-8 text-sm text-[var(--ink-3)]">No invoices yet.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
