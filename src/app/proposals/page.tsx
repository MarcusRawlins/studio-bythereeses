import { AppShell } from "@/components/AppShell";
import { formatDate, formatMoney } from "@/lib/format";
import { listProposals, proposalStatusOptions } from "@/lib/sales";
import { FileSignature, Plus } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function clientLabel(client: Awaited<ReturnType<typeof listProposals>>[number]["client"]) {
  if (!client) return "Needs primary client";
  return [client.firstName, client.lastName].filter(Boolean).join(" ") || client.email;
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
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">The Reeses Studio</div>
            <h1 className="brand-page-title mt-2 text-5xl md:text-6xl">Proposals</h1>
            <p className="mt-2 font-[var(--serif)] text-xl italic text-[var(--ink-2)]">Build and track proposal packages before contract signing and invoicing.</p>
          </div>
          <Link href="/proposals/new" prefetch={false} className="brand-primary-button inline-flex items-center justify-center gap-2 px-4 py-2.5 transition">
            <Plus className="h-4 w-4" />
            Create proposal
          </Link>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="studio-card">
            <div className="studio-caps flex items-center gap-2 text-[0.58rem] text-[var(--ink-3)]">
              <FileSignature className="h-4 w-4" />
              Active proposals
            </div>
            <div className="studio-stat-number mt-3">{rows.filter(({ proposal }) => proposal.status !== "accepted" && proposal.status !== "declined").length}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Draft, sent, and expiring proposals.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Accepted value</div>
            <div className="studio-stat-number mt-3">{formatMoney(rows.filter(({ proposal }) => proposal.status === "accepted").reduce((sum, { proposal }) => sum + (proposal.totalCents ?? 0), 0))}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Proposal value marked accepted.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Needs invoice</div>
            <div className="studio-stat-number mt-3">{rows.filter(({ proposal }) => proposal.status === "accepted" && proposal.invoiceStatus !== "created").length}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Accepted proposals without an invoice.</p>
          </div>
        </section>

        <section className="border-b border-[var(--line)] pb-5">
          <form action="/proposals" className="grid gap-3 md:grid-cols-[1fr_210px_auto]">
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Search proposals</span>
              <input name="q" defaultValue={search} placeholder="Project, client, package" className="studio-input" />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Status</span>
              <select name="status" defaultValue={status} className="studio-input">
                <option value="all">All statuses</option>
                {proposalStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button className="brand-primary-button self-end px-4 py-2.5 transition">Apply</button>
          </form>
        </section>

        <section className="overflow-hidden border border-[var(--line)] bg-[var(--paper)]">
          <div className="studio-caps grid grid-cols-[1.2fr_1fr_150px_130px_130px] border-b border-[var(--line)] bg-[var(--paper-2)] px-4 py-3 text-[0.58rem] text-[var(--ink-3)] max-lg:hidden">
            <div>Proposal</div>
            <div>Project</div>
            <div>Valid until</div>
            <div>Status</div>
            <div>Value</div>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {rows.map(({ proposal, project, client }) => (
              <Link key={proposal.id} href={`/proposals/${proposal.id}`} prefetch={false} className="grid gap-2 px-4 py-4 transition hover:bg-[var(--paper-2)] lg:grid-cols-[1.2fr_1fr_150px_130px_130px] lg:items-center">
                <div>
                  <div className="font-semibold">{proposal.title}</div>
                  <div className="mt-1 text-sm text-[var(--ink-3)]">{proposal.packageName || "Package TBD"}</div>
                </div>
                <div>
                  <div className="text-sm font-medium">{project.name}</div>
                  <div className={`mt-1 text-xs ${client ? "text-[var(--ink-3)]" : "font-semibold text-[var(--warning)]"}`}>{clientLabel(client)}</div>
                </div>
                <div className="text-sm text-[var(--ink-3)]">{formatDate(proposal.validUntil)}</div>
                <div><span className="studio-chip">{proposal.status.replaceAll("_", " ")}</span></div>
                <div className="text-sm font-semibold">{formatMoney(proposal.totalCents)}</div>
              </Link>
            ))}
            {!rows.length && <div className="p-8 text-sm text-[var(--ink-3)]">No proposals yet.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
