import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-projects-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: ProjectsPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  const insertClient = database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  const insertParticipant = database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES (?, ?, ?, 'primary', 1, ?)
  `);

  for (let index = 1; index <= 55; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const projectId = `project-${suffix}`;
    const clientId = `client-${suffix}`;
    const stage = index === 1 ? "planning" : "inquiry";
    const projectName = index === 1 ? "Alex Wedding" : `Pagination Wedding ${suffix}`;
    insertClient.run(clientId, index === 1 ? "Alex" : `Client ${suffix}`, index === 1 ? "Taylor" : "Reese", `client-${suffix}@example.com`, now, now);
    insertProject.run(projectId, projectName, "wedding", stage, `2026-09-${suffix}`, now, now);
    if (index !== 55) {
      insertParticipant.run(`participant-${suffix}`, projectId, clientId, now);
    }
  }

  const fullMarkup = renderToStaticMarkup(await ProjectsPage({
    searchParams: Promise.resolve({ notice: "seed-data-removed" }),
  }));
  assert.match(fullMarkup, /55 canonical projects loaded/);
  assert.match(fullMarkup, /Alex &amp; Taylor seed project/);
  assert.match(fullMarkup, /Alex Wedding/);
  assert.match(fullMarkup, /Pagination Wedding 55/);
  assert.doesNotMatch(fullMarkup, /Projects pagination/);
  assert.match(fullMarkup, /Filter/);
  assert.doesNotMatch(fullMarkup, /Project filters/);
  assert.doesNotMatch(fullMarkup, /Rows per page/);

  const secondPageMarkup = renderToStaticMarkup(await ProjectsPage({
    searchParams: Promise.resolve({ page: "2", q: "wedding", sort: "name", stages: "inquiry", pageSize: "50" }),
  }));
  assert.match(secondPageMarkup, /Showing 51-54 of 54 canonical projects/);
  assert.match(secondPageMarkup, /Pagination Wedding 55/);
  assert.match(secondPageMarkup, /Needs primary client/);
  assert.match(secondPageMarkup, /href="\/projects\?q=wedding&amp;sort=name&amp;stages=inquiry&amp;pageSize=50"/);

  const expandedMarkup = renderToStaticMarkup(await ProjectsPage({
    searchParams: Promise.resolve({ pageSize: "200" }),
  }));
  assert.match(expandedMarkup, /55 canonical projects loaded/);
  assert.match(expandedMarkup, /Pagination Wedding 55/);
  assert.doesNotMatch(expandedMarkup, /Projects pagination/);

  const filteredMarkup = renderToStaticMarkup(await ProjectsPage({
    searchParams: Promise.resolve({ q: "no match" }),
  }));
  assert.match(filteredMarkup, /0 of 55 canonical projects shown/);
  assert.match(filteredMarkup, /Clear filters/);

  // ---------------------------------------------------------------------------
  // Phase 17 (kanban board) — Test 8: flag-off purity. PROJECTS_BOARD_VIEW is unset (default) at
  // this point in the file — `?view=board` must render byte-identical markup to plain `/projects`
  // (no board container, no List/Board toggle, `view` never appears in the URL), proving
  // `listProjectBoardIndex` is never reachable when the flag is off (spec §4 test 8).
  // ---------------------------------------------------------------------------
  assert.equal(process.env.PROJECTS_BOARD_VIEW, undefined, "board flag must be unset for the flag-off assertion below");
  const flagOffPlainMarkup = renderToStaticMarkup(await ProjectsPage({ searchParams: Promise.resolve({}) }));
  const flagOffBoardQueryMarkup = renderToStaticMarkup(await ProjectsPage({ searchParams: Promise.resolve({ view: "board" }) }));
  assert.equal(flagOffBoardQueryMarkup, flagOffPlainMarkup, "?view=board renders byte-identical markup to /projects when the flag is off");
  assert.doesNotMatch(flagOffPlainMarkup, /data-testid="project-board"/);
  assert.doesNotMatch(flagOffPlainMarkup, /view=board/);
  assert.doesNotMatch(flagOffPlainMarkup, /Projects view toggle/);

  console.log("test 8 (flag-off purity) passed");

  // ---------------------------------------------------------------------------
  // Phase 17 — flip the flag on for the remaining board-mode tests.
  // ---------------------------------------------------------------------------
  process.env.PROJECTS_BOARD_VIEW = "1";

  insertClient.run("client-secret", "Secret", "Client", "secret@example.com", now, now);
  insertProject.run("project-secret", "Secret Wedding", "wedding", "inquiry", "2026-11-11", now, now);
  insertParticipant.run("participant-secret", "project-secret", "client-secret", now);
  database.prepare("UPDATE projects SET notes = ?, venue_name = ? WHERE id = ?").run(
    "SECRET_NOTE_MARKER",
    "SECRET_VENUE_MARKER",
    "project-secret",
  );

  // ---------------------------------------------------------------------------
  // Test 14 — Slim card shape (rev 2, MEDIUM 3): the board only ever receives id, name, stage,
  // dateLabel, budgetLabel, client{id,firstName,lastName,email}|null, milestoneSummary — no other
  // project/client column (e.g. notes, venueName) leaks into the client-component boundary.
  // ---------------------------------------------------------------------------
  const boardMarkup = renderToStaticMarkup(await ProjectsPage({
    searchParams: Promise.resolve({ view: "board", q: "secret" }),
  }));
  assert.match(boardMarkup, /data-testid="project-board"/, "the board container renders when the flag is on and view=board");
  assert.match(boardMarkup, /Secret Wedding/);
  assert.match(boardMarkup, /Secret Client/);
  assert.doesNotMatch(boardMarkup, /SECRET_NOTE_MARKER/, "raw project.notes must not cross into the board's client props");
  assert.doesNotMatch(boardMarkup, /SECRET_VENUE_MARKER/, "raw project.venueName must not cross into the board's client props");

  console.log("test 14 (slim card shape) passed");

  // ---------------------------------------------------------------------------
  // Test 9 — Milestone graceful-off: PROJECT_PROGRESS_TIMELINE stays unset here, so every board
  // card's milestoneSummary is null and only the value line renders — no broken layout, no thrown
  // error (straight reuse of Phase 22's own rendering guard, asserted from the board's markup).
  // ---------------------------------------------------------------------------
  assert.equal(process.env.PROJECT_PROGRESS_TIMELINE, undefined, "milestone timeline flag must be unset for the graceful-off assertion");
  assert.doesNotMatch(boardMarkup, /Overdue/);

  console.log("test 9 (milestone graceful-off) passed");

  // ---------------------------------------------------------------------------
  // Board toggle + default in-flight scope sanity: the List/Board toggle renders once the flag is
  // on, and the board (no explicit stages filter) excludes nothing relevant to this fixture set
  // (no `completed`-stage fixtures exist here; the dedicated default-scope test lives in
  // project-board-index.test.ts).
  // ---------------------------------------------------------------------------
  assert.match(boardMarkup, /Projects view toggle/);

  console.log("projects page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
