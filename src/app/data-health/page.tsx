import { AppShell } from "@/components/AppShell";
import { SettingsTabs } from "@/components/SettingsTabs";
import { listStudioDataHealth } from "@/lib/data-health";
import Link from "next/link";

export const dynamic = "force-dynamic";

function plural(count: number, singular: string, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function issueHref(issue: Awaited<ReturnType<typeof listStudioDataHealth>>["issues"][number]) {
  return issue.repair.href;
}

export default async function DataHealthPage() {
  const health = await listStudioDataHealth();
  // CR-2 (left-nav reorganization). Strict `=== "1"`, dark by default. Flag off ⇒ no tab strip,
  // page renders exactly as today.
  const settingsNavGroupEnabled = process.env.SETTINGS_NAV_GROUP === "1";

  return (
    <AppShell>
      <div className="space-y-6">
        {settingsNavGroupEnabled ? <SettingsTabs active="data-health" /> : null}
        <header className="border-b border-[var(--line)] pb-5">
          <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">The Reeses Studio</div>
          <h1 className="brand-page-title mt-2 text-5xl md:text-6xl">Data health</h1>
        </header>

        <section className="grid gap-3 md:grid-cols-4">
          <div className="border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Projects</div>
            <div className="mt-2 text-2xl font-semibold">{plural(health.summary.projectCount, "project")}</div>
          </div>
          <div className="border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Clients</div>
            <div className="mt-2 text-2xl font-semibold">{plural(health.summary.clientCount, "client")}</div>
          </div>
          <div className="border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Issues</div>
            <div className="mt-2 text-2xl font-semibold">{plural(health.summary.issueCount, "issue", "issues")}</div>
          </div>
          <div className="border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">High priority</div>
            <div className="mt-2 text-2xl font-semibold">{health.summary.highIssueCount}</div>
          </div>
        </section>

        <section className="overflow-hidden border border-[var(--line)] bg-[var(--paper)]">
          <div className="studio-caps grid grid-cols-[150px_1fr_1fr_130px] border-b border-[var(--line)] bg-[var(--paper-2)] px-4 py-3 text-[0.58rem] text-[var(--ink-3)] max-lg:hidden">
            <div>Severity</div>
            <div>Issue</div>
            <div>Record</div>
            <div>Action</div>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {health.issues.map((issue) => {
              const href = issueHref(issue);
              return (
                <div key={issue.id} className="grid gap-3 px-4 py-4 lg:grid-cols-[150px_1fr_1fr_130px] lg:items-center">
                  <div>
                    <span className={`studio-chip ${issue.severity === "high" ? "border-[var(--danger)] text-[var(--danger)]" : "border-[var(--warning)] text-[var(--warning)]"}`}>
                      {issue.severity}
                    </span>
                  </div>
                  <div>
                    <div className="font-semibold">{issue.label}</div>
                    <div className="mt-1 text-sm text-[var(--ink-3)]">{issue.detail}</div>
                    <div className="mt-2 text-xs leading-5 text-[var(--ink-3)]">{issue.repair.agentWorkflow}</div>
                  </div>
                  <div className="text-sm text-[var(--ink-3)]">
                    {issue.invoice && (
                      <span>
                        <span className="font-semibold text-[var(--ink)]">{issue.invoice.name}</span>
                        {issue.project && <> · {issue.project.name}</>}
                      </span>
                    )}
                    {!issue.invoice && issue.project && <span className="font-semibold text-[var(--ink)]">{issue.project.name}</span>}
                    {issue.client && (
                      <span>
                        <span className="font-semibold text-[var(--ink)]">{issue.client.name}</span>
                        {" · "}
                        {issue.client.email}
                      </span>
                    )}
                  </div>
                  <div>
                    {href && (
                      <Link href={href} prefetch={false} className="inline-flex items-center justify-center border border-[var(--line)] px-3 py-2 text-xs font-semibold transition hover:border-[var(--ink)]">
                        {issue.repair.label}
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
            {!health.issues.length && (
              <div className="p-8 text-sm font-semibold text-[var(--ink-3)]">No data health issues found.</div>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
