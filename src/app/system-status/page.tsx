import { AppShell } from "@/components/AppShell";
import { getStudioSystemStatus, type StudioSystemStatusItem } from "@/lib/system-status";
import { Activity, DatabaseBackup, KeyRound, ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";

function toneClass(tone: StudioSystemStatusItem["tone"]) {
  if (tone === "ok") return "border-emerald-700/30 bg-emerald-50 text-emerald-900";
  if (tone === "warn") return "border-amber-700/30 bg-amber-50 text-amber-900";
  return "border-[var(--line)] bg-[var(--paper-2)] text-[var(--ink-3)]";
}

function StatusGrid({ items }: { items: StudioSystemStatusItem[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {items.map((status) => (
        <article key={status.label} className="border border-[var(--line)] bg-[var(--paper)] p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-sm font-semibold">{status.label}</h3>
            <span className={`shrink-0 rounded-full border px-2 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.08em] ${toneClass(status.tone)}`}>
              {status.status}
            </span>
          </div>
          <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">{status.detail}</p>
        </article>
      ))}
    </div>
  );
}

export default async function SystemStatusPage() {
  const status = await getStudioSystemStatus();

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 lg:flex-row lg:items-end">
          <div>
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">The Reeses Studio</div>
            <h1 className="brand-page-title mt-2 text-5xl md:text-6xl">System status</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--ink-muted)]">
              Private operational posture for the Studio front door, agent access, backup gate, token links, and known hardening work.
            </p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--ink-muted)]">
            Last security review <span className="font-semibold text-[var(--foreground)]">{status.reviewedAt}</span>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-4">
          <div className="border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Projects</div>
            <div className="mt-2 text-2xl font-semibold">{status.dataHealth.projectCount}</div>
          </div>
          <div className="border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Clients</div>
            <div className="mt-2 text-2xl font-semibold">{status.dataHealth.clientCount}</div>
          </div>
          <div className="border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Data issues</div>
            <div className="mt-2 text-2xl font-semibold">{status.dataHealth.issueCount}</div>
          </div>
          <div className="border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">High priority</div>
            <div className="mt-2 text-2xl font-semibold">{status.dataHealth.highIssueCount}</div>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[var(--ink-muted)]" />
            <h2 className="text-lg font-semibold">Front door</h2>
          </div>
          <StatusGrid items={status.frontDoor} />
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-[var(--ink-muted)]" />
            <h2 className="text-lg font-semibold">Runtime credentials</h2>
          </div>
          <StatusGrid items={status.runtime} />
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <DatabaseBackup className="h-4 w-4 text-[var(--ink-muted)]" />
            <h2 className="text-lg font-semibold">Operations gate</h2>
          </div>
          <StatusGrid items={status.operations} />
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-[var(--ink-muted)]" />
            <h2 className="text-lg font-semibold">Token links and risks</h2>
          </div>
          <StatusGrid items={[...status.tokenPolicy, ...status.knownRisks]} />
        </section>
      </div>
    </AppShell>
  );
}
