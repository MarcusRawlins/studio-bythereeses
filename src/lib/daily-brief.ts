// Phase 18 — AI daily brief. Mirrors the shape of computeSystemHealth() (system-health.ts:185):
// assembles the §1 signal catalog into a typed report, wrapping each signal source in its own
// try/catch so one failing source degrades ONLY that section (never the whole report). PURE READ
// over three already-shipped queries (§0): listDashboardActionItems, getAgenda,
// loadProjectMilestoneSummaries — zero new SQL joins are written for this phase. The narration
// read is the one new (non-canonical) table this phase owns: a single `WHERE day_key = ?` lookup,
// never a network call to any AI provider (§3.4).

import { db } from "@/db/client";
import { dailyBriefNarrations } from "@/db/schema";
import { listDashboardActionItems, type DashboardActionItem } from "@/lib/dashboard";
import { getAgenda, type AgendaItem } from "@/lib/agenda";
import { listProjectIndex } from "@/lib/crm";
import { loadProjectMilestoneSummaries } from "@/lib/project-milestones-batch";
import { addDaysToDateKey, dateKeyInTimeZone } from "@/lib/timezone";
import { eq } from "drizzle-orm";

export type DailyBriefReport = {
  generatedAt: string; // ISO
  dateLabel: string; // e.g. "Tuesday, July 7"
  actionItems: DashboardActionItem[]; // from listDashboardActionItems
  upcoming: AgendaItem[]; // from getAgenda
  overdueMilestoneProjects: Array<{ projectId: string; projectName: string | null }>; // only when PROJECT_PROGRESS_TIMELINE=1
  narrative: string | null; // set from the day's cached AI narration row, if fresh (§3.3); else null
};

const BRIEF_TIME_ZONE = "America/New_York";
// §1: higher than the dashboard's 8 ("What needs you" limit) — an email digest isn't paginated,
// so don't silently truncate what the dashboard truncates for screen space.
const ACTION_ITEMS_LIMIT = 50;
// §1: today through +2 days (ET) — "what's coming up," not the dashboard's full-future agenda.
const UPCOMING_WINDOW_DAYS = 2;

// §4 — DAILY_BRIEF_ENABLED (new). Takes effect only when MONITOR_ENABLED=1 (the cron route
// already gates its whole body on that flag before this is ever consulted). Same strict
// three-state read idiom as MONITOR_ENABLED / PROJECT_PROGRESS_TIMELINE.
export function dailyBriefEnabled(): boolean {
  return process.env.DAILY_BRIEF_ENABLED === "1";
}

// Test seam only (mirrors ComputeHealthOptions.loadFinanceReport in system-health.ts): production
// callers never pass these. They let tests force an individual signal source to throw (proving the
// per-block degrade, §9 test 3) or spy on call counts (proving no fresh/ad-hoc query, §9 tests 2/13)
// without a mocking framework, matching this repo's established DI-for-testability pattern.
export type ComputeDailyBriefOptions = {
  listActionItems?: typeof listDashboardActionItems;
  loadAgenda?: typeof getAgenda;
  listProjectIndexPage?: typeof listProjectIndex;
  loadMilestoneSummaries?: typeof loadProjectMilestoneSummaries;
  projectProgressTimelineEnabled?: boolean; // overrides the PROJECT_PROGRESS_TIMELINE env read
};

async function readTodaysNarration(dayKey: string): Promise<string | null> {
  // Single cheap SELECT against a table this phase owns (§3.4) — the query itself scopes to
  // TODAY's day_key, so a stale (yesterday's) row simply never matches and reads as absent,
  // identical treatment to a missing row (no separate staleness check needed).
  const rows = await db
    .select({ narrative: dailyBriefNarrations.narrative })
    .from(dailyBriefNarrations)
    .where(eq(dailyBriefNarrations.dayKey, dayKey));
  return rows[0]?.narrative ?? null;
}

export async function computeDailyBrief(now = new Date(), options?: ComputeDailyBriefOptions): Promise<DailyBriefReport> {
  const dayKey = dateKeyInTimeZone(now, BRIEF_TIME_ZONE);
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: BRIEF_TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);

  const listActionItems = options?.listActionItems ?? listDashboardActionItems;
  const loadAgenda = options?.loadAgenda ?? getAgenda;
  const listProjectIndexPage = options?.listProjectIndexPage ?? listProjectIndex;
  const loadMilestoneSummaries = options?.loadMilestoneSummaries ?? loadProjectMilestoneSummaries;

  // --- Priority leads / stuck items / overdue payments ---------------------------------------
  let actionItems: DashboardActionItem[] = [];
  try {
    actionItems = await listActionItems(now, ACTION_ITEMS_LIMIT);
  } catch {
    // Degrade this section only — identical defensive shape to computeSystemHealth's per-block
    // try/catch (e.g. system-health.ts:386-433).
  }

  // --- Upcoming shoots / calls -----------------------------------------------------------------
  let upcoming: AgendaItem[] = [];
  try {
    const toDate = addDaysToDateKey(dayKey, UPCOMING_WINDOW_DAYS);
    const agenda = await loadAgenda({ fromDate: dayKey, toDate, timeZone: BRIEF_TIME_ZONE });
    upcoming = agenda.items;
  } catch {
    // Degrade this section only.
  }

  // --- Overdue project milestones (§1.1, gated on PROJECT_PROGRESS_TIMELINE=1) ----------------
  let overdueMilestoneProjects: Array<{ projectId: string; projectName: string | null }> = [];
  const timelineEnabled = options?.projectProgressTimelineEnabled ?? process.env.PROJECT_PROGRESS_TIMELINE === "1";
  if (timelineEnabled) {
    try {
      // §1.1a — projectRows come from a full-pagination loop over listProjectIndex (the exact
      // read the projects list page already issues), never a fresh SELECT and never a single
      // truncating page: loop page:1..totalPages, accumulating every row, so the active-project
      // count is never silently bounded by one page's worth of results.
      type ProjectIndexRow = Awaited<ReturnType<typeof listProjectIndex>>["rows"][number]["project"];
      const projectRows: ProjectIndexRow[] = [];
      let page = 1;
      for (;;) {
        const indexPage = await listProjectIndexPage({ page, pageSize: 200, sort: "eventDate" });
        projectRows.push(...indexPage.rows.map(({ project }) => project));
        if (indexPage.currentPage >= indexPage.totalPages) break;
        page = indexPage.currentPage + 1;
      }
      const summaries = await loadMilestoneSummaries(projectRows, now);
      overdueMilestoneProjects = projectRows
        .filter((project) => summaries.get(project.id)?.hasOverdue)
        .map((project) => ({ projectId: project.id, projectName: project.name }));
    } catch {
      // Degrade this section only — never invented as an error or placeholder row (§1.1).
    }
  }

  // --- Cached AI narration (§3.3/§3.4) ---------------------------------------------------------
  let narrative: string | null = null;
  try {
    narrative = await readTodaysNarration(dayKey);
  } catch {
    // Degrade this section only.
  }

  return {
    generatedAt: now.toISOString(),
    dateLabel,
    actionItems,
    upcoming,
    overdueMilestoneProjects,
    narrative,
  };
}

// Pure text formatting — heading + bullets + narrative. Never touches the footer; the caller
// (buildHealthDigest, §2.1) owns where this string lands relative to the dead-man footer.
export function formatDailyBriefSection(report: DailyBriefReport): string {
  const lines: string[] = ["Today: what needs you", report.dateLabel, ""];

  if (report.narrative) {
    lines.push(report.narrative);
    lines.push("");
  }

  if (report.actionItems.length) {
    lines.push("Needs you:");
    for (const item of report.actionItems) {
      lines.push(`  - ${item.label}: ${item.detail}`);
    }
    lines.push("");
  }

  if (report.upcoming.length) {
    lines.push("Coming up:");
    for (const item of report.upcoming) {
      const when = item.time ? `${item.date} ${item.time}` : item.date;
      const who = item.clientName ? ` (${item.clientName})` : "";
      lines.push(`  - ${when} — ${item.title}${who}`);
    }
    lines.push("");
  }

  if (report.overdueMilestoneProjects.length) {
    lines.push("Overdue milestones:");
    for (const project of report.overdueMilestoneProjects) {
      lines.push(`  - ${project.projectName ?? project.projectId}`);
    }
    lines.push("");
  }

  // Trim any single trailing blank line so buildHealthDigest's own lines.push("") after
  // extraSection doesn't produce a double-blank gap before the footer.
  while (lines[lines.length - 1] === "") lines.pop();

  return lines.join("\n");
}

// Phase 18 (§2.1) — the systems-monitor cron route calls this instead of inlining the
// dailyBriefEnabled()/computeDailyBrief()/formatDailyBriefSection() sequence itself, so the
// "never blocks the email" try/catch is a single named, independently testable unit rather than
// logic duplicated at the route call site. `computeFn` is a test seam only (mirrors
// ComputeDailyBriefOptions above) — production always uses the default (the real computeDailyBrief).
export async function safeDailyBriefExtraSection(
  now: Date,
  computeFn: (now: Date) => Promise<DailyBriefReport> = computeDailyBrief,
): Promise<string | undefined> {
  if (!dailyBriefEnabled()) return undefined;
  try {
    const brief = await computeFn(now);
    return formatDailyBriefSection(brief);
  } catch {
    // §2.1/§3.4: an AI-narration-step (or, defensively, any daily-brief compute) failure must
    // NEVER prevent sendAdminAlertEmail from running with the health-only body — fall back to
    // leaving the section absent so buildHealthDigest renders exactly as it does today.
    return undefined;
  }
}
