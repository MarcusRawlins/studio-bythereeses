import type { ProjectMilestone } from "@/lib/project-milestones";

// Phase 22 — project progress / milestone timeline (dark behind PROJECT_PROGRESS_TIMELINE).
// Pure presentation: done=filled, current=ring/highlight, upcoming=muted, overdue=amber with the
// expected date. n/a milestones are never passed in (the compute module already omits them).

const STATUS_CLASSES: Record<ProjectMilestone["status"], string> = {
  done: "border-[var(--accent)] bg-[var(--accent)] text-white",
  current: "border-[var(--accent)] bg-white text-[var(--accent-strong)] ring-2 ring-[rgba(122,90,58,0.3)]",
  upcoming: "border-[var(--line)] bg-white text-[var(--ink-3)]",
  overdue: "border-[var(--warning)] bg-[#fff9e8] text-[var(--warning)]",
  "n/a": "border-[var(--line)] bg-white text-[var(--ink-3)]",
};

const STATUS_LABELS: Record<ProjectMilestone["status"], string> = {
  done: "Done",
  current: "Now",
  upcoming: "Upcoming",
  overdue: "Overdue",
  "n/a": "N/A",
};

function formatMilestoneDate(date: string | null) {
  if (!date) return null;
  // Every `date` on a ProjectMilestone is a plain YYYY-MM-DD calendar key (never an ISO
  // datetime) — anchor to noon before formatting so no local-timezone rendering shifts the day.
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${date}T12:00:00`));
}

export function ProjectMilestoneStrip({ milestones }: { milestones: ProjectMilestone[] }) {
  if (!milestones.length) return null;

  return (
    <section className="studio-section-card">
      <div>
        <h2 className="text-lg font-semibold">Progress</h2>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          Automated milestone timeline, derived from canonical project data. Read-only — never writes back to the project stage.
        </p>
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        {milestones.map((milestone) => {
          const formattedDate = formatMilestoneDate(milestone.date);
          return (
            <div
              key={milestone.key}
              className={`flex min-w-[150px] flex-1 flex-col gap-1 rounded-md border px-3 py-2.5 text-sm transition ${STATUS_CLASSES[milestone.status]}`}
            >
              <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] opacity-80">
                {STATUS_LABELS[milestone.status]}
              </span>
              <span className="font-semibold leading-snug">{milestone.label}</span>
              {formattedDate && milestone.status !== "done" && (
                <span className="text-xs opacity-80">
                  {milestone.status === "overdue" ? "Expected" : "Due"} {formattedDate}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
