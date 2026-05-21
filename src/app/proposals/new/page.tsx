import { AppShell } from "@/components/AppShell";
import { ProposalPackageBuilder } from "@/components/ProposalPackageBuilder";
import { listClientOptions, listContractTemplateOptions, listProjectOptions } from "@/lib/sales";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function NewProposalPage({
  searchParams,
}: {
  searchParams?: Promise<{ projectId?: string }>;
}) {
  const params = searchParams ? await searchParams : {};
  const [projects, clients, contractTemplates] = await Promise.all([
    listProjectOptions(),
    listClientOptions(),
    listContractTemplateOptions(),
  ]);

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="border-b border-[var(--line)] pb-5">
          <Link href="/proposals" className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">Back to proposals</Link>
          <h1 className="brand-page-title mt-3 text-4xl">Create Proposal</h1>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">Build the package, contract readiness, and invoice foundation together.</p>
        </header>

        <form action="/api/proposals" method="post" className="grid gap-5 rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
          <div className="flex flex-col gap-3 border-b border-[var(--line)] pb-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Proposal editor</h2>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">Start with the client/project, build the package, then attach the contract.</p>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-[#faf7f1] px-3 py-2 text-sm">
              <span className="font-semibold">Status:</span> Draft
            </div>
          </div>

          <nav className="grid gap-2 sm:grid-cols-3" aria-label="Proposal editor steps">
            {[
              ["1", "Details", "#details"],
              ["2", "Package", "#package"],
              ["3", "Contract", "#contract"],
            ].map(([number, label, href]) => (
              <a key={String(label)} href={String(href)} className="rounded-md border border-[var(--line)] bg-[#faf7f1] p-3 transition hover:border-[var(--brand-brown)] hover:bg-[#f2ebe2]">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">Step {number}</div>
                <div className="mt-1 font-semibold">{label}</div>
              </a>
            ))}
          </nav>

          <section id="details" className="scroll-mt-6 rounded-md border border-[var(--line)] p-4">
            <div className="mb-4">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">1. Details</div>
              <h3 className="mt-1 text-xl font-semibold">Client and proposal basics</h3>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                Project
                <select name="projectId" defaultValue={params.projectId ?? ""} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                  <option value="">Select project, or assign to a client below</option>
                  {projects.map(({ project, client }) => <option key={project.id} value={project.id}>{project.name} · {client.firstName} {client.lastName}</option>)}
                </select>
              </label>
              <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                Client assignment
                <select name="clientId" defaultValue="" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                  <option value="">Only needed when no project exists yet</option>
                  {clients.map((client) => <option key={client.id} value={client.id}>{client.firstName} {client.lastName} · {client.email}</option>)}
                </select>
                <span className="block text-xs font-normal leading-5 text-[var(--ink-muted)]">If you choose a client without a project, Studio creates a lightweight inquiry project so the proposal still has a secure home.</span>
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Proposal title
                <input name="title" required placeholder="Wedding photography proposal" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Package name
                <input name="packageName" placeholder="Collection II" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Valid until
                <input name="validUntil" type="date" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
              <div className="rounded-md border border-[var(--line)] bg-[#faf7f1] p-3 text-sm text-[var(--ink-muted)]">
                Proposal status is automatic. It starts as Draft and changes as package, contract, invoice, send, signature, and payment pieces are completed.
              </div>
            </div>
          </section>

          <section id="package" className="scroll-mt-6 rounded-md border border-[var(--line)] p-4">
            <div className="mb-4">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">2. Package</div>
              <h3 className="mt-1 text-xl font-semibold">Package and scope</h3>
            </div>
            <div className="grid gap-4">
              <ProposalPackageBuilder />
              <label className="space-y-1.5 text-sm font-medium">
                Scope summary
                <textarea name="scopeSummary" rows={5} placeholder="Coverage, deliverables, engagement session, albums, travel, and notes." className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
            </div>
          </section>

          <section id="contract" className="scroll-mt-6 rounded-md border border-[var(--line)] p-4">
            <div className="mb-4">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">3. Contract</div>
              <h3 className="mt-1 text-xl font-semibold">Agreement language</h3>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">The client will review and sign this contract inside the secure proposal link.</p>
            </div>
            <div className="grid gap-4">
              <label className="space-y-1.5 text-sm font-medium">
                Contract template
                <select name="contractTemplateId" defaultValue="" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                  <option value="">No contract template selected yet</option>
                  {contractTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                </select>
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Contract title
                <input name="contractTitle" placeholder="Wedding photography agreement" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Contract draft
                <textarea name="contractBody" rows={9} placeholder="Paste or draft the contract language here." className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
            </div>
          </section>

          <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Create proposal</button>
        </form>
      </div>
    </AppShell>
  );
}
