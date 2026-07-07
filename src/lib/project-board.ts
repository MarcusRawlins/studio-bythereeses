// Phase 17 — kanban pipeline board (dark behind PROJECTS_BOARD_VIEW), spec rev 2
// (docs/specs/phase-17-kanban-pipeline-board.md).
//
// PURE module: the board's non-network-shaped logic (grouping, optimistic move/revert, show-more
// slicing, the client-side stage-membership guard, and the success/login-bounce/failure
// predicate over a fetch Response shape) plus a small dependency-injected move helper that talks
// to `fetch`/`AbortController`/`FormData` via the ambient globals only. NO import statements at
// all — no `@/db`, no `drizzle-orm`, no `next/*` — so this stays unit-testable without a database
// or a DOM, mirroring `project-milestones.ts`'s purity discipline (see the purity-guard test in
// `project-board.test.ts`, spec §4 test 10).
//
// D1 (spec §1): dragging a card and picking the on-card `<select>` fallback both end up calling
// `performBoardMove` below, which POSTs the identical `FormData` shape (`stage=<value>`) to the
// existing `/api/projects/[id]/stage` route `ProjectRowActions.moveStage` already calls — no new
// mutation, no new endpoint.

export const BOARD_MAX_ROWS = 300;
export const COLUMN_CARD_CAP = 25;
export const BOARD_MOVE_TIMEOUT_MS = 15000;

export type ProjectStageOption = {
  value: string;
  label: string;
};

export type ProjectBoardCardClient = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
} | null;

// Mirrors `ProjectBulkSelection.tsx`'s local `ProjectMilestoneBarSummary` shape (Phase 22) —
// optional/absent when `PROJECT_PROGRESS_TIMELINE` is off, so a board card renders the value line
// only, gracefully, with no broken layout (spec §4 test 9).
export type ProjectMilestoneSummaryValue = {
  currentLabel: string | null;
  doneCount: number;
  hasOverdue: boolean;
  totalCount: number;
};

export type ProjectBoardCard = {
  id: string;
  name: string;
  stage: string;
  dateLabel: string;
  budgetLabel: string;
  client: ProjectBoardCardClient;
  milestoneSummary?: ProjectMilestoneSummaryValue | null;
};

// Fable MEDIUM-3: the slim-card mapper, EXPLICIT field-picking so no extra project/client column
// (notes, venueName, phone, …) crosses the RSC boundary into the client bundle. Pure and
// import-free (labels are pre-formatted by the caller) so the leak guard can assert the exact key
// shape directly — the old test only greppedrendered markup, which a whole-row leak would pass.
export function toProjectBoardCard(input: {
  project: { id: string; name: string; stage: string };
  client: { id: string; firstName: string | null; lastName: string | null; email: string | null } | null;
  dateLabel: string;
  budgetLabel: string;
  milestoneSummary?: ProjectMilestoneSummaryValue | null;
}): ProjectBoardCard {
  return {
    id: input.project.id,
    name: input.project.name,
    stage: input.project.stage,
    dateLabel: input.dateLabel,
    budgetLabel: input.budgetLabel,
    client: input.client
      ? { id: input.client.id, firstName: input.client.firstName, lastName: input.client.lastName, email: input.client.email }
      : null,
    milestoneSummary: input.milestoneSummary ?? null,
  };
}

/**
 * Buckets `rows` into one array per stage in `stageOrder`. A stage present in `stageOrder` with
 * zero matching rows still produces an empty (not missing) bucket. A row whose stage is NOT in
 * `stageOrder` (e.g. a project moved to a stage hidden by the active board filter, spec §2 MINOR
 * 8) is simply not placed in any bucket — this is what makes "moving a card to a filter-hidden
 * stage removes it from the board" fall out of grouping alone, with no separate visibility flag.
 */
export function groupProjectsByStage<TCard extends { stage: string }>(
  rows: TCard[],
  stageOrder: string[],
): Map<string, TCard[]> {
  const grouped = new Map<string, TCard[]>();
  for (const stage of stageOrder) {
    grouped.set(stage, []);
  }
  for (const row of rows) {
    const bucket = grouped.get(row.stage);
    if (!bucket) continue;
    bucket.push(row);
  }
  return grouped;
}

/**
 * Returns a new array with the single matching project's `stage` field updated. Used both to
 * apply the optimistic move (`moveProjectLocalStage(rows, id, nextStage)`) and, called again with
 * the prior stage, to revert it on failure (`moveProjectLocalStage(result, id, previousStage)`) —
 * the exact operation pair the board component calls on drop-then-failure (spec §4 test 2).
 */
export function moveProjectLocalStage<TCard extends { id: string; stage: string }>(
  rows: TCard[],
  projectId: string,
  nextStage: string,
): TCard[] {
  return rows.map((row) => (row.id === projectId ? { ...row, stage: nextStage } : row));
}

export type VisibleColumnCards<TCard> = {
  visible: TCard[];
  showMore: boolean;
};

/**
 * The client-side-cap slice for one column: `cap` rows unless `expandedCount` has been raised
 * past it (a local state change only, zero refetch — every matching row for the column is already
 * in memory from the whole-board query, spec §1 D3).
 */
export function visibleColumnCards<TCard>(
  columnRows: TCard[],
  expandedCount: number,
  cap: number = COLUMN_CARD_CAP,
): VisibleColumnCards<TCard> {
  const limit = Math.max(cap, expandedCount);
  const visible = columnRows.slice(0, limit);
  return { visible, showMore: columnRows.length > visible.length };
}

/**
 * The server never rejects an invalid stage — `projectStageValue` (`crm.ts` ~174-178) silently
 * coerces any unrecognized value to `"inquiry"` — so this client-side membership check (rev 2,
 * MEDIUM 4) is the only place an out-of-catalog drop/select target can be caught. Both entry
 * points call this BEFORE firing the optimistic move or the request.
 */
export function isValidProjectStage(stage: string, stageOptions: ProjectStageOption[]): boolean {
  return stageOptions.some((option) => option.value === stage);
}

/**
 * The same seen-`project.id` de-duplication `listProjects` already applies (`crm.ts` ~231-236,
 * rev 2 MINOR 7) — extracted here as a pure, DB-free helper so `listProjectBoardIndex` (`crm.ts`)
 * can reuse it AND it stays directly unit-testable with a synthetic duplicate-row array (a real
 * duplicate primary-contact row is no longer reproducible against the live schema — migration
 * `0034_unique_project_primary_contact.sql` added a partial `UNIQUE(project_id) WHERE
 * is_primary_contact = 1` index — so this guard is now a defense-in-depth belt-and-suspenders
 * check rather than a reachable-today bug, but the spec calls for it unconditionally).
 */
export function dedupeRowsByProjectId<TRow extends { project: { id: string } }>(rows: TRow[]): TRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.project.id)) return false;
    seen.add(row.project.id);
    return true;
  });
}

export type BoardMoveOutcome = "success" | "login-bounce" | "failure";

export type BoardMoveResponseShape = {
  ok: boolean;
  url: string;
};

/**
 * The rev-2 BLOCKER-1 fix: `response.ok` is NOT the success signal behind this proxy. The stage
 * route always 303s (`stage/route.ts:16`); `fetch` follows redirects, so an expired admin session
 * 303s the POST to `/admin/login` (a 200 HTML page) and `response.ok` reads `true` on a move that
 * never touched the database. This predicate is pure and URL-string-driven (no real
 * `fetch`/`Response` needed) so it's directly unit-testable:
 *   - `"login-bounce"` when the final URL's path is `/admin/login`, REGARDLESS of `response.ok`
 *     (checked first — a 200 login page still has `ok: true`, and that must not read as success).
 *   - `"success"` only when `response.ok` AND the final URL's path is `/projects/<projectId>`.
 *   - `"failure"` otherwise (includes a real failure that still redirected somewhere sane, e.g.
 *     `{ ok: false, url: ".../projects/:id" }`).
 */
export function boardMoveOutcome(response: BoardMoveResponseShape, projectId: string): BoardMoveOutcome {
  let pathname: string;
  try {
    pathname = new URL(response.url).pathname;
  } catch {
    return "failure";
  }

  if (pathname === "/admin/login") return "login-bounce";
  if (response.ok && pathname === `/projects/${projectId}`) return "success";
  return "failure";
}

/**
 * The login-bounce hard-navigate target, preserving `next` back to the current board URL —
 * matching the proxy's own `?next=` bounce convention (`pages-proxy/_worker.js:560`,
 * `/admin/login?next=${encodeURIComponent(pathname + search)}`).
 */
export function loginBounceRedirectUrl(currentPathAndSearch: string): string {
  return `/admin/login?next=${encodeURIComponent(currentPathAndSearch)}`;
}

export type BoardMoveResult = {
  outcome: BoardMoveOutcome;
  timedOut: boolean;
};

// Structural, not the DOM lib's `typeof fetch`, so this file stays free of any type-only coupling
// too — real `fetch`'s `Promise<Response>` is assignable here since `Response` carries `ok`/`url`
// among its other fields (return-type covariance), and real `fetch`'s wider `input`/`init` params
// accept a caller that only ever passes this narrower shape (parameter contravariance).
export type BoardFetchImpl = (
  input: string,
  init: { method: "POST"; body: FormData; signal: AbortSignal },
) => Promise<BoardMoveResponseShape>;

/**
 * Performs one board stage move: builds the identical `FormData` shape (`stage=<value>`)
 * `ProjectRowActions.moveStage` already posts to `/api/projects/{id}/stage`, races it against a
 * ~15s `AbortController` timeout (rev 2, MINOR 5, mirroring `QuickFind.tsx`'s existing
 * `AbortController` pattern), and evaluates the response via `boardMoveOutcome`. `fetchImpl` is
 * dependency-injected so this is testable with a mocked fetch, including a never-resolving mock
 * that only rejects on abort — no real 15s wait needed in tests (pass a small `timeoutMs`).
 */
export async function performBoardMove({
  fetchImpl,
  projectId,
  nextStage,
  timeoutMs = BOARD_MOVE_TIMEOUT_MS,
}: {
  fetchImpl: BoardFetchImpl;
  projectId: string;
  nextStage: string;
  timeoutMs?: number;
}): Promise<BoardMoveResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const formData = new FormData();
  formData.set("stage", nextStage);

  try {
    const response = await fetchImpl(`/api/projects/${projectId}/stage`, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
    return { outcome: boardMoveOutcome(response, projectId), timedOut: false };
  } catch {
    return { outcome: "failure", timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timeout);
  }
}
