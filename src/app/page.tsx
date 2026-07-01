import { AppShell } from "@/components/AppShell";
import { dashboardActionHref, DashboardActionContext } from "@/components/DashboardActionContext";
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

function projectSectionHref(projectId: string, stage: string) {
  const sectionByStage: Record<string, string> = {
    inquiry: "communications",
    proposal_sent: "sales",
    retainer_paid: "finances",
    planning: "questionnaires",
    editing: "timeline",
    delivered: "portal",
    completed: "activity",
  };
  return `/projects/${projectId}#${sectionByStage[stage] ?? "overview"}`;
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
        <header className="studio-command-hero grid gap-6 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <div className="studio-caps mb-4 flex flex-wrap items-center gap-3 text-[0.6rem] text-[var(--ink-3)]">
              <span>{displayDate}</span>
              <span className="hidden h-px w-7 bg-[var(--ink)] sm:inline-block" />
              <span>Command center</span>
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

        <section className="studio-kpi-strip sm:grid-cols-2 xl:grid-cols-4">
          <div className="studio-kpi-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Booked value</div>
            <div className="studio-serif mt-2 text-4xl leading-none tabular-nums">{formatMoney(bookedValue)}</div>
            <div className="studio-caps mt-2 text-[0.54rem] text-[var(--positive)]">{formatMoney(outstandingPayments)} Outstanding</div>
          </div>
          <div className="studio-kpi-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Open sales</div>
            <div className="studio-stat-number mt-2 text-4xl">{inquiryCount}</div>
            <div className="studio-caps mt-2 text-[0.54rem] text-[var(--ink-3)]">{metrics.inquiriesThisMonth} inquiries this month</div>
          </div>
          <div className="studio-kpi-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Active projects</div>
            <div className="studio-stat-number mt-2 text-4xl">{active.length}</div>
            <div className="studio-caps mt-2 text-[0.54rem] text-[var(--ink-3)]">{metrics.overduePaymentCount} overdue · {metrics.dueSoonPaymentCount} due soon</div>
          </div>
          <div className="studio-kpi-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">This week</div>
            <div className="studio-stat-number mt-2 text-4xl">{agenda.items.length}</div>
            <div className="studio-caps mt-2 text-[0.54rem] text-[var(--ink-3)]">{displayDate} onward</div>
          </div>
        </section>

        <section className="grid gap-[var(--gap)] xl:grid-cols-[1.5fr_1fr]">
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
                const href = dashboardActionHref(action.kind, action.href, action.projectId);
                return (
                  <Link
                    key={`${action.kind}-${action.id}`}
                    href={href}
                    prefetch={false}
                    className="studio-action-row md:grid-cols-[28px_1fr_auto] md:items-center"
                  >
                    <Icon className="h-4 w-4 text-[var(--ink-3)]" />
                    <div>
                      <div className="font-medium">{action.label}</div>
                      <div className="mt-1 text-sm text-[var(--ink-2)]">
                        {action.projectName ?? action.clientName ?? action.detail}
                      </div>
                      <DashboardActionContext kind={action.kind} detail={action.detail} dueDate={action.dueDate} />
                    </div>
                    <div className="studio-caps hidden text-[0.54rem] text-[var(--brand-brown)] md:block">Open section →</div>
                  </Link>
                );
              })}
              {!actionItems.length && (
                <p className="border border-dashed border-[var(--line)] px-4 py-6 text-sm text-[var(--ink-3)]">
                  Nothing urgent is waiting right now.
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-[var(--gap)]">
            <div className="studio-card">
              <div className="flex items-center justify-between">
                <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">This week</div>
                <Link href="/agenda" prefetch={false} className="studio-caps text-[0.54rem] text-[var(--brand-brown)] transition hover:text-[var(--ink)]">
                  Full agenda
                </Link>
              </div>
              <div className="mt-4">
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
                {!agenda.items.length && <p className="py-4 text-sm text-[var(--ink-3)]">No dated sessions or calls in the next week.</p>}
              </div>
            </div>

            <div className="studio-card">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Pipeline</div>
                  <h2 className="studio-serif mt-1 text-xl">{active.length} active</h2>
                </div>
                <Link href="/projects?stages=inquiry,proposal_sent,retainer_paid,planning" prefetch={false} className="studio-caps text-[0.54rem] text-[var(--brand-brown)]">
                  View all
                </Link>
              </div>
              <div className="grid gap-px bg-[var(--line-soft)]">
                {Object.entries(stageLabels).slice(0, 6).map(([stage, label]) => (
                  <Link
                    key={stage}
                    href={`/projects?stages=${stage}`}
                    prefetch={false}
                    className="studio-pipeline-row"
                  >
                    <span className={`studio-chip studio-stage-${stage}`}>{label}</span>
                    <span className="studio-serif text-xl tabular-nums">{stageCounts[stage] ?? 0}</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="studio-card">
          <div className="flex items-center justify-between">
            <div>
              <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Upcoming weddings</div>
              <h2 className="studio-serif mt-1 text-2xl">Next on the calendar</h2>
            </div>
            <Link href="/projects" prefetch={false} className="inline-flex items-center gap-2 text-sm font-semibold">
              View all <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="mt-4 divide-y divide-[var(--line-soft)]">
            {upcomingWeddings.map(({ project, client }) => (
              <Link
                key={project.id}
                href={projectSectionHref(project.id, project.stage)}
                prefetch={false}
                className="grid gap-2 py-4 transition hover:bg-[var(--warm-highlight)] md:grid-cols-[1fr_180px_130px] md:px-3"
              >
                <div>
                  <div className="font-semibold">{project.name}</div>
                  <div className="mt-1 text-sm text-[var(--ink-muted)]">
                    {client ? `${client.firstName} ${client.lastName}` : "Needs primary client"}
                  </div>
                </div>
                <div className="text-sm text-[var(--ink-muted)]">{formatDate(project.eventDate)}</div>
                <span className={`studio-chip studio-stage-${project.stage} w-fit`}>{project.stage.replaceAll("_", " ")}</span>
              </Link>
            ))}
            {!upcomingWeddings.length && <div className="py-8 text-sm text-[var(--ink-muted)]">No upcoming wedding dates yet.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
