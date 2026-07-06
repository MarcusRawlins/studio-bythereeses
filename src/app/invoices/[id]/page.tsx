import { AppShell } from "@/components/AppShell";
import { RefundControl, type RefundInitiationRow } from "@/components/RefundControl";
import type { invoicePayments } from "@/db/schema";
import { refundInitiationEnabled } from "@/lib/finance-flags";
import { formatDate, formatMoney } from "@/lib/format";
import { getInvoice, invoiceClientPayableCents, invoiceStatusOptions } from "@/lib/sales";
import {
  isDisputeBlockedForRefundUi,
  isRetainerPayment,
  listRefundInitiationsForPayment,
} from "@/lib/stripe-refund-initiation";
import { Bell, CreditCard, ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

type InvoicePaymentRow = typeof invoicePayments.$inferSelect;

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

function parseReminderMetadata(value: string | null) {
  if (!value) return {};
  try {
    return JSON.parse(value) as {
      channel?: string | null;
      note?: string | null;
      paymentId?: string | null;
      invoiceNumber?: string | null;
      templateName?: string | null;
    };
  } catch {
    return {};
  }
}

function parseProposalSyncMetadata(value: string | null) {
  if (!value) return {};
  try {
    return JSON.parse(value) as {
      previousTotalCents?: number | null;
      totalCents?: number | null;
      deltaCents?: number | null;
      adjustedPaymentId?: string | null;
    };
  } catch {
    return {};
  }
}

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const { saved } = searchParams ? await searchParams : {};
  const data = await getInvoice(id);
  if (!data) notFound();
  const payments: InvoicePaymentRow[] = data.payments;
  const acceptedPaymentMethods = parseAcceptedPaymentMethods(data.invoice.acceptedPaymentMethodsJson);
  const clientPayableCents = invoiceClientPayableCents(data.invoice);
  const grossCollectedCents = data.payments.reduce((sum, payment) => sum + payment.grossCollectedCents, 0);
  const netDepositCents = data.payments.reduce((sum, payment) => sum + payment.netDepositCents, 0);
  const processingFeeCents = data.payments.reduce((sum, payment) => sum + payment.processingFeeCents, 0);

  // Phase 9b — admin refund UI (DARK behind REFUND_INITIATION_ENABLED). Read INSIDE the body
  // (never a default param, TS2559) so this stays a hard money-off-by-default read. When the
  // flag is off, NOTHING below runs or renders — no refund control, no refund-history query.
  const refundsEnabled = refundInitiationEnabled();
  const refundEligiblePayments = refundsEnabled
    ? payments.filter((payment) => payment.status === "paid" && Boolean(payment.externalPaymentId?.trim()))
    : [];
  const refundInitiationsByPaymentId: Record<string, RefundInitiationRow[]> = {};
  if (refundEligiblePayments.length) {
    const entries = await Promise.all(
      refundEligiblePayments.map(async (payment) => [payment.id, await listRefundInitiationsForPayment(payment.id)] as const),
    );
    for (const [paymentId, rows] of entries) refundInitiationsByPaymentId[paymentId] = rows;
  }
  function refundDisabledReason(payment: InvoicePaymentRow) {
    if (isRetainerPayment(payment, payments)) {
      return "This is the initial retainer. Retainers are non-refundable.";
    }
    if (isDisputeBlockedForRefundUi(payment)) {
      return payment.disputeStatus === "open"
        ? "This payment has an open dispute and cannot be refunded until it resolves."
        : "Funds for this payment were already pulled by a lost chargeback and cannot be refunded.";
    }
    return null;
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 lg:flex-row lg:items-end">
          <div>
            <Link href="/invoices" className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">Back to invoices</Link>
            <h1 className="brand-page-title mt-3 text-4xl">{data.invoice.invoiceNumber}</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">
              {data.project.name} · {data.client ? `${data.client.firstName} ${data.client.lastName ?? ""}`.trim() : "Needs primary client"}
            </p>
          </div>
          <Link href={`/projects/${data.project.id}`} className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--foreground)]">
            <ExternalLink className="h-4 w-4" />
            View project
          </Link>
        </header>

        <section className="grid gap-4 md:grid-cols-5">
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
            <div className="text-sm text-[var(--ink-muted)]">Card fee</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(data.invoice.cardFeeAmountCents)}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Client pays</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(clientPayableCents)}</div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Gross collected</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(grossCollectedCents)}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Processor fees</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(processingFeeCents)}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Net deposit</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(netDepositCents)}</div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="text-lg font-semibold">Payment schedule</h2>
            </div>
            {saved === "checkout" && (
              <div className="mt-4 rounded-md border border-[var(--accent)] bg-[#edf6f1] p-3 text-sm font-semibold text-[var(--accent-strong)]">
                Stripe checkout link created and saved to the canonical payment row.
              </div>
            )}
            <div className="mt-4 divide-y divide-[var(--line)]">
              {data.payments.map((payment) => (
                <div key={payment.id} id={`payment-${payment.id}`} className="scroll-mt-6 py-4 target:bg-[var(--accent-soft)]">
                <form
                  action={`/api/invoices/${data.invoice.id}/payments`}
                  method="post"
                  className="grid gap-3"
                >
                  <input type="hidden" name="invoiceId" value={data.invoice.id} />
                  <input type="hidden" name="projectId" value={data.project.id} />
                  <input type="hidden" name="paymentId" value={payment.id} />
                  <div className="grid gap-3 lg:grid-cols-[1fr_130px_150px_150px] lg:items-end">
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
                    <div className="grid gap-2">
                      <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Save payment</button>
                      {payment.status !== "paid" && payment.status !== "waived" && (
                        <button
                          formAction={`/api/invoices/${data.invoice.id}/payments/${payment.id}/checkout`}
                          className="rounded-sm border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--foreground)]"
                        >
                          Create checkout
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="grid gap-3 rounded-md border border-[var(--line)] bg-[var(--background)] p-3 md:grid-cols-3">
                    <label className="space-y-1.5 text-sm font-medium">
                      Paid amount
                      <input name="paidAmount" defaultValue={payment.paidAmountCents ? (payment.paidAmountCents / 100).toFixed(2) : ""} placeholder={(payment.amountCents / 100).toFixed(2)} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                    </label>
                    <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                      External payment ID
                      <input name="externalPaymentId" defaultValue={payment.externalPaymentId ?? ""} placeholder="Stripe payment intent, check number, bank ref" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                    </label>
                    <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                      Stripe checkout URL
                      <input name="stripeCheckoutUrl" defaultValue={payment.stripeCheckoutUrl ?? ""} placeholder="https://checkout.stripe.com/..." className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                      {payment.stripeCheckoutUrl && payment.stripeCheckoutStatus === "link_ready" && (
                        <a href={payment.stripeCheckoutUrl} target="_blank" className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--accent-strong)] underline">
                          Open checkout <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </label>
                    <label className="space-y-1.5 text-sm font-medium">
                      Checkout status
                      <select name="stripeCheckoutStatus" defaultValue={payment.stripeCheckoutStatus ?? "not_created"} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                        <option value="not_created">Not created</option>
                        <option value="link_ready">Link ready</option>
                        <option value="paid">Paid</option>
                        <option value="expired">Expired</option>
                        <option value="void">Void</option>
                      </select>
                    </label>
                    <label className="space-y-1.5 text-sm font-medium md:col-span-3">
                      Stripe checkout session ID
                      <input name="stripeCheckoutSessionId" defaultValue={payment.stripeCheckoutSessionId ?? ""} placeholder="cs_live_..." className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                    </label>
                    <div className="text-sm">
                      <div className="text-[var(--ink-muted)]">Client fee</div>
                      <div className="mt-1 font-semibold">{formatMoney(payment.clientFeeCents)}</div>
                    </div>
                    <div className="text-sm">
                      <div className="text-[var(--ink-muted)]">Processor fee</div>
                      <div className="mt-1 font-semibold">{formatMoney(payment.processingFeeCents)}</div>
                    </div>
                    <div className="text-sm">
                      <div className="text-[var(--ink-muted)]">Net deposit</div>
                      <div className="mt-1 font-semibold">{formatMoney(payment.netDepositCents)}</div>
                    </div>
                    <label className="space-y-1.5 text-sm font-medium md:col-span-3">
                      Notes
                      <input name="notes" defaultValue={payment.notes ?? ""} placeholder="Reconciliation notes" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                    </label>
                  </div>
                </form>
                {refundsEnabled && payment.status === "paid" && payment.externalPaymentId?.trim() && (
                  <div className="mt-3">
                    <RefundControl
                      invoiceId={data.invoice.id}
                      paymentId={payment.id}
                      paymentLabel={payment.label}
                      disabledReason={refundDisabledReason(payment)}
                      existingInitiations={refundInitiationsByPaymentId[payment.id] ?? []}
                    />
                  </div>
                )}
                </div>
              ))}
              {!data.payments.length && <p className="py-8 text-sm text-[var(--ink-muted)]">No payment schedule yet.</p>}
            </div>
          </div>

          <aside className="space-y-5">
            {data.proposalSyncs.length > 0 && (
              <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
                <h2 className="text-lg font-semibold">Accepted proposal sync</h2>
                <div className="mt-4 divide-y divide-[var(--line)] border-t border-[var(--line)]">
                  {data.proposalSyncs.map((sync) => {
                    const metadata = parseProposalSyncMetadata(sync.metadata);
                    return (
                      <div key={sync.id} className="py-3 text-sm">
                        <div className="font-semibold">
                          Invoice total changed from {formatMoney(metadata.previousTotalCents ?? 0)} to {formatMoney(metadata.totalCents ?? 0)}
                        </div>
                        <div className="mt-1 text-[var(--ink-muted)]">
                          {formatDate(sync.createdAt)} · Delta {formatMoney(metadata.deltaCents ?? 0)}
                          {metadata.adjustedPaymentId ? ` · adjusted payment ${metadata.adjustedPaymentId}` : ""}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

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
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-[var(--ink-muted)]" />
                <h2 className="text-lg font-semibold">Manual reminders</h2>
              </div>
              <form action={`/api/invoices/${data.invoice.id}/reminders`} method="post" className="mt-4 space-y-3">
                <input type="hidden" name="projectId" value={data.project.id} />
                <label className="block space-y-1.5 text-sm font-medium">
                  Reminder template
                  <select name="templateId" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                    <option value="">No template</option>
                    {data.reminderTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}{template.trigger ? ` · ${template.trigger}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1.5 text-sm font-medium">
                  Related payment
                  <select name="paymentId" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                    <option value="">General invoice follow-up</option>
                    {data.payments.map((payment) => (
                      <option key={payment.id} value={payment.id}>{payment.label} · due {formatDate(payment.dueDate)}</option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1.5 text-sm font-medium">
                  Channel
                  <select name="channel" defaultValue="email" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                    <option value="email">Email</option>
                    <option value="phone">Phone</option>
                    <option value="text">Text</option>
                    <option value="manual">Manual note</option>
                  </select>
                </label>
                <label className="block space-y-1.5 text-sm font-medium">
                  Note
                  <textarea name="note" rows={3} placeholder="Optional override. Leave blank to log the selected template with invoice merge fields." className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Log reminder</button>
              </form>
              <div className="mt-5 divide-y divide-[var(--line)] border-t border-[var(--line)]">
                {data.reminders.map((reminder) => {
                  const metadata = parseReminderMetadata(reminder.metadata);
                  return (
                    <div key={reminder.id} className="py-3 text-sm">
                      <div className="font-semibold capitalize">{(metadata.channel ?? "manual").replaceAll("_", " ")} reminder</div>
                      {metadata.templateName && <div className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Template: {metadata.templateName}</div>}
                      <div className="mt-1 text-[var(--ink-muted)]">{formatDate(reminder.createdAt)} · {metadata.note || "No note recorded."}</div>
                    </div>
                  );
                })}
                {!data.reminders.length && <p className="py-3 text-sm text-[var(--ink-muted)]">No invoice reminders logged yet.</p>}
              </div>
              <p className="mt-3 text-xs text-[var(--ink-muted)]">This logs manual follow-up only. Studio does not send automated payment reminders yet.</p>
            </section>

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
              {data.invoice.cardFeePolicy === "client_pays" && (
                <div className="mt-4 border border-[var(--line)] bg-[var(--background)] p-3 text-sm">
                  <p className="font-semibold">Client-paid credit card fee</p>
                  <p className="mt-1 text-[var(--ink-muted)]">
                    {formatMoney(data.invoice.cardFeeAmountCents)} is added when the client chooses card payment. Invoice services remain {formatMoney(data.invoice.totalCents)}.
                  </p>
                </div>
              )}
              <p className="mt-4 whitespace-pre-line text-sm leading-6 text-[var(--ink-muted)]">{data.invoice.paymentNotes || "No payment notes yet."}</p>
            </section>
          </aside>
        </section>
      </div>
    </AppShell>
  );
}
