import { AppShell } from "@/components/AppShell";
import { getAgentTaskInbox } from "@/lib/agent-tasks";
import { formatDate } from "@/lib/format";
import { ArrowRight, Bot, CheckCircle2, CircleDashed, Clock3, XCircle } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

const statusLabels: Record<string, string> = {
  queued: "Queued",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const statusClassNames: Record<string, string> = {
  queued: "border-[var(--line)] bg-[var(--paper)] text-[var(--ink-2)]",
  in_progress: "border-[#b79b77] bg-[#f8efe2] text-[#6d4f2c]",
  completed: "border-[#99b894] bg-[#edf5e9] text-[#38623b]",
  failed: "border-[#d9a3a0] bg-[#fbefee] text-[#873d3a]",
  cancelled: "border-[var(--line)] bg-[var(--paper-2)] text-[var(--ink-3)]",
};

const statusOptions = [
  { value: "", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

const assignedAgentOptions = [
  { value: "", label: "All agents" },
  { value: "The Reeses Studio Agent", label: "Studio Agent" },
  { value: "Proposal Agent", label: "Proposal Agent" },
  { value: "Timeline Agent", label: "Timeline Agent" },
  { value: "Billing Agent", label: "Billing Agent" },
  { value: "Bookkeeping Agent", label: "Bookkeeping Agent" },
  { value: "Communications Agent", label: "Communications Agent" },
];

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function statusIcon(status: string) {
  if (status === "completed") return CheckCircle2;
  if (status === "failed") return XCircle;
  if (status === "in_progress") return Clock3;
  return CircleDashed;
}

function shortDate(value: string | null) {
  if (!value) return "Not set";
  if (value.includes("T")) {
    return new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(value));
  }
  return formatDate(value);
}

type InboxPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function InboxPage({ searchParams }: InboxPageProps = {}) {
  const params = searchParams ? await searchParams : {};
  const selectedStatus = firstQueryValue(params.status) ?? "";
  const selectedAssignedAgent = firstQueryValue(params.assignedAgent) ?? "";
  const { tasks, counts } = await getAgentTaskInbox({
    status: selectedStatus,
    assignedAgent: selectedAssignedAgent,
  });
  const openTasks = counts.queued + counts.inProgress;
  const recentCompleted = tasks.filter((row) => row.task.status === "completed").slice(0, 3);
  const taskCountLabel = `${tasks.length} filtered task${tasks.length === 1 ? "" : "s"}`;

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 lg:flex-row lg:items-end">
          <div>
            <div className="studio-caps text-[0.62rem] text-[var(--ink-3)]">Agent Work Queue</div>
            <h1 className="brand-page-title mt-2 text-5xl md:text-7xl">Inbox</h1>
            <p className="mt-3 max-w-3xl font-[var(--serif)] text-xl italic text-[var(--ink-2)]">
              Durable assignments, handoffs, and results from The Reeses Studio agent.
            </p>
            <p className="studio-caps mt-3 text-[0.58rem] text-[var(--ink-3)]">{taskCountLabel}</p>
          </div>
          <Link href="/projects" prefetch={false} className="brand-primary-button inline-flex items-center justify-center gap-2 px-4 py-2.5 transition">
            Assign from a project
            <ArrowRight className="h-4 w-4" />
          </Link>
        </header>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Open tasks</div>
            <div className="studio-stat-number mt-3">{openTasks}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Queued or in progress.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Queued</div>
            <div className="studio-stat-number mt-3">{counts.queued}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Ready for agent pickup.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Completed</div>
            <div className="studio-stat-number mt-3">{counts.completed}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Finished with a result summary.</p>
          </div>
          <div className="studio-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Needs review</div>
            <div className="studio-stat-number mt-3">{counts.failed}</div>
            <p className="mt-2 text-xs text-[var(--ink-3)]">Failed agent work.</p>
          </div>
        </section>

        <section className="border-b border-[var(--line)] pb-5">
          <form className="grid gap-3 md:grid-cols-[180px_240px_auto]" action="/inbox">
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Status</span>
              <select name="status" defaultValue={selectedStatus} className="studio-input">
                {statusOptions.map((option) => (
                  <option key={option.value || "all"} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Assigned agent</span>
              <select name="assignedAgent" defaultValue={selectedAssignedAgent} className="studio-input">
                {assignedAgentOptions.map((option) => (
                  <option key={option.value || "all"} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap items-end gap-2">
              <button className="brand-primary-button px-4 py-2.5 transition">Apply</button>
              {(selectedStatus || selectedAssignedAgent) && (
                <Link href="/inbox" prefetch={false} className="inline-flex items-center justify-center border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--ink)]">
                  Clear
                </Link>
              )}
            </div>
          </form>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1fr_320px]">
          <div className="studio-card overflow-hidden p-0">
            <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold">Agent tasks</h2>
                <p className="mt-1 text-xs text-[var(--ink-3)]">Canonical task records from MCP and Studio actions.</p>
              </div>
              <Bot className="h-5 w-5 text-[var(--ink-3)]" />
            </div>

            <div className="divide-y divide-[var(--line-soft)]">
              {tasks.map(({ task, project }) => {
                const Icon = statusIcon(task.status);
                return (
                  <div key={task.id} className="grid gap-4 px-5 py-4 lg:grid-cols-[1fr_150px_150px] lg:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex items-center gap-1 border px-2 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.12em] ${statusClassNames[task.status] ?? statusClassNames.queued}`}>
                          <Icon className="h-3.5 w-3.5" />
                          {statusLabels[task.status] ?? task.status}
                        </span>
                        <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">{task.priority}</span>
                      </div>
                      <div className="mt-3 text-base font-semibold">{task.title}</div>
                      {task.instructions && <p className="mt-1 line-clamp-2 text-sm text-[var(--ink-2)]">{task.instructions}</p>}
                      {task.resultSummary && <p className="mt-2 text-sm text-[var(--brand-brown)]">{task.resultSummary}</p>}
                    </div>
                    <div className="text-sm">
                      {project ? (
                        <Link href={`/projects/${project.id}`} prefetch={false} className="font-semibold transition hover:text-[var(--brand-brown)]">
                          {project.name}
                        </Link>
                      ) : (
                        <span className="text-[var(--ink-3)]">No project</span>
                      )}
                      <div className="mt-1 text-xs text-[var(--ink-3)]">{task.sourceType ?? "manual"}{task.sourceId ? ` · ${task.sourceId}` : ""}</div>
                    </div>
                    <div className="text-sm text-[var(--ink-3)]">
                      <div>Created {shortDate(task.createdAt)}</div>
                      <div className="mt-1">Updated {shortDate(task.updatedAt)}</div>
                    </div>
                  </div>
                );
              })}
              {!tasks.length && (
                <div className="px-5 py-12 text-center">
                  <Bot className="mx-auto h-7 w-7 text-[var(--ink-3)]" />
                  <h2 className="mt-4 text-lg font-semibold">No agent tasks yet</h2>
                  <p className="mx-auto mt-2 max-w-md text-sm text-[var(--ink-3)]">
                    Tasks assigned through MCP or Studio project workflows will appear here with status, project links, and result summaries.
                  </p>
                </div>
              )}
            </div>
          </div>

          <aside className="space-y-5">
            <div className="studio-card">
              <h2 className="studio-serif text-3xl">Recent completions</h2>
              <div className="mt-5 space-y-4">
                {recentCompleted.map(({ task, project }) => (
                  <div key={task.id} className="border-b border-[var(--line-soft)] pb-4 last:border-b-0 last:pb-0">
                    <div className="text-sm font-semibold">{task.title}</div>
                    <div className="mt-1 text-xs text-[var(--ink-3)]">{project?.name ?? "No project"} · {shortDate(task.completedAt)}</div>
                  </div>
                ))}
                {!recentCompleted.length && <p className="text-sm text-[var(--ink-3)]">Completed agent work will collect here.</p>}
              </div>
            </div>

            <div className="studio-card">
              <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Agent API</div>
              <p className="mt-3 text-sm leading-6 text-[var(--ink-2)]">
                MCP tools can create, list, and update these tasks. The Studio UI reads the same canonical table, so task state stays in one place.
              </p>
            </div>
          </aside>
        </section>
      </div>
    </AppShell>
  );
}
