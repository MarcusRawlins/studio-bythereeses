import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOARD_MOVE_TIMEOUT_MS,
  boardMoveOutcome,
  COLUMN_CARD_CAP,
  dedupeRowsByProjectId,
  groupProjectsByStage,
  isValidProjectStage,
  loginBounceRedirectUrl,
  moveProjectLocalStage,
  performBoardMove,
  toProjectBoardCard,
  type BoardFetchImpl,
  type ProjectBoardCard,
  type ProjectStageOption,
  visibleColumnCards,
} from "./project-board";

const here = path.dirname(fileURLToPath(import.meta.url));

const stageOptions: ProjectStageOption[] = [
  { value: "inquiry", label: "Inquiry" },
  { value: "proposal_sent", label: "Proposal Sent" },
  { value: "retainer_paid", label: "Retainer Paid" },
  { value: "planning", label: "Planning" },
  { value: "editing", label: "Editing" },
  { value: "delivered", label: "Delivered" },
  { value: "completed", label: "Completed" },
];

function card(id: string, stage: string): ProjectBoardCard {
  return {
    id,
    name: `Project ${id}`,
    stage,
    dateLabel: "2026-09-19",
    budgetLabel: "$1,000.00",
    client: null,
  };
}

// ---------------------------------------------------------------------------
// Test 1 — Grouping (spec §4 test 1).
// ---------------------------------------------------------------------------
function test1Grouping() {
  const rows = [card("a", "inquiry"), card("b", "planning"), card("c", "inquiry")];
  const grouped = groupProjectsByStage(rows, ["inquiry", "planning", "editing"]);

  assert.deepEqual(grouped.get("inquiry")?.map((row) => row.id), ["a", "c"]);
  assert.deepEqual(grouped.get("planning")?.map((row) => row.id), ["b"]);
  // A stage with zero matching rows still produces an empty (not missing) bucket.
  assert.deepEqual(grouped.get("editing"), []);
  assert.equal(grouped.has("completed"), false, "stages outside the requested column list get no bucket");

  console.log("test 1 (grouping) passed");
}

// ---------------------------------------------------------------------------
// Test 2 — Optimistic move + revert are symmetric (spec §4 test 2).
// ---------------------------------------------------------------------------
function test2MoveRevertSymmetry() {
  const rows = [card("a", "inquiry"), card("b", "planning")];
  const moved = moveProjectLocalStage(rows, "a", "editing");
  assert.equal(moved.find((row) => row.id === "a")?.stage, "editing");
  assert.equal(moved.find((row) => row.id === "b")?.stage, "planning");

  const reverted = moveProjectLocalStage(moved, "a", "inquiry");
  assert.deepEqual(reverted, rows);

  console.log("test 2 (move/revert symmetry) passed");
}

// ---------------------------------------------------------------------------
// Test 3 — Show-more slicing (spec §4 test 3).
// ---------------------------------------------------------------------------
function test3ShowMoreSlicing() {
  const rows = Array.from({ length: 30 }, (_, index) => card(`p${index}`, "inquiry"));

  const collapsed = visibleColumnCards(rows, 0, COLUMN_CARD_CAP);
  assert.equal(collapsed.visible.length, COLUMN_CARD_CAP);
  assert.equal(collapsed.showMore, true);

  const expanded = visibleColumnCards(rows, rows.length + 10, COLUMN_CARD_CAP);
  assert.equal(expanded.visible.length, rows.length);
  assert.equal(expanded.showMore, false);

  console.log("test 3 (show-more slicing) passed");
}

// ---------------------------------------------------------------------------
// Test 4 — Stage-transition call correctness (spec §4 test 4): dropping a card issues exactly one
// POST to /api/projects/{id}/stage with a FormData body whose `stage` field is the target
// column's value.
// ---------------------------------------------------------------------------
async function test4StageTransitionCallCorrectness() {
  const calls: Array<{ url: string; stage: string | null }> = [];
  const fetchImpl: BoardFetchImpl = async (url, init) => {
    calls.push({ url, stage: (init.body as FormData).get("stage") as string | null });
    return { ok: true, url: "https://studio.test/projects/project-1" };
  };

  const result = await performBoardMove({ fetchImpl, projectId: "project-1", nextStage: "planning" });

  assert.equal(calls.length, 1, "exactly one POST is issued");
  assert.equal(calls[0].url, "/api/projects/project-1/stage");
  assert.equal(calls[0].stage, "planning");
  assert.equal(result.outcome, "success");

  console.log("test 4 (stage-transition call correctness) passed");
}

// ---------------------------------------------------------------------------
// Test 5 — Failure revert (spec §4 test 5): mocked fetch resolving { ok: false, url:
// ".../projects/:id" } reverts the card and fires no second request.
// ---------------------------------------------------------------------------
async function test5FailureRevert() {
  let callCount = 0;
  const fetchImpl: BoardFetchImpl = async () => {
    callCount += 1;
    return { ok: false, url: "https://studio.test/projects/project-1" };
  };

  const rows = [card("project-1", "inquiry")];
  const moved = moveProjectLocalStage(rows, "project-1", "editing");

  const result = await performBoardMove({ fetchImpl, projectId: "project-1", nextStage: "editing" });
  assert.equal(result.outcome, "failure");
  assert.equal(callCount, 1, "no second request is fired automatically");

  const reverted = moveProjectLocalStage(moved, "project-1", "inquiry");
  assert.deepEqual(reverted, rows, "the moved card's stage reverts to its original column");

  console.log("test 5 (failure revert) passed");
}

// ---------------------------------------------------------------------------
// Test 6 — Keyboard fallback parity (spec §4 test 6): the `<select>` entry point and the drag
// entry point both go through `performBoardMove` — no divergent second mutation path. Asserted
// both by identical request shape and by a source scan of the component confirming both handlers
// call the same helper (there is no separate `<select>`-only fetch call to drift from D1).
// ---------------------------------------------------------------------------
async function test6KeyboardFallbackParity() {
  const capture: Array<{ url: string; stage: string | null }> = [];
  const fetchImpl: BoardFetchImpl = async (url, init) => {
    capture.push({ url, stage: (init.body as FormData).get("stage") as string | null });
    return { ok: true, url: "https://studio.test/projects/project-1" };
  };

  await performBoardMove({ fetchImpl, projectId: "project-1", nextStage: "planning" }); // drag entry point
  await performBoardMove({ fetchImpl, projectId: "project-1", nextStage: "planning" }); // <select> entry point

  assert.deepEqual(capture[0], capture[1], "drag and <select> entry points produce identical request shapes");

  const componentSource = fs.readFileSync(path.join(here, "..", "components", "ProjectBoard.tsx"), "utf8");
  const onDropMatch = componentSource.match(/onDrop=\{[\s\S]*?moveCard\(/);
  const onChangeMatch = componentSource.match(/select[\s\S]*?onChange=\{[\s\S]*?moveCard\(/);
  assert.ok(onDropMatch, "the column onDrop handler calls moveCard");
  assert.ok(onChangeMatch, "the per-card <select> onChange handler calls moveCard");
  const moveCardCallSites = componentSource.match(/void moveCard\(/g) ?? [];
  assert.equal(moveCardCallSites.length, 2, "exactly two call sites (drag + select) delegate to the single moveCard helper");

  console.log("test 6 (keyboard fallback parity) passed");
}

// ---------------------------------------------------------------------------
// Test 10 — Purity guard (spec §4 test 10): project-board.ts imports nothing beyond types (no DB,
// no next/*).
// ---------------------------------------------------------------------------
function test10PurityGuard() {
  const source = fs.readFileSync(path.join(here, "project-board.ts"), "utf8");
  const importLines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("import "));

  assert.equal(importLines.length, 0, "project-board.ts must have no import statements at all");

  console.log("test 10 (purity guard) passed");
}

// ---------------------------------------------------------------------------
// Test 11 — Login-bounce success predicate (rev 2, BLOCKER 1, spec §4 test 11).
// ---------------------------------------------------------------------------
async function test11LoginBounceSuccessPredicate() {
  assert.equal(
    boardMoveOutcome({ ok: true, url: "https://studio.test/admin/login" }, "project-1"),
    "login-bounce",
    "a 200 login page must not read as success even though response.ok is true",
  );
  assert.equal(
    boardMoveOutcome({ ok: true, url: "https://studio.test/projects/project-1" }, "project-1"),
    "success",
  );
  assert.equal(
    boardMoveOutcome({ ok: false, url: "https://studio.test/projects/project-1" }, "project-1"),
    "failure",
    "a real failure that still redirected somewhere sane is 'failure', not 'login-bounce'",
  );

  // Mocked fetch resolving the login-bounce shape end-to-end through performBoardMove.
  const fetchImpl: BoardFetchImpl = async () => ({ ok: true, url: "https://studio.test/admin/login" });
  const result = await performBoardMove({ fetchImpl, projectId: "project-1", nextStage: "planning" });
  assert.equal(result.outcome, "login-bounce", "performBoardMove surfaces the login-bounce outcome, not a silent success");

  const redirectUrl = loginBounceRedirectUrl("/projects?view=board&q=alex");
  assert.equal(redirectUrl, "/admin/login?next=%2Fprojects%3Fview%3Dboard%26q%3Dalex");

  console.log("test 11 (login-bounce success predicate) passed");
}

// ---------------------------------------------------------------------------
// Test 15 — Invalid-stage guard (rev 2, MEDIUM 4, spec §4 test 15).
// ---------------------------------------------------------------------------
function test15InvalidStageGuard() {
  assert.equal(isValidProjectStage("bogus-stage", stageOptions), false);
  assert.equal(isValidProjectStage("inquiry", stageOptions), true);

  const componentSource = fs.readFileSync(path.join(here, "..", "components", "ProjectBoard.tsx"), "utf8");
  const moveCardBody = componentSource.match(/async function moveCard[\s\S]*?\n  \}/)?.[0] ?? "";
  const guardIndex = moveCardBody.indexOf("isValidProjectStage");
  const requestIndex = moveCardBody.indexOf("performBoardMove(");
  assert.ok(guardIndex >= 0 && requestIndex >= 0 && guardIndex < requestIndex, "isValidProjectStage gates the request before performBoardMove is called");

  console.log("test 15 (invalid-stage guard) passed");
}

// ---------------------------------------------------------------------------
// Test 16 — Pending-request lifecycle / abort timeout (rev 2, MINOR 5, spec §4 test 16). A mocked
// fetch that never resolves before a short timeout ⇒ the abort fires ⇒ outcome "failure" with
// timedOut: true (the component reads this as "Couldn't confirm — refresh", not a generic
// failure). Uses a small timeoutMs so the test doesn't actually wait ~15s.
// ---------------------------------------------------------------------------
async function test16PendingLifecycleAbortTimeout() {
  assert.equal(BOARD_MOVE_TIMEOUT_MS, 15000, "production default stays ~15s");

  const neverResolvingFetch: BoardFetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });

  const startedAt = Date.now();
  const result = await performBoardMove({
    fetchImpl: neverResolvingFetch,
    projectId: "project-1",
    nextStage: "planning",
    timeoutMs: 20,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.outcome, "failure");
  assert.equal(result.timedOut, true);
  assert.ok(elapsedMs < 2000, "the abort fires on the configured timeout, not the full ~15s default");

  // Two different projects' moves are independent promises — nothing about performBoardMove
  // serializes them, so a pending move on one card can never block another card's move.
  const fastFetch: BoardFetchImpl = async () => ({ ok: true, url: "https://studio.test/projects/project-2" });
  const [slow, fast] = await Promise.all([
    performBoardMove({ fetchImpl: neverResolvingFetch, projectId: "project-1", nextStage: "planning", timeoutMs: 20 }),
    performBoardMove({ fetchImpl: fastFetch, projectId: "project-2", nextStage: "planning" }),
  ]);
  assert.equal(fast.outcome, "success", "a fast, unrelated move resolves independently of a slow pending move");
  assert.equal(slow.timedOut, true);

  console.log("test 16 (pending-request lifecycle / abort timeout) passed");
}

// ---------------------------------------------------------------------------
// Test 18 — Board membership vs. filter (rev 2, MINOR 8, spec §4 test 18): moving a card to a
// stage outside the active stage filter removes it from the rendered board; a subsequent failed
// request's revert re-adds it in its prior (in-filter) stage.
// ---------------------------------------------------------------------------
function test18BoardMembershipVsFilter() {
  const activeStages = ["inquiry", "planning"];
  const rows = [card("a", "inquiry")];

  const movedOutOfFilter = moveProjectLocalStage(rows, "a", "editing");
  const groupedAfterMove = groupProjectsByStage(movedOutOfFilter, activeStages);
  assert.deepEqual(groupedAfterMove.get("inquiry"), [], "the card left the active-filter board entirely");
  assert.deepEqual(groupedAfterMove.get("planning"), []);
  const allVisibleCards = activeStages.flatMap((stage) => groupedAfterMove.get(stage) ?? []);
  assert.equal(allVisibleCards.some((row) => row.id === "a"), false, "moved-out card is not rendered anywhere on the board");

  // The move's request then fails — revert re-adds it in its prior, in-filter stage.
  const revertedRows = moveProjectLocalStage(movedOutOfFilter, "a", "inquiry");
  const groupedAfterRevert = groupProjectsByStage(revertedRows, activeStages);
  assert.deepEqual(groupedAfterRevert.get("inquiry")?.map((row) => row.id), ["a"]);

  console.log("test 18 (board membership vs. filter) passed");
}

// ---------------------------------------------------------------------------
// Test 13 (companion, pure half) — Dedupe (rev 2, MINOR 7, spec §4 test 13): a synthetic
// duplicate-row array (two rows sharing a `project.id`) collapses to exactly one row, keeping the
// first occurrence's order. The DB-integration half (project-board-index.test.ts) exercises the
// real query wiring; a true duplicate primary-contact row is no longer reproducible against the
// live schema (migration 0034's partial unique index), so this pure test is what actually proves
// the dedupe logic itself is correct.
// ---------------------------------------------------------------------------
function test13DedupeByProjectId() {
  const rows = [
    { project: { id: "project-dup" }, client: { id: "client-1" } },
    { project: { id: "project-other" }, client: { id: "client-2" } },
    { project: { id: "project-dup" }, client: { id: "client-3" } },
  ];

  const deduped = dedupeRowsByProjectId(rows);
  assert.equal(deduped.length, 2, "the double-primary project yields exactly one row");
  assert.deepEqual(deduped.map((row) => row.project.id), ["project-dup", "project-other"]);
  assert.equal(deduped[0].client.id, "client-1", "the first occurrence wins");

  console.log("test 13 (dedupe by project id) passed");
}

// ---------------------------------------------------------------------------
// Test 19 — slim-card leak guard (Fable MEDIUM-3): toProjectBoardCard must pick ONLY the allowed
// fields, dropping any extra project/client column (notes, venue, phone) that would otherwise
// cross the RSC boundary into the client bundle. Asserts the KEY SHAPE, not rendered markup.
// ---------------------------------------------------------------------------
function test19SlimCardLeakGuard() {
  const card = toProjectBoardCard({
    project: { id: "p1", name: "Wedding", stage: "inquiry", notes: "SECRET NOTE", venueName: "SECRET VENUE" } as never,
    client: { id: "c1", firstName: "A", lastName: "B", email: "a@b.example", phone: "SECRET PHONE", instagram: "SECRET" } as never,
    dateLabel: "—",
    budgetLabel: "$0",
    milestoneSummary: null,
  });
  assert.deepEqual(Object.keys(card).sort(), ["budgetLabel", "client", "dateLabel", "id", "milestoneSummary", "name", "stage"]);
  assert.deepEqual(Object.keys(card.client!).sort(), ["email", "firstName", "id", "lastName"]);
  const serialized = JSON.stringify(card);
  for (const secret of ["SECRET NOTE", "SECRET VENUE", "SECRET PHONE"]) {
    assert.ok(!serialized.includes(secret), `no leaked field: ${secret}`);
  }
  console.log("test 19 (slim-card leak guard) passed");
}

// ---------------------------------------------------------------------------
// Test 20 — login-bounce component wiring (Fable MINOR-6): source-scan (the pattern tests 6/15
// use) that ProjectBoard reverts the optimistic move BEFORE navigating on a login-bounce, and
// keys the branch on the "login-bounce" outcome — a regression that navigated without reverting,
// or read success first, would be caught.
// ---------------------------------------------------------------------------
function test20LoginBounceComponentWiring() {
  const source = fs.readFileSync(path.join(here, "..", "components", "ProjectBoard.tsx"), "utf8");
  assert.ok(/outcome === "login-bounce"/.test(source), "board branches on the login-bounce outcome");
  const bounceIdx = source.indexOf('outcome === "login-bounce"');
  const revertIdx = source.indexOf("moveProjectLocalStage(rows, projectId, previousStage)", bounceIdx);
  const assignIdx = source.indexOf("window.location.assign", bounceIdx);
  assert.ok(revertIdx > bounceIdx && assignIdx > revertIdx, "revert happens BEFORE the login navigation");
  console.log("test 20 (login-bounce component wiring) passed");
}

async function main() {
  test1Grouping();
  test2MoveRevertSymmetry();
  test3ShowMoreSlicing();
  await test4StageTransitionCallCorrectness();
  await test5FailureRevert();
  await test6KeyboardFallbackParity();
  test10PurityGuard();
  await test11LoginBounceSuccessPredicate();
  test15InvalidStageGuard();
  await test16PendingLifecycleAbortTimeout();
  test18BoardMembershipVsFilter();
  test13DedupeByProjectId();
  test19SlimCardLeakGuard();
  test20LoginBounceComponentWiring();

  console.log("project-board tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
