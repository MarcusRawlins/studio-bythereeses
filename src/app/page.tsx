import { AppShell } from "@/components/AppShell";
import { listProjects } from "@/lib/crm";
import { getDashboardMetrics } from "@/lib/dashboard";
import { formatDate, formatMoney } from "@/lib/format";
import { ArrowRight, Clock, CreditCard, Mail, Plus } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
const stageLabels: Record<string, string> = {
  inquiry: "Inquiry",
  proposal_sent: "Proposal Sent",
  retainer_paid: "Retainer Paid",
  planning: "Planning",
  editing: "Editing",
  delivered: "Delivered",
  completed: "Completed",
};

function normalizeChart(values: number[]) {
  const max = Math.max(...values, 1);
  return values.map((value, index) => {
    const x = 48 + index * 112;
    const y = 214 - (value / max) * 156;
    return `${x},${y}`;
  }).join(" ");
}

export default async function DashboardPage() {
  const [rows, metrics] = await Promise.all([
    listProjects(),
    getDashboardMetrics(),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const active = rows.filter(({ project }) => project.status === "active");
  const upcoming = rows
    .filter(({ project }) => project.eventDate && project.eventDate >= today)
    .sort((a, b) => String(a.project.eventDate).localeCompare(String(b.project.eventDate)))
    .slice(0, 4);
  const inquiryCount = rows.filter(({ project }) => project.stage === "inquiry" || project.stage === "proposal_sent").length;
  const stageCounts = active.reduce<Record<string, number>>((counts, { project }) => {
    counts[project.stage] = (counts[project.stage] ?? 0) + 1;
    return counts;
  }, {});

  const bookedValue = metrics.acceptedBookedValueCents;
  const outstandingPayments = metrics.outstandingPaymentCents;
  const monthlyValues = [0, 0, bookedValue * 0.25, bookedValue * 0.55, bookedValue * 0.7, bookedValue].map(Math.round);
  const chartPoints = normalizeChart(monthlyValues);
  const nextActions = [
    ...(metrics.nextPaymentDue ? [{
      href: `/invoices/${metrics.nextPaymentDue.invoiceId}`,
      label: metrics.nextPaymentDue.dueDate < today ? "Follow up on overdue payment" : "Upcoming payment due",
      detail: `${metrics.nextPaymentDue.invoiceNumber} · ${metrics.nextPaymentDue.label} · ${formatMoney(metrics.nextPaymentDue.amountCents)} due ${formatDate(metrics.nextPaymentDue.dueDate)}`,
      icon: CreditCard,
    }] : []),
    ...rows
      .filter(({ project }) => project.stage === "inquiry")
      .slice(0, 2)
      .map(({ project, client }) => ({
        href: `/projects/${project.id}`,
        label: "Follow up on inquiry",
        detail: `${project.name} · ${client.firstName} ${client.lastName}`,
        icon: Mail,
      })),
    ...rows
      .filter(({ project }) => project.stage === "proposal_sent")
      .slice(0, 2)
      .map(({ project, client }) => ({
        href: `/projects/${project.id}`,
        label: "Check proposal status",
        detail: `${project.name} · ${client.firstName} ${client.lastName}`,
        icon: Mail,
      })),
    ...upcoming.slice(0, 2).map(({ project }) => ({
      href: `/projects/${project.id}`,
      label: "Upcoming project",
      detail: `${project.name} · ${formatDate(project.eventDate)}`,
      icon: Clock,
    })),
  ].slice(0, 5);

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 sm:flex-row sm:items-end">
          <div>
            <h1 className="brand-page-title text-4xl md:text-5xl">Dashboard</h1>
            <p className="mt-3 text-sm text-[var(--ink-muted)]">Business overview for projects, payments, client activity, and upcoming work.</p>
          </div>
          <Link href="/projects/new" prefetch={false} className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 transition">
            <Plus className="h-4 w-4" />
            Create new project
          </Link>
        </header>

        <section className="grid gap-4 xl:grid-cols-[1fr_300px]">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
              <div className="text-sm text-[var(--ink-muted)]">Inquiries this month</div>
              <div className="mt-3 text-3xl font-semibold">{metrics.inquiriesThisMonth}</div>
              <p className="mt-2 text-xs text-[var(--ink-muted)]">Deduped from CRM projects and booking calls.</p>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
              <div className="text-sm text-[var(--ink-muted)]">Booked project value</div>
              <div className="mt-3 text-3xl font-semibold">{formatMoney(bookedValue)}</div>
              <p className="mt-2 text-xs text-[var(--ink-muted)]">Accepted proposal value.</p>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
              <div className="text-sm text-[var(--ink-muted)]">Active projects</div>
              <div className="mt-3 text-3xl font-semibold">{active.length}</div>
              <p className="mt-2 text-xs text-[var(--ink-muted)]">Inquiry through delivery.</p>
            </div>
          </div>

          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Open sales conversations</div>
            <div className="mt-3 text-3xl font-semibold">{inquiryCount}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Inquiry or proposal sent.</p>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1fr_300px]">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-3xl font-semibold">{formatMoney(bookedValue)}</div>
                <div className="mt-1 text-sm text-[var(--ink-muted)]">Accepted booked value</div>
              </div>
              <Link href="/projects" prefetch={false} className="rounded-sm border border-[var(--line)] px-4 py-2 text-sm font-semibold">
                View projects
              </Link>
            </div>

            <div className="mt-8 overflow-x-auto">
              <svg viewBox="0 0 680 260" className="h-[260px] min-w-[680px] w-full" role="img" aria-label="Booked value chart">
                {[0, 1, 2, 3, 4].map((line) => (
                  <line key={line} x1="48" x2="640" y1={214 - line * 39} y2={214 - line * 39} stroke="#e5e0d8" strokeDasharray="2 2" />
                ))}
                <polygon points={`48,214 ${chartPoints} 608,214`} fill="rgba(122,102,92,0.12)" />
                <polyline points={chartPoints} fill="none" stroke="var(--brand-brown)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                {monthLabels.map((label, index) => (
                  <text key={label} x={48 + index * 112} y="244" textAnchor="middle" className="fill-[var(--ink-muted)] text-xs">
                    {label}
                  </text>
                ))}
              </svg>
            </div>
          </div>

          <aside className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Next actions</h2>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">Generated from inquiry/proposal stages and upcoming project dates.</p>
            <div className="mt-5 space-y-5">
              {nextActions.map((action) => (
                <Link key={`${action.label}-${action.href}`} href={action.href} prefetch={false} className="flex gap-3 transition hover:text-[var(--brand-brown)]">
                  <action.icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                  <div>
                    <div className="text-sm font-medium">{action.label}</div>
                    <div className="mt-1 text-xs text-[var(--ink-muted)]">{action.detail}</div>
                  </div>
                </Link>
              ))}
              {!nextActions.length && <p className="text-sm text-[var(--ink-muted)]">Follow-ups and upcoming work will appear here as projects move through the CRM.</p>}
            </div>
          </aside>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1fr_300px]">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
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

          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Outstanding payments</div>
            <div className="mt-3 text-3xl font-semibold">{formatMoney(outstandingPayments)}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">
              {metrics.overduePaymentCount > 0
                ? `${metrics.overduePaymentCount} overdue payment${metrics.overduePaymentCount === 1 ? "" : "s"} need follow-up.`
                : metrics.dueSoonPaymentCount > 0
                  ? `${metrics.dueSoonPaymentCount} payment${metrics.dueSoonPaymentCount === 1 ? "" : "s"} due in the next 14 days.`
                  : "No unpaid scheduled payments due soon."}
            </p>
            {metrics.nextPaymentDue && (
              <Link href={`/invoices/${metrics.nextPaymentDue.invoiceId}`} prefetch={false} className="mt-4 block rounded-md border border-[var(--line)] bg-[#faf7f1] p-3 text-sm transition hover:border-[var(--brand-brown)]">
                <span className="block font-semibold">{metrics.nextPaymentDue.label}</span>
                <span className="mt-1 block text-xs text-[var(--ink-muted)]">
                  {formatMoney(metrics.nextPaymentDue.amountCents)} due {formatDate(metrics.nextPaymentDue.dueDate)}
                </span>
              </Link>
            )}
          </div>
        </section>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Upcoming projects</h2>
            <Link href="/projects" prefetch={false} className="inline-flex items-center gap-2 text-sm font-semibold">
              View all <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="mt-4 divide-y divide-[var(--line)]">
            {upcoming.map(({ project, client }) => (
              <Link key={project.id} href={`/projects/${project.id}`} prefetch={false} className="grid gap-2 py-4 transition hover:bg-[#f6efe5] md:grid-cols-[1fr_180px_130px] md:px-3">
                <div>
                  <div className="font-semibold">{project.name}</div>
                  <div className="mt-1 text-sm text-[var(--ink-muted)]">{client.firstName} {client.lastName}</div>
                </div>
                <div className="text-sm text-[var(--ink-muted)]">{formatDate(project.eventDate)}</div>
                <div className="text-sm font-semibold capitalize">{project.stage.replaceAll("_", " ")}</div>
              </Link>
            ))}
            {!upcoming.length && <div className="py-8 text-sm text-[var(--ink-muted)]">No upcoming project dates yet.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
