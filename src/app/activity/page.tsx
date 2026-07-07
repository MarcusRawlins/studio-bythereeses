import { AppShell } from "@/components/AppShell";
import { SettingsTabs } from "@/components/SettingsTabs";
import { listStudioActivityLog } from "@/lib/activity";
import { ArrowRight, History, ShieldCheck } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

type ActivityPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type ActivityFilter = "all" | "admin" | "agent" | "client" | "system";

const filterOptions: Array<{ value: ActivityFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "admin", label: "Admin" },
  { value: "agent", label: "Agent" },
  { value: "client", label: "Client" },
  { value: "system", label: "System" },
];

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function activityHref(actor: ActivityFilter) {
  return actor === "all" ? "/activity" : `/activity?actor=${encodeURIComponent(actor)}`;
}

function activityDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function metadataPreview(metadata: Record<string, unknown> | null) {
  if (!metadata) return null;
  const entries = Object.entries(metadata).slice(0, 4);
  if (!entries.length) return null;
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ");
}

export default async function ActivityPage({ searchParams }: ActivityPageProps) {
  const params = searchParams ? await searchParams : {};
  const rawActor = firstQueryValue(params.actor);
  const selectedActor: ActivityFilter = rawActor === "admin" || rawActor === "agent" || rawActor === "client" || rawActor === "system"
    ? rawActor
    : "all";
  const rows = await listStudioActivityLog({
    actorType: selectedActor,
    limit: 150,
  });
  // CR-2 (left-nav reorganization). Strict `=== "1"`, dark by default. Flag off ⇒ no tab strip,
  // page renders exactly as today.
  const settingsNavGroupEnabled = process.env.SETTINGS_NAV_GROUP === "1";

  return (
    <AppShell>
      <div className="space-y-6">
        {settingsNavGroupEnabled ? <SettingsTabs active="activity" /> : null}
        <header className="border-b border-[var(--line)] pb-5">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <div className="studio-caps flex items-center gap-2 text-[0.58rem] text-[var(--ink-3)]">
                <ShieldCheck className="h-3.5 w-3.5" />
                The Reeses Studio
              </div>
              <h1 className="brand-page-title mt-2 text-5xl md:text-6xl">Audit log</h1>
              <p className="mt-2 font-[var(--serif)] text-xl italic text-[var(--ink-2)]">
                Canonical record of Studio changes, client-facing events, and agent activity.
              </p>
            </div>
            <Link href="/agenda" prefetch={false} className="inline-flex items-center justify-center gap-2 border border-[var(--line)] bg-[var(--paper)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--accent)]">
              <History className="h-4 w-4" />
              Review recent work
            </Link>
          </div>
        </header>

        <section className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] pb-5">
          <span className="studio-caps mr-1 text-[0.58rem] text-[var(--ink-3)]">Actor</span>
          {filterOptions.map((option) => (
            <Link
              key={option.value}
              href={activityHref(option.value)}
              prefetch={false}
              className={`studio-chip transition ${selectedActor === option.value ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--ink)]" : "hover:border-[var(--ink)]"}`}
            >
              {option.label}
            </Link>
          ))}
          <span className="studio-chip ml-auto">{rows.length} shown</span>
        </section>

        <section className="border border-[var(--line)] bg-[var(--paper)]">
          <div className="grid border-b border-[var(--line)] px-4 py-3 studio-caps text-[0.56rem] text-[var(--ink-3)] lg:grid-cols-[180px_1fr_180px_180px]">
            <div>Time</div>
            <div>Event</div>
            <div className="hidden lg:block">Actor</div>
            <div className="hidden lg:block">Record</div>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {rows.map((row) => {
              const preview = metadataPreview(row.metadata);
              return (
                <article key={row.id} className="grid gap-3 px-4 py-4 transition hover:bg-[var(--paper-2)] lg:grid-cols-[180px_1fr_180px_180px] lg:items-start">
                  <div>
                    <div className="font-semibold">{activityDateTime(row.createdAt)}</div>
                    <div className="studio-caps mt-1 text-[0.52rem] text-[var(--ink-3)]">{row.actorType}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold">{row.label}</div>
                    {preview ? <div className="mt-1 break-words text-sm text-[var(--ink-3)]">{preview}</div> : null}
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-[var(--ink-3)] lg:hidden">
                      <span>{row.actorName ?? row.actorType}</span>
                      {row.project ? <span>{row.project.name}</span> : null}
                      {row.client ? <span>{row.client.name}</span> : null}
                    </div>
                  </div>
                  <div className="hidden text-sm lg:block">
                    <div className="font-semibold">{row.actorName ?? row.actorType}</div>
                    <div className="studio-caps mt-1 text-[0.52rem] text-[var(--ink-3)]">{row.actorType}</div>
                  </div>
                  <div className="hidden text-sm lg:block">
                    {row.project ? (
                      <Link href={`/projects/${row.project.id}`} prefetch={false} className="inline-flex items-center gap-1 font-semibold transition hover:text-[var(--accent)]">
                        {row.project.name}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    ) : null}
                    {row.client ? (
                      <Link href={`/clients/${row.client.id}`} prefetch={false} className="mt-1 block text-[var(--ink-3)] transition hover:text-[var(--accent)]">
                        {row.client.name}
                      </Link>
                    ) : null}
                    {!row.project && !row.client ? <span className="text-[var(--ink-3)]">Studio-wide</span> : null}
                  </div>
                </article>
              );
            })}
            {!rows.length ? (
              <div className="px-4 py-10 text-center text-sm text-[var(--ink-3)]">No activity matches this filter.</div>
            ) : null}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
