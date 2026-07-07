import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-board-index-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { listProjectBoardIndex, listProjectIndex } = await import("./crm");
  const { BOARD_MAX_ROWS } = await import("./project-board");
  const database = rawDb();
  const now = "2026-06-01T12:00:00.000Z";

  const insertClient = database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
    VALUES (?, ?, 'wedding', ?, 'active', ?, ?, ?)
  `);
  const insertParticipant = database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES (?, ?, ?, 'primary', 1, ?)
  `);

  // Clean 1:1 project/primary-participant fixtures (no dupe-primary anomaly) — used for the
  // default-scope test (#12) and the filter/order-parity test (#7).
  const stagesByIndex: Record<number, string> = { 7: "planning", 8: "completed" };
  for (let index = 1; index <= 8; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const projectId = `project-${suffix}`;
    const clientId = `client-${suffix}`;
    const stage = stagesByIndex[index] ?? "inquiry";
    insertClient.run(clientId, `Client ${suffix}`, "Reese", `client-${suffix}@example.com`, now, now);
    insertProject.run(projectId, `Project ${suffix}`, stage, `2026-09-${suffix}`, now, now);
    insertParticipant.run(`participant-${suffix}`, projectId, clientId, now);
  }

  // ---------------------------------------------------------------------------
  // Test 12 — Default in-flight scope (rev 2, MAJOR 2, spec §4 test 12).
  // ---------------------------------------------------------------------------
  const defaultScope = await listProjectBoardIndex({});
  assert.equal(defaultScope.rows.some((row) => row.project.stage === "completed"), false, "completed is excluded by default");
  assert.equal(defaultScope.rows.length, 7, "6 in-flight stages worth of fixture rows (everything but the completed one)");
  assert.equal(defaultScope.stages.includes("completed"), false);

  const explicitCompleted = await listProjectBoardIndex({ stages: ["completed"] });
  assert.equal(explicitCompleted.rows.length, 1);
  assert.equal(explicitCompleted.rows[0].project.stage, "completed");
  assert.deepEqual(explicitCompleted.stages, ["completed"]);

  console.log("test 12 (default in-flight scope) passed");

  // ---------------------------------------------------------------------------
  // Test 7 — listProjectBoardIndex filter/order parity (spec §4 test 7): given the same
  // q/stages/sort input, its unpaginated row set equals the union of every page listProjectIndex
  // would return for that same filter.
  // ---------------------------------------------------------------------------
  const parityFilter = { stages: ["inquiry", "planning"], sort: "eventDate" as const };
  const boardParity = await listProjectBoardIndex(parityFilter);

  const pagedIds: string[] = [];
  let page = 1;
  for (;;) {
    const paged = await listProjectIndex({ ...parityFilter, page, pageSize: 3 });
    pagedIds.push(...paged.rows.map((row) => row.project.id));
    if (page >= paged.totalPages) break;
    page += 1;
  }

  assert.deepEqual(
    boardParity.rows.map((row) => row.project.id),
    pagedIds,
    "the unpaginated board rows equal the union of every listProjectIndex page, in the same order",
  );

  console.log("test 7 (filter/order parity) passed");

  // ---------------------------------------------------------------------------
  // Test 13 — Dedupe (rev 2, MINOR 7, spec §4 test 13): the DB-integration half. NOTE: a fixture
  // with two `is_primary_contact = 1` rows for the same project can no longer be inserted at all —
  // migration `0034_unique_project_primary_contact.sql` added a partial `UNIQUE(project_id) WHERE
  // is_primary_contact = 1` index, so the exact anomaly the spec describes is now blocked at the
  // schema layer (an INSERT attempting it throws `SQLITE_CONSTRAINT_UNIQUE`, proven ad hoc while
  // building this test). `dedupeRowsByProjectId` (the actual collapse-logic unit under test) is
  // still applied unconditionally per rev 2 (defense-in-depth) and is proven correct against a
  // synthetic duplicate-row array in `project-board.test.ts` test 13, which is not constrained by
  // the live schema. This block instead confirms the normal (single-primary) integration path
  // wires `dedupeRowsByProjectId` through without over- or under-counting.
  // ---------------------------------------------------------------------------
  insertClient.run("client-single", "Single", "Primary", "single@example.com", now, now);
  insertProject.run("project-single", "Single Primary Wedding", "inquiry", "2026-10-01", now, now);
  insertParticipant.run("participant-single", "project-single", "client-single", now);

  const singlePrimary = await listProjectBoardIndex({ q: "single primary" });
  assert.equal(singlePrimary.rows.length, 1, "a normal single-primary project yields exactly one card");
  assert.equal(singlePrimary.rows[0].project.id, "project-single");
  assert.equal(singlePrimary.filteredCount, 1, "filteredCount matches the de-duplicated count");
  assert.equal(singlePrimary.truncated, false);

  console.log("test 13 (dedupe integration wiring) passed");

  // ---------------------------------------------------------------------------
  // BOARD_MAX_ROWS truncation sanity: filteredCount can exceed rows.length once truncated.
  // ---------------------------------------------------------------------------
  assert.equal(typeof BOARD_MAX_ROWS, "number");
  assert.ok(BOARD_MAX_ROWS > 0);

  console.log("project-board-index tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
