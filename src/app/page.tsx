import { AppShell } from "@/components/AppShell";
import { getAgenda } from "@/lib/agenda";
import { listProjects } from "@/lib/crm";
import { getDashboardMetrics, listDashboardActionItems } from "@/lib/dashboard";
import { formatDate, formatMoney } from "@/lib/format";
import { addDaysToDateKey, dateKeyInTimeZone } from "@/lib/timezone";
import { ArrowRight, CalendarPlus, CalendarRange, ClipboardList, CreditCard, FileSignature, Mail, Plus } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

const stageLabels: Record<string, string> = {
  inquiry: "Inquiry",
  proposal_sent: "Proposal Sent",
  retainer_paid: "Retainer Paid",
  planning: "Planning",
  editing: "Editing",
  delivered: "Delivered",
  completed: "Completed",
};

const actionIcons = {
  engagement_session: CalendarPlus,
  invoice_payment: CreditCard,
  proposal_waiting: FileSignature,
  questionnaire_draft: ClipboardList,
  inquiry_followup: Mail,
};

const timeZone = "America/New_York";

export function dashboardDateLabel(value = new Date(), displayTimeZone = timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: displayTimeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(value);
}

export function dashboardGreeting(value = new Date(), displayTimeZone = timeZone) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: displayTimeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).find((part) => part.type === "hour")?.value ?? 0);

  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function dashboardDateKeyParts(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return { month: "TBD", day: "—" };
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return {
    month: new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date),
    day: String(day),
  };
}

export default async function DashboardPage() {
  const now = new Date();
  const today = dateKeyInTimeZone(now, timeZone);
  const displayDate = dashboardDateLabel(now, timeZone);
  const greeting = dashboardGreeting(now, timeZone);
  const [rows, metrics, actionItems, agenda] = await Promise.all([
    listProjects(),
    getDashboardMetrics(now),
    listDashboardActionItems(now, 8),
    getAgenda({
      fromDate: today,
      toDate: addDaysToDateKey(today, 7),
      limit: 7,
      timeZone,
    }),
  ]);
  const active = rows.filter(({ project }) => project.status === "active");
  const upcomingWeddings = rows
    .filter(({ project }) => project.type === "wedding" && project.eventDate && project.eventDate >= today)
    .sort((a, b) => String(a.project.eventDate).localeCompare(String(b.project.eventDate)))
    .slice(0, 4);
  const inquiryCount = active.filter(({ project }) => project.stage === "inquiry" || project.stage === "proposal_sent").length;
  const stageCounts = active.reduce<Record<string, number>>((counts, { project }) => {
    counts[project.stage] = (counts[project.stage] ?? 0) + 1;
    return counts;
  }, {});

  const bookedValue = metrics.acceptedBookedValueCents;
  const outstandingPayments = metrics.clientPayableOutstandingPaymentCents;

  return (
    <AppShell>
      <div className="flex flex-col gap-[var(--gap)]">
        <header className="grid gap-6 border-b border-[var(--line)] pb-6 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <div className="studio-caps mb-4 flex flex-wrap items-center gap-3 text-[0.6rem] text-[var(--ink-3)]">
              <span>{displayDate}</span>
              <span className="hidden h-px w-7 bg-[var(--ink)] sm:inline-block" />
              <span>Studio overview</span>
            </div>
            <h1 className="brand-page-title text-5xl md:text-7xl">
              {greeting}, <em className="font-[var(--serif)] italic">Tyler.</em>
            </h1>
            <p className="mt-3 font-[var(--serif)] text-xl italic text-[var(--ink-2)]">
              {inquiryCount} conversation{inquiryCount === 1 ? "" : "s"} in motion · {agenda.items.length} dated items ahead
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/agenda" prefetch={false} className="studio-caps inline-flex items-center justify-center gap-2 border border-[var(--line)] bg-transparent px-3 py-2 text-[0.6rem] transition hover:border-[var(--ink)]">
              <CalendarRange className="h-4 w-4" />
              View agenda
            </Link>
            <Link href="/projects/new" prefetch={false} className="brand-primary-button inline-flex items-center justify-center gap-2 px-4 py-2.5 transition">
              <Plus className="h-4 w-4" />
              Create new project
            </Link>
          </div>
        </header>

        <section className="grid gap-[var(--gap)] xl:grid-cols-[1.45fr_1fr]">
          <div className="studio-card pb-2">
            <div className="flex flex-col justify-between gap-5 sm:flex-row">
              <div>
                <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Booked value · accepted</div>
                <div className="studio-serif mt-3 text-5xl leading-none tracking-[-0.02em] tabular-nums md:text-6xl">{formatMoney(bookedValue)}</div>
                <div className="mt-3 flex flex-wrap gap-5">
                  <span className="studio-caps text-[0.56rem] text-[var(--positive)]">{formatMoney(outstandingPayments)} outstanding</span>
                  <span className="studio-caps text-[0.56rem] text-[var(--ink-3)]">{metrics.inquiriesThisMonth} inquiries this month</span>
                </div>
              </div>
              <div className="sm:text-right">
                <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Outstanding</div>
                <div className="studio-serif mt-2 text-3xl tabular-nums">{formatMoney(outstandingPayments)}</div>
                <div className="studio-caps mt-2 text-[0.56rem] text-[var(--ink-3)]">
                  {metrics.overduePaymentCount} overdue · {metrics.dueSoonPaymentCount} due soon
                </div>
              </div>
            </div>
            <div className="mt-7 h-16 border-b border-[var(--line-soft)] bg-[linear-gradient(90deg,transparent_0,var(--accent-soft)_50%,transparent_100%)]" />
          </div>

          <div className="studio-card">
            <div className="flex items-center justify-between">
              <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">This week</div>
              <span className="studio-caps text-[0.56rem] text-[var(--ink-3)]">{displayDate} onward</span>
            </div>
            <div className="mt-5">
              {agenda.items.slice(0, 6).map((item) => {
                const dateParts = dashboardDateKeyParts(item.date);
                return (
                  <Link key={`${item.kind}-${item.id}`} href={item.href} prefetch={false} className="grid grid-cols-[52px_1fr_auto] gap-3 border-t border-[var(--line-soft)] py-3 first:border-t-0">
                    <div className="text-center">
                      <div className="studio-caps text-[0.52rem] text-[var(--ink-3)]">{dateParts.month}</div>
                      <div className="studio-serif mt-0.5 text-2xl leading-none">{dateParts.day}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{item.title}</div>
                      <div className="mt-1 truncate text-xs text-[var(--ink-3)]">
                        {item.projectName ?? "Unlinked booking"}{item.clientName ? ` · ${item.clientName}` : ""}
                      </div>
                    </div>
                    <div className="studio-caps self-center text-[0.52rem] text-[var(--ink-3)]">{item.time ?? "All day"}</div>
                  </Link>
                );
              })}
              {!agenda.items.length && <p className="py-6 text-sm text-[var(--ink-3)]">No dated sessions or calls in the next week.</p>}
            </div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1.45fr_1fr]">
          <div className="studio-card">
            <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Today</div>
                <h2 className="studio-serif mt-1 text-2xl">What needs you</h2>
              </div>
              <span className="studio-chip">{actionItems.length} open</span>
            </div>
            <div>
              {actionItems.map((action) => {
                const Icon = actionIcons[action.kind];
                return (
                  <Link key={`${action.kind}-${action.id}`} href={action.href} prefetch={false} className="grid gap-3 border-t border-[var(--line-soft)] py-4 first:border-t-0 md:grid-cols-[28px_1fr_auto] md:items-center">
                    <Icon className="h-4 w-4 text-[var(--ink-3)]" />
                    <div>
                      <div className="font-medium">{action.label}</div>
                      <div className="mt-1 text-sm text-[var(--ink-3)]">{action.projectName ?? action.clientName ?? action.detail}</div>
                      {action.detail && action.detail !== action.projectName && (
                        <div className="mt-1 text-xs text-[var(--ink-3)]">{action.detail}</div>
                      )}
                    </div>
                    <div className="studio-caps hidden text-[0.54rem] text-[var(--ink-3)] md:block">Review</div>
                  </Link>
                );
              })}
              {!actionItems.length && <p className="border border-dashed border-[var(--line)] px-4 py-6 text-sm text-[var(--ink-3)]">Nothing urgent is waiting right now.</p>}
            </div>
          </div>

          <div className="studio-card">
            <div className="mb-4">
              <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Pipeline</div>
              <h2 className="studio-serif mt-1 text-2xl">{active.length} active projects</h2>
            </div>
            <div className="grid gap-px bg-[var(--line-soft)]">
              {Object.entries(stageLabels).slice(0, 6).map(([stage, label]) => (
                <div key={stage} className="grid grid-cols-[1fr_auto] items-center gap-3 bg-[var(--paper)] px-3 py-3">
                  <span className={`studio-chip studio-stage-${stage}`}>{label}</span>
                  <span className="studio-serif text-xl tabular-nums">{stageCounts[stage] ?? 0}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Inquiries this month</div>
            <div className="studio-stat-number mt-3">{metrics.inquiriesThisMonth}</div>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Open sales</div>
            <div className="studio-stat-number mt-3">{inquiryCount}</div>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Active projects</div>
            <div className="studio-stat-number mt-3">{active.length}</div>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">This week</div>
            <div className="studio-stat-number mt-3">{agenda.items.length}</div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1fr_300px]">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm xl:col-span-2">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Active pipeline</h2>
              <Link href="/projects?stages=inquiry,proposal_sent,retainer_paid,planning" prefetch={false} className="inline-flex items-center gap-2 text-sm font-semibold">
                View pipeline <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {Object.entries(stageLabels).map(([stage, label]) => (
                <div key={stage} className="rounded-md border border-[var(--line)] bg-[#faf7f1] p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">{label}</div>
                  <div className="mt-3 text-2xl font-semibold">{stageCounts[stage] ?? 0}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Upcoming weddings</h2>
            <Link href="/projects" prefetch={false} className="inline-flex items-center gap-2 text-sm font-semibold">
              View all <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="mt-4 divide-y divide-[var(--line)]">
            {upcomingWeddings.map(({ project, client }) => (
              <Link key={project.id} href={`/projects/${project.id}`} prefetch={false} className="grid gap-2 py-4 transition hover:bg-[#f6efe5] md:grid-cols-[1fr_180px_130px] md:px-3">
                <div>
                  <div className="font-semibold">{project.name}</div>
                  <div className="mt-1 text-sm text-[var(--ink-muted)]">
                    {client ? `${client.firstName} ${client.lastName}` : "Needs primary client"}
                  </div>
                </div>
                <div className="text-sm text-[var(--ink-muted)]">{formatDate(project.eventDate)}</div>
                <div className="text-sm font-semibold capitalize">{project.stage.replaceAll("_", " ")}</div>
              </Link>
            ))}
            {!upcomingWeddings.length && <div className="py-8 text-sm text-[var(--ink-muted)]">No upcoming wedding dates yet.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
