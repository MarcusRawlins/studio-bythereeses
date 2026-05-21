import { AppShell } from "@/components/AppShell";
import { formatDate, formatMoney } from "@/lib/format";
import { listProposals, proposalStatusOptions } from "@/lib/sales";
import { FileSignature, Plus } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams ? await searchParams : {};
  const search = firstQueryValue(params.q) ?? "";
  const status = firstQueryValue(params.status) ?? "all";
  const rows = await listProposals(search, status);

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 sm:flex-row sm:items-end">
          <div>
            <h1 className="brand-page-title text-4xl">Proposals</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">Build and track proposal packages before contract signing and invoicing.</p>
          </div>
          <Link href="/proposals/new" prefetch={false} className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 transition">
            <Plus className="h-4 w-4" />
            Create proposal
          </Link>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <FileSignature className="h-4 w-4" />
              Active proposals
            </div>
            <div className="mt-3 text-3xl font-semibold">{rows.filter(({ proposal }) => proposal.status !== "accepted" && proposal.status !== "declined").length}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Draft, sent, and expiring proposals.</p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Accepted value</div>
            <div className="mt-3 text-3xl font-semibold">{formatMoney(rows.filter(({ proposal }) => proposal.status === "accepted").reduce((sum, { proposal }) => sum + (proposal.totalCents ?? 0), 0))}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Proposal value marked accepted.</p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Needs invoice</div>
            <div className="mt-3 text-3xl font-semibold">{rows.filter(({ proposal }) => proposal.status === "accepted" && proposal.invoiceStatus !== "created").length}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Accepted proposals without an invoice.</p>
          </div>
        </section>

        <section className="border-b border-[var(--line)] pb-5">
          <form action="/proposals" className="grid gap-3 md:grid-cols-[1fr_210px_auto]">
            <label className="space-y-1.5 text-sm font-medium">
              Search proposals
              <input name="q" defaultValue={search} placeholder="Project, client, package" className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none transition focus:border-[var(--foreground)]" />
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              Status
              <select name="status" defaultValue={status} className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none transition focus:border-[var(--foreground)]">
                <option value="all">All statuses</option>
                {proposalStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button className="brand-primary-button self-end rounded-sm px-4 py-2.5 transition">Apply</button>
          </form>
        </section>

        <section className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)] shadow-sm">
          <div className="grid grid-cols-[1.2fr_1fr_150px_130px_130px] border-b border-[var(--line)] bg-[#eee8de] px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)] max-lg:hidden">
            <div>Proposal</div>
            <div>Project</div>
            <div>Valid until</div>
            <div>Status</div>
            <div>Value</div>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {rows.map(({ proposal, project, client }) => (
              <Link key={proposal.id} href={`/proposals/${proposal.id}`} prefetch={false} className="grid gap-2 px-4 py-4 transition hover:bg-[#f6efe5] lg:grid-cols-[1.2fr_1fr_150px_130px_130px] lg:items-center">
                <div>
                  <div className="font-semibold">{proposal.title}</div>
                  <div className="mt-1 text-sm text-[var(--ink-muted)]">{proposal.packageName || "Package TBD"}</div>
                </div>
                <div>
                  <div className="text-sm font-medium">{project.name}</div>
                  <div className="mt-1 text-xs text-[var(--ink-muted)]">{client.firstName} {client.lastName}</div>
                </div>
                <div className="text-sm text-[var(--ink-muted)]">{formatDate(proposal.validUntil)}</div>
                <div className="text-sm capitalize text-[var(--ink-muted)]">{proposal.status.replaceAll("_", " ")}</div>
                <div className="text-sm font-semibold">{formatMoney(proposal.totalCents)}</div>
              </Link>
            ))}
            {!rows.length && <div className="p-8 text-sm text-[var(--ink-muted)]">No proposals yet.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
