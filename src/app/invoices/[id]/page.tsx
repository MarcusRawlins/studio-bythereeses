import { AppShell } from "@/components/AppShell";
import { formatDate, formatMoney } from "@/lib/format";
import { getInvoice, invoiceStatusOptions } from "@/lib/sales";
import { CreditCard, ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

function parseAcceptedPaymentMethods(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as Array<{ key: string; displayName: string; instructions?: string; passFees?: boolean }>;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getInvoice(id);
  if (!data) notFound();
  const acceptedPaymentMethods = parseAcceptedPaymentMethods(data.invoice.acceptedPaymentMethodsJson);

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 lg:flex-row lg:items-end">
          <div>
            <Link href="/invoices" className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">Back to invoices</Link>
            <h1 className="brand-page-title mt-3 text-4xl">{data.invoice.invoiceNumber}</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">{data.project.name} · {data.client.firstName} {data.client.lastName}</p>
          </div>
          <Link href={`/projects/${data.project.id}`} className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--foreground)]">
            <ExternalLink className="h-4 w-4" />
            View project
          </Link>
        </header>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Total</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(data.invoice.totalCents)}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Paid</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(data.invoice.amountPaidCents)}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Balance</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(data.balanceCents)}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Due</div>
            <div className="mt-2 text-2xl font-semibold">{formatDate(data.invoice.dueDate)}</div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="text-lg font-semibold">Payment schedule</h2>
            </div>
            <div className="mt-4 divide-y divide-[var(--line)]">
              {data.payments.map((payment) => (
                <form key={payment.id} action={`/api/invoices/${data.invoice.id}/payments`} method="post" className="grid gap-3 py-4 lg:grid-cols-[1fr_130px_150px_170px] lg:items-end">
                  <input type="hidden" name="invoiceId" value={data.invoice.id} />
                  <input type="hidden" name="projectId" value={data.project.id} />
                  <input type="hidden" name="paymentId" value={payment.id} />
                  <div>
                    <div className="font-semibold">{payment.label}</div>
                    <div className="mt-1 text-sm text-[var(--ink-muted)]">{formatMoney(payment.amountCents)} · due {formatDate(payment.dueDate)}</div>
                  </div>
                  <label className="space-y-1.5 text-sm font-medium">
                    Status
                    <select name="status" defaultValue={payment.status} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                      <option value="pending">Pending</option>
                      <option value="paid">Paid</option>
                      <option value="waived">Waived</option>
                    </select>
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    Method
                    <select name="paymentMethod" defaultValue={payment.paymentMethod ?? ""} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                      <option value="">Not set</option>
                      <option value="stripe">Stripe</option>
                      <option value="zelle">Zelle</option>
                      <option value="venmo">Venmo</option>
                      <option value="check">Check</option>
                      <option value="cash">Cash</option>
                    </select>
                  </label>
                  <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Save payment</button>
                </form>
              ))}
              {!data.payments.length && <p className="py-8 text-sm text-[var(--ink-muted)]">No payment schedule yet.</p>}
            </div>
          </div>

          <aside className="space-y-5">
            <form action={`/api/invoices/${data.invoice.id}/status`} method="post" className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
              <input type="hidden" name="invoiceId" value={data.invoice.id} />
              <input type="hidden" name="projectId" value={data.project.id} />
              <h2 className="text-lg font-semibold">Invoice status</h2>
              <label className="mt-4 block space-y-1.5 text-sm font-medium">
                Status
                <select name="status" defaultValue={data.invoice.status} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                  {invoiceStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <button className="brand-primary-button mt-4 rounded-sm px-4 py-2.5 transition">Update invoice</button>
            </form>

            <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
              <h2 className="text-lg font-semibold">Payment options</h2>
              <dl className="mt-4 space-y-4 text-sm">
                {acceptedPaymentMethods.map((method) => (
                  <div key={method.key}>
                    <dt className="font-semibold">{method.displayName}</dt>
                    <dd className="mt-1 break-all text-[var(--ink-muted)]">
                      {method.key === "stripe" ? data.invoice.stripePaymentLink || "Stripe checkout not connected yet." : method.instructions || "No instructions set."}
                    </dd>
                    {method.passFees && <dd className="mt-1 text-[var(--ink-muted)]">Processing fees passed to client.</dd>}
                  </div>
                ))}
                {!acceptedPaymentMethods.length && (
                  <>
                    <div>
                      <dt className="font-semibold">Zelle</dt>
                      <dd className="mt-1 text-[var(--ink-muted)]">{data.invoice.zelleInfo || "Not set"}</dd>
                    </div>
                    <div>
                      <dt className="font-semibold">Venmo</dt>
                      <dd className="mt-1 text-[var(--ink-muted)]">{data.invoice.venmoInfo || "Not set"}</dd>
                    </div>
                  </>
                )}
              </dl>
              <p className="mt-4 whitespace-pre-line text-sm leading-6 text-[var(--ink-muted)]">{data.invoice.paymentNotes || "No payment notes yet."}</p>
            </section>
          </aside>
        </section>
      </div>
    </AppShell>
  );
}
