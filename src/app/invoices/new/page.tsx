import { AppShell } from "@/components/AppShell";
import { formatMoney } from "@/lib/format";
import { estimateInvoiceCardFeeCents, getProposal, invoiceStatusOptions, listProjectOptions, listProposalOptions } from "@/lib/sales";
import { enabledPaymentMethods, getAppSettings } from "@/lib/settings";
import Link from "next/link";

export const dynamic = "force-dynamic";

function projectOptionLabel({ project, client }: Awaited<ReturnType<typeof listProjectOptions>>[number]) {
  const clientName = client
    ? [client.firstName, client.lastName].filter(Boolean).join(" ") || client.email
    : "Needs primary client";
  return `${project.name} · ${clientName}`;
}

function proposalClientLabel(client: NonNullable<Awaited<ReturnType<typeof getProposal>>>["client"]) {
  if (!client) return "Needs primary client";
  return [client.firstName, client.lastName].filter(Boolean).join(" ") || client.email;
}

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams?: Promise<{ projectId?: string; proposalId?: string }>;
}) {
  const params = searchParams ? await searchParams : {};
  const projects = await listProjectOptions();
  const proposalOptions = await listProposalOptions(params.projectId);
  const selectedProposal = params.proposalId ? await getProposal(params.proposalId) : null;
  const settings = await getAppSettings();
  const paymentMethods = enabledPaymentMethods(settings.paymentMethods);
  const selectedProjectId = params.projectId ?? selectedProposal?.project.id ?? "";
  const includedItems = selectedProposal?.lineItems.filter((item) => !item.isOptional) ?? [];
  const optionalItems = selectedProposal?.lineItems.filter((item) => item.isOptional) ?? [];
  const includedTotalCents = includedItems.reduce((sum, item) => sum + Math.max(item.quantity, 1) * Math.max(item.unitPriceCents, 0), 0);
  const proposalTotalCents = selectedProposal?.proposal.totalCents ?? includedTotalCents;
  const proposalTotalDollars = proposalTotalCents > 0 ? String(proposalTotalCents / 100) : "";
  const defaultRetainerDollars = proposalTotalCents > 0 ? String(Math.round(proposalTotalCents * 0.3) / 100) : "";
  const stripePassesFees = paymentMethods.some((method) => method.key === "stripe" && method.passFees);
  const estimatedCardFeeCents = stripePassesFees && proposalTotalCents > 0 ? estimateInvoiceCardFeeCents(proposalTotalCents) : 0;

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="border-b border-[var(--line)] pb-5">
          <Link href="/invoices" className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">Back to invoices</Link>
          <h1 className="brand-page-title mt-3 text-4xl">Create Invoice</h1>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">Create a retainer plus remaining payment schedule. Payment details are pulled from Settings, then selected per invoice.</p>
        </header>

        <form action="/api/invoices" method="post" className="grid gap-4 rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm md:grid-cols-2">
          {selectedProposal && (
            <section className="rounded-md border border-[var(--line)] bg-white p-4 md:col-span-2">
              <div className="flex flex-col gap-2 border-b border-[var(--line)] pb-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="brand-label">Autopopulated from proposal</p>
                  <h2 className="mt-1 text-lg font-semibold">{selectedProposal.proposal.title}</h2>
                  <p className="mt-1 text-sm text-[var(--ink-muted)]">{selectedProposal.project.name} · {proposalClientLabel(selectedProposal.client)}</p>
                </div>
                <div className="text-left md:text-right">
                  <p className="brand-label">Invoice total</p>
                  <p className="mt-1 text-2xl font-semibold">{formatMoney(proposalTotalCents)}</p>
                </div>
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-[1fr_0.8fr]">
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold">Included package items</h3>
                  {includedItems.map((item) => (
                    <div key={item.id} className="rounded-md border border-[var(--line)] bg-[var(--background)] p-3 text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold">{item.name}</p>
                          {item.description && <p className="mt-1 text-[var(--ink-muted)]">{item.description}</p>}
                        </div>
                        <p className="shrink-0 font-semibold">{formatMoney(item.quantity * item.unitPriceCents)}</p>
                      </div>
                    </div>
                  ))}
                  {!includedItems.length && <p className="text-sm text-[var(--ink-muted)]">No included package items are saved yet.</p>}
                </div>
                <div className="space-y-3">
                  <div className="rounded-md border border-[var(--line)] bg-[var(--background)] p-3">
                    <p className="text-sm font-semibold">Default payment schedule</p>
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">30% retainer and one final balance payment. You can adjust these values before creating the invoice.</p>
                  </div>
                  {optionalItems.length > 0 && (
                    <div className="rounded-md border border-[var(--line)] bg-[var(--background)] p-3">
                      <p className="text-sm font-semibold">Optional add-ons</p>
                      <p className="mt-1 text-sm text-[var(--ink-muted)]">Listed for context only. They are not included in this invoice until selected by the client or added manually.</p>
                      <div className="mt-3 space-y-2">
                        {optionalItems.map((item) => (
                          <div key={item.id} className="flex justify-between gap-3 text-sm">
                            <span>{item.name}</span>
                            <span className="font-semibold">{formatMoney(item.quantity * item.unitPriceCents)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedProposal.proposal.scopeSummary && (
                    <div className="rounded-md border border-[var(--line)] bg-[var(--background)] p-3">
                      <p className="text-sm font-semibold">Scope summary</p>
                      <p className="mt-1 text-sm text-[var(--ink-muted)]">{selectedProposal.proposal.scopeSummary}</p>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}
          <label className="space-y-1.5 text-sm font-medium md:col-span-2">
            Project
            <select name="projectId" required defaultValue={selectedProjectId} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
              <option value="">Select project</option>
              {projects.map((row) => <option key={row.project.id} value={row.project.id}>{projectOptionLabel(row)}</option>)}
            </select>
          </label>
          <label className="space-y-1.5 text-sm font-medium md:col-span-2">
            Proposal
            <select name="proposalId" defaultValue={params.proposalId ?? ""} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
              <option value="">Standalone invoice</option>
              {proposalOptions.map(({ proposal, project }) => <option key={proposal.id} value={proposal.id}>{proposal.title} · {project.name}</option>)}
            </select>
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            Invoice number
            <input name="invoiceNumber" placeholder="Auto-generated if blank" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            Status
            <select name="status" defaultValue="draft" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
              {invoiceStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            Total
            <input name="total" inputMode="decimal" defaultValue={proposalTotalDollars} placeholder="8500" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            Retainer amount
            <input name="retainerAmount" inputMode="decimal" defaultValue={defaultRetainerDollars} placeholder="2500" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            Retainer percent fallback
            <input name="retainerPercent" inputMode="numeric" defaultValue="30" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            Remaining installments
            <input name="installmentCount" inputMode="numeric" defaultValue="1" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
          </label>
          <label className="space-y-1.5 text-sm font-medium md:col-span-2">
            First due date
            <input name="dueDate" type="date" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
          </label>
          <section className="rounded-md border border-[var(--line)] p-4 md:col-span-2">
            <div className="flex flex-col justify-between gap-2 md:flex-row md:items-start">
              <div>
                <h2 className="font-semibold">Accepted payment methods</h2>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">These come from Settings. If none are selected, all enabled methods are included.</p>
              </div>
              <Link href="/settings" className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">Edit settings</Link>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {paymentMethods.map((method) => (
                <label key={method.key} className="flex items-start gap-3 rounded-md border border-[var(--line)] bg-white p-3 text-sm">
                  <input type="checkbox" name="acceptedPaymentMethod" value={method.key} defaultChecked className="mt-1 h-4 w-4 accent-[var(--brand-brown)]" />
                  <span>
                    <span className="block font-semibold">{method.displayName}</span>
                    {method.instructions && <span className="mt-1 block text-[var(--ink-muted)]">{method.instructions}</span>}
                    {method.passFees && <span className="mt-1 block text-[var(--ink-muted)]">Processing fees passed to client.</span>}
                  </span>
                </label>
              ))}
              {!paymentMethods.length && (
                <p className="rounded-md border border-[var(--line)] bg-white p-3 text-sm text-[var(--ink-muted)] md:col-span-2">
                  No payment methods are enabled yet. Enable at least one in Settings before sending invoices.
                </p>
              )}
            </div>
            {stripePassesFees && (
              <div className="mt-4 border border-[var(--line)] bg-[var(--background)] p-3 text-sm">
                <p className="font-semibold">Credit card fee policy</p>
                <p className="mt-1 text-[var(--ink-muted)]">
                  This invoice will snapshot credit card fees as client-paid when credit card is accepted. {estimatedCardFeeCents > 0
                    ? `Estimated client card fee: ${formatMoney(estimatedCardFeeCents)}.`
                    : "The exact fee amount is calculated from the invoice total when the invoice is created."}
                </p>
              </div>
            )}
          </section>
          <label className="space-y-1.5 text-sm font-medium md:col-span-2">
            Stripe checkout link
            <input name="stripePaymentLink" type="url" placeholder="https://pay.stripe.com/..." className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
            <span className="block text-xs font-normal leading-5 text-[var(--ink-muted)]">Optional canonical payment link shown on the invoice and secure client proposal view.</span>
          </label>
          <label className="space-y-1.5 text-sm font-medium md:col-span-2">
            Payment notes override
            <textarea name="paymentNotes" rows={4} placeholder="Leave blank to use the instructions from Settings." className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
          </label>
          <button className="brand-primary-button rounded-sm px-4 py-2.5 transition md:col-span-2">Create invoice</button>
        </form>
      </div>
    </AppShell>
  );
}
