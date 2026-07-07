import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 18 §9 tests 1, 2, 3, 7, 12, 13 — computeDailyBrief assembles the three reused signal
// groups from real fixtures, the milestone section is flag-gated with zero extra queries when
// off, one failing source degrades only that section, a stale narration reads as absent, and the
// overdue-milestone scan pages through listProjectIndex to completion rather than truncating at
// one page (§1.1a).
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-daily-brief-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
delete process.env.PROJECT_PROGRESS_TIMELINE;
delete process.env.DAILY_BRIEF_ENABLED;

const NOW = new Date("2026-07-07T12:00:00.000Z"); // 08:00 ET (EDT) -> day_key 2026-07-07

async function main() {
  const { rawDb } = await import("@/db/client");
  const { computeDailyBrief, safeDailyBriefExtraSection, dailyBriefEnabled } = await import("@/lib/daily-brief");
  const database = rawDb();
  const now = NOW.toISOString();

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Ada', 'Lovelace', 'ada@example.com', ?, ?)
  `).run(now, now);

  // ---- Group 1 fixture: an overdue invoice payment (listDashboardActionItems) ----
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-action', 'Overdue Payment Project', 'other', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-action', 'project-action', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO invoices (id, project_id, invoice_number, status, created_at, updated_at)
    VALUES ('invoice-action', 'project-action', 'INV-ACTION', 'sent', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, due_date, status, created_at, updated_at)
    VALUES ('payment-action', 'invoice-action', 'Balance', '2026-06-01', 'pending', ?, ?)
  `).run(now, now);

  // ---- Group 2 fixture: an upcoming session within today..+2 days (getAgenda) ----
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-agenda', 'Upcoming Wedding Project', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-agenda', 'project-agenda', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_events (id, project_id, type, title, event_date, calendar_sync_status, created_at, updated_at)
    VALUES ('event-agenda', 'project-agenda', 'wedding', 'Wedding Day', '2026-07-08', 'not_connected', ?, ?)
  `).run(now, now);

  // ---- Group 3 fixture: an overdue final-payment milestone (loadProjectMilestoneSummaries) ----
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-milestone', 'Milestone Project', 'wedding', 'editing', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (id, project_id, invoice_number, status, created_at, updated_at)
    VALUES ('invoice-milestone', 'project-milestone', 'INV-MILESTONE', 'sent', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, due_date, status, created_at, updated_at)
    VALUES ('payment-milestone', 'invoice-milestone', 'Final payment', '2020-01-01', 'pending', ?, ?)
  `).run(now, now);

  // ======================================================================================
  // Test 1 — all three groups assembled from real fixtures (flag on).
  // ======================================================================================
  {
    const report = await computeDailyBrief(NOW, { projectProgressTimelineEnabled: true });
    assert.equal(report.dateLabel, "Tuesday, July 7", "dateLabel formats the ET calendar day");
    assert.ok(
      report.actionItems.some((item) => item.kind === "invoice_payment" && item.projectId === "project-action"),
      "actionItems includes the overdue invoice payment from listDashboardActionItems",
    );
    assert.ok(
      report.upcoming.some((item) => item.projectId === "project-agenda" && item.category === "wedding"),
      "upcoming includes the wedding session from getAgenda within today..+2 days",
    );
    assert.deepEqual(
      report.overdueMilestoneProjects,
      [{ projectId: "project-milestone", projectName: "Milestone Project" }],
      "overdueMilestoneProjects includes exactly the project with an overdue final-payment milestone",
    );
    assert.equal(report.narrative, null, "no daily_brief_narrations row for today yet -> null");
  }

  // ======================================================================================
  // Test 7 — narration presence/absence: today's row renders, yesterday's (stale) row is null.
  // ======================================================================================
  {
    database.prepare(`
      INSERT INTO daily_brief_narrations (day_key, narrative, generated_at) VALUES ('2026-07-06', 'Stale narration from yesterday.', ?)
    `).run(now);
    let report = await computeDailyBrief(NOW, { projectProgressTimelineEnabled: false });
    assert.equal(report.narrative, null, "a row for YESTERDAY's day_key reads as absent, not stale text (§3.4 case 3)");

    database.prepare(`
      INSERT INTO daily_brief_narrations (day_key, narrative, generated_at) VALUES ('2026-07-07', 'Fresh narration for today.', ?)
    `).run(now);
    report = await computeDailyBrief(NOW, { projectProgressTimelineEnabled: false });
    assert.equal(report.narrative, "Fresh narration for today.", "a row for TODAY's day_key renders verbatim");
  }

  // ======================================================================================
  // Test 2 — milestone section omitted when PROJECT_PROGRESS_TIMELINE is off; zero extra queries
  // (the milestone batch loader is never invoked in that branch).
  // ======================================================================================
  {
    let milestoneLoaderCalls = 0;
    const report = await computeDailyBrief(NOW, {
      projectProgressTimelineEnabled: false,
      loadMilestoneSummaries: async () => {
        milestoneLoaderCalls += 1;
        return new Map();
      },
    });
    assert.deepEqual(report.overdueMilestoneProjects, [], "overdueMilestoneProjects is empty when the flag is off, even though overdue fixtures exist");
    assert.equal(milestoneLoaderCalls, 0, "loadProjectMilestoneSummaries is never invoked when PROJECT_PROGRESS_TIMELINE is off");
    // Same env-read path (no explicit override) behaves identically.
    delete process.env.PROJECT_PROGRESS_TIMELINE;
    const envReport = await computeDailyBrief(NOW);
    assert.deepEqual(envReport.overdueMilestoneProjects, [], "env-unset PROJECT_PROGRESS_TIMELINE also omits the section");
  }

  // ======================================================================================
  // Test 3 — one failing signal source degrades only that section; report is never thrown.
  // ======================================================================================
  {
    const throwingAgenda = async (): Promise<never> => {
      throw new Error("agenda source down");
    };
    const report = await computeDailyBrief(NOW, { loadAgenda: throwingAgenda, projectProgressTimelineEnabled: false });
    assert.ok(report.actionItems.length > 0, "actionItems still populated when getAgenda throws");
    assert.deepEqual(report.upcoming, [], "upcoming degrades to empty when getAgenda throws, never propagated");

    const throwingMilestones = async (): Promise<never> => {
      throw new Error("milestone loader down");
    };
    const report2 = await computeDailyBrief(NOW, {
      projectProgressTimelineEnabled: true,
      loadMilestoneSummaries: throwingMilestones,
    });
    assert.ok(report2.actionItems.length > 0, "actionItems still populated when the milestone loader throws");
    assert.ok(report2.upcoming.length > 0, "upcoming still populated when the milestone loader throws");
    assert.deepEqual(report2.overdueMilestoneProjects, [], "overdueMilestoneProjects degrades to empty, never propagated");
  }

  // ======================================================================================
  // Test 8 — an AI-narration-step (or, defensively, any daily-brief compute) failure never blocks
  // the email: safeDailyBriefExtraSection's own try/catch swallows a hard throw from computeFn
  // and falls back to `undefined`, exactly the value that makes buildHealthDigest render its
  // health-only body (§2.1/§3.4).
  // ======================================================================================
  {
    process.env.DAILY_BRIEF_ENABLED = "1";
    const section = await safeDailyBriefExtraSection(NOW, async (): Promise<never> => {
      throw new Error("computeDailyBrief threw unexpectedly");
    });
    assert.equal(section, undefined, "a thrown computeFn degrades to undefined, never propagated to the caller");
    delete process.env.DAILY_BRIEF_ENABLED;
  }

  // ======================================================================================
  // Test 12 — flag-off is a true no-op: safeDailyBriefExtraSection never calls computeDailyBrief
  // when DAILY_BRIEF_ENABLED is unset (mirrors "computeDailyBrief is never called from the route").
  // ======================================================================================
  {
    delete process.env.DAILY_BRIEF_ENABLED;
    assert.equal(dailyBriefEnabled(), false, "DAILY_BRIEF_ENABLED unset reads as disabled");
    let computeCalls = 0;
    const section = await safeDailyBriefExtraSection(NOW, async (n) => {
      computeCalls += 1;
      return computeDailyBrief(n);
    });
    assert.equal(section, undefined, "flag-off -> no extra section");
    assert.equal(computeCalls, 0, "flag-off -> computeDailyBrief (the injected computeFn) is never invoked");
  }

  // ======================================================================================
  // Test 13 — the overdue-milestone scan pages through listProjectIndex to completion; a
  // project seeded past what a single 200-row page would return is still included.
  // ======================================================================================
  {
    database.exec("DELETE FROM invoice_payments; DELETE FROM invoices; DELETE FROM project_participants; DELETE FROM project_events; DELETE FROM projects;");

    const insertProject = database.prepare(`
      INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
      VALUES (?, ?, ?, 'planning', 'active', ?, ?, ?)
    `);
    // 200 filler active projects sorted BEFORE the target (ascending eventDate) so the target
    // lands on page 2 of a pageSize:200 listProjectIndex scan.
    for (let index = 0; index < 200; index += 1) {
      const suffix = String(index).padStart(4, "0");
      insertProject.run(`filler-${suffix}`, `Filler Project ${suffix}`, "other", `2026-01-${String((index % 28) + 1).padStart(2, "0")}`, now, now);
    }
    // The 201st active project — sorts last (far-future eventDate) — carries the overdue
    // final-payment milestone. A single-page (pageSize:200) call would never see it. Type
    // 'wedding' so it takes the milestone track that actually surfaces final_payment overdue.
    insertProject.run("project-page2", "Page Two Overdue Project", "wedding", "2099-01-01", now, now);
    database.prepare(`
      INSERT INTO invoices (id, project_id, invoice_number, status, created_at, updated_at)
      VALUES ('invoice-page2', 'project-page2', 'INV-PAGE2', 'sent', ?, ?)
    `).run(now, now);
    database.prepare(`
      INSERT INTO invoice_payments (id, invoice_id, label, due_date, status, created_at, updated_at)
      VALUES ('payment-page2', 'invoice-page2', 'Final payment', '2020-01-01', 'pending', ?, ?)
    `).run(now, now);

    const { listProjectIndex } = await import("@/lib/crm");
    let listProjectIndexCalls = 0;
    const report = await computeDailyBrief(NOW, {
      projectProgressTimelineEnabled: true,
      listProjectIndexPage: async (input) => {
        listProjectIndexCalls += 1;
        return listProjectIndex(input);
      },
    });
    assert.ok(listProjectIndexCalls >= 2, "the pagination loop issues more than one listProjectIndex call for 201 active projects");
    assert.ok(
      report.overdueMilestoneProjects.some((p) => p.projectId === "project-page2"),
      "the overdue project seeded past page 1 is still included — the scan does not truncate at one page",
    );
  }

  console.log("daily brief tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
