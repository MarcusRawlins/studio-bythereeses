import { AppShell } from "@/components/AppShell";
import { type AgendaCategory, type AgendaItem, getAgenda } from "@/lib/agenda";
import { formatDate } from "@/lib/format";
import { addDaysToDateKey, dateKeyInTimeZone } from "@/lib/timezone";
import { ArrowRight, CalendarDays, CalendarRange, Clock, MapPin, PhoneCall, UsersRound } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

type AgendaPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type AgendaRange = "30" | "90" | "year" | "all";
type AgendaFilter = "all" | "weddings" | "engagements" | "other" | "calls";

const timeZone = "America/New_York";

const filterOptions: Array<{ value: AgendaFilter; label: string; types?: AgendaCategory[] }> = [
  { value: "all", label: "All" },
  { value: "weddings", label: "Weddings", types: ["wedding"] },
  { value: "engagements", label: "Engagements", types: ["engagement"] },
  { value: "other", label: "Other sessions", types: ["other"] },
  { value: "calls", label: "Calls", types: ["call"] },
];

const rangeOptions: Array<{ value: AgendaRange; label: string }> = [
  { value: "30", label: "Next 30 days" },
  { value: "90", label: "Next 90 days" },
  { value: "year", label: "This year" },
  { value: "all", label: "All upcoming" },
];

const categoryLabels: Record<AgendaCategory, string> = {
  wedding: "Wedding",
  engagement: "Engagement",
  other: "Session",
  call: "Call",
};

const statusLabels: Record<string, string> = {
  synced: "Synced",
  not_connected: "Not synced",
  sync_failed: "Sync failed",
};

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function agendaHref(filter: AgendaFilter, range: AgendaRange) {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("type", filter);
  if (range !== "90") params.set("range", range);
  const query = params.toString();
  return query ? `/agenda?${query}` : "/agenda";
}

function toDateForRange(fromDate: string, range: AgendaRange) {
  if (range === "30") return addDaysToDateKey(fromDate, 30);
  if (range === "90") return addDaysToDateKey(fromDate, 90);
  if (range === "year") return `${fromDate.slice(0, 4)}-12-31`;
  return null;
}

function monthLabel(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function groupByMonth(items: AgendaItem[]) {
  const groups = new Map<string, AgendaItem[]>();
  for (const item of items) {
    const label = monthLabel(item.date);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return Array.from(groups.entries());
}

function statusLabel(value?: string | null) {
  if (!value) return "Not synced";
  return statusLabels[value] ?? value.replaceAll("_", " ");
}

function AgendaIcon({ category }: { category: AgendaCategory }) {
  if (category === "call") return <PhoneCall className="h-4 w-4" />;
  if (category === "wedding") return <UsersRound className="h-4 w-4" />;
  return <CalendarDays className="h-4 w-4" />;
}

export default async function AgendaPage({ searchParams }: AgendaPageProps) {
  const params = searchParams ? await searchParams : {};
  const rawFilter = firstQueryValue(params.type);
  const rawRange = firstQueryValue(params.range);
  const selectedFilter: AgendaFilter = rawFilter === "weddings" || rawFilter === "engagements" || rawFilter === "other" || rawFilter === "calls"
    ? rawFilter
    : "all";
  const selectedRange: AgendaRange = rawRange === "30" || rawRange === "year" || rawRange === "all" ? rawRange : "90";
  const selectedTypes = filterOptions.find((option) => option.value === selectedFilter)?.types;
  const today = dateKeyInTimeZone(new Date(), timeZone);
  const toDate = toDateForRange(today, selectedRange);
  const { items } = await getAgenda({
    fromDate: today,
    toDate,
    types: selectedTypes,
    timeZone,
  });
  const groupedItems = groupByMonth(items);

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="border-b border-[var(--line)] pb-5">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">The Reeses Studio</div>
              <h1 className="brand-page-title mt-2 text-5xl md:text-6xl">Agenda</h1>
              <p className="mt-2 font-[var(--serif)] text-xl italic text-[var(--ink-2)]">Weddings, sessions, and calls in one chronological studio view.</p>
            </div>
            <Link href="/scheduler" prefetch={false} className="brand-primary-button inline-flex items-center justify-center gap-2 px-4 py-2.5 transition">
              <CalendarRange className="h-4 w-4" />
              Scheduler
            </Link>
          </div>
        </header>

        <section className="grid gap-4 border-b border-[var(--line)] pb-5 xl:grid-cols-[1fr_auto] xl:items-end">
          <div className="flex flex-wrap items-center gap-2">
            <span className="studio-caps mr-1 text-[0.58rem] text-[var(--ink-3)]">Show</span>
            {filterOptions.map((option) => (
              <Link
                key={option.value}
                href={agendaHref(option.value, selectedRange)}
                prefetch={false}
                className={`studio-chip transition ${selectedFilter === option.value ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--ink)]" : "hover:border-[var(--ink)]"}`}
              >
                {option.label}
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="studio-caps mr-1 text-[0.58rem] text-[var(--ink-3)]">Range</span>
            {rangeOptions.map((option) => (
              <Link
                key={option.value}
                href={agendaHref(selectedFilter, option.value)}
                prefetch={false}
                className={`studio-chip transition ${selectedRange === option.value ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--ink)]" : "hover:border-[var(--ink)]"}`}
              >
                {option.label}
              </Link>
            ))}
          </div>
        </section>

        <section className="space-y-6">
          {groupedItems.map(([month, monthItems]) => (
            <div key={month} className="space-y-3">
              <div className="sticky top-0 z-10 border-y border-[var(--line)] bg-[var(--bg)] py-2">
                <h2 className="studio-caps text-[0.62rem] text-[var(--ink-3)]">{month}</h2>
              </div>
              <div className="divide-y divide-[var(--line)] border border-[var(--line)] bg-[var(--paper)]">
                {monthItems.map((item) => (
                  <Link
                    key={`${item.kind}-${item.id}`}
                    href={item.href}
                    prefetch={false}
                    className="grid gap-3 px-4 py-4 transition hover:bg-[var(--paper-2)] lg:grid-cols-[120px_1fr_220px_120px] lg:items-center"
                  >
                    <div>
                      <div className="font-semibold">{formatDate(item.date)}</div>
                      <div className="mt-1 flex items-center gap-1 text-xs text-[var(--ink-3)]">
                        {item.time ? <Clock className="h-3.5 w-3.5" /> : <CalendarDays className="h-3.5 w-3.5" />}
                        {item.time ?? "All day"}
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="grid h-8 w-8 place-items-center rounded-full border border-[var(--line)] text-[var(--ink-3)]">
                          <AgendaIcon category={item.category} />
                        </span>
                        <div className="min-w-0">
                          <div className="font-semibold">{item.title}</div>
                          <div className="mt-1 truncate text-sm text-[var(--ink-3)]">
                            {item.projectName ?? "Unlinked booking"}{item.clientName ? ` · ${item.clientName}` : ""}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="text-sm text-[var(--ink-3)]">
                      {item.venueLabel ? (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3.5 w-3.5" />
                          {item.venueLabel}
                        </span>
                      ) : (
                        <span>{categoryLabels[item.category]}</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2 lg:justify-end">
                      <span className="studio-caps border border-[var(--line)] px-2 py-1 text-[0.55rem] text-[var(--ink-3)]">
                        {statusLabel(item.calendarSyncStatus)}
                      </span>
                      <ArrowRight className="h-4 w-4 text-[var(--ink-3)]" />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ))}
          {!items.length && (
            <div className="border border-[var(--line)] bg-[var(--paper)] px-5 py-10 text-sm text-[var(--ink-3)]">
              Nothing is scheduled for this view yet.
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
