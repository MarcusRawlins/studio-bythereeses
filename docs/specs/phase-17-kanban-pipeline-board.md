# Phase 17 — Kanban pipeline board

Status: spec rev 1 (initial — awaiting Fable spec review, see §6 changelog).
Origin: roadmap Tier 3 (`docs/roadmap-competitive-parity.md` §Phase 17). Risk class: LOW —
UI-only; zero new canonical writes (reuses the existing single-project stage mutation verbatim);
no schema change; no new endpoint.

## 0. What the roadmap asked for — and what v1 narrows

Roadmap line: *"Data model + stage-count strip exist; add a visual drag-and-drop lead→booked
board. UI-only, low risk."* The data model and per-stage counts already exist
(`projectStageOptions` in `src/lib/crm.ts` ~13-26; the dashboard stage-count strip,
`src/app/page.tsx` ~99-100, ~248). What's missing is a **board rendering + drag-to-move
interaction** over that same data.

v1 narrowings (deliberate, each reversible by a follow-up CR):
- **One card = one project, one drag = one stage move.** No multi-select drag on the board. Bulk
  moves stay list-view-only via the existing checkbox + "Move" control (`ProjectBulkSelection.tsx`)
  — reproducing bulk-select inside a drag surface is its own interaction-design problem, not needed
  for a v1 "visual pipeline" board.
- **No touch/mobile drag.** The HTML5 Drag and Drop API (the only drag mechanism this repo has —
  no dnd library is installed; see §3) does not fire on touch devices. Every card ships the
  keyboard/no-drag `<select>` fallback (§1, §2) as the *only* way to move a card on mobile/PWA — not
  a degraded second-class path, the primary path there. A touch-drag polyfill is a future CR if
  wanted.
- **Board loads the whole matching result set once, capped at a safety valve** — not the list
  page's server-side `page`/`pageSize` pagination (§1, D3). Per-column display volume is a
  client-side cap + "Show more," not a query concern.
- **Stage semantics unchanged.** The board does not add "won/lost" swimlanes, per-column WIP
  limits, or a new pipeline concept — it renders the existing 7 `projects.stage` values as columns
  in their existing order. Nothing here proposes changing what the stages mean.

## 1. Design decisions (the ones that matter)

**D1 — Two trigger surfaces, one mutation, no new semantics.** Dragging a card to another column
and picking a value from the on-card `<select>` fallback both call the *same* existing canonical
mutation the rest of the app already uses for single-project stage moves:
`POST /api/projects/[id]/stage` (`src/app/api/projects/[id]/stage/route.ts` →
`updateProjectStageFromForm` in `crm.ts` ~2027-2063) — identical `FormData` shape
(`stage=<value>`), identical activity-log write, identical revalidation. This is the exact call
`ProjectRowActions.moveStage` already makes (`src/components/ProjectRowActions.tsx` ~48-71). **No
new mutation function, no new route, no new bulk-drag endpoint.** The existing
`/api/projects/bulk/stage` route stays reserved for the list view's checkbox bulk-move and is not
touched or reused by the board.

**D2 — Board is a second render branch of the existing `/projects` Server Component, not a new
route.** `?view=board` (flag `PROJECTS_BOARD_VIEW === "1"`, read in `projects/page.tsx`) branches
the *existing* page between today's paginated list and the board. Reads go through one new
read-only function in `crm.ts`, `listProjectBoardIndex` (§3) — a plain server function called
directly from the Server Component, exactly how `listProjectIndex` is called today. **This is a
data-fetching function, not an HTTP endpoint** — the task's "zero new endpoints" constraint is about
the mutation surface (satisfied by D1); a new read path inside the existing page is unavoidable and
in scope. Milestone summaries reuse `loadProjectMilestoneSummaries` (Phase 22,
`project-milestones-batch.ts`) completely unchanged, gated on `PROJECT_PROGRESS_TIMELINE`
independently of the board flag. **Flag off ⇒ `/projects` (any `?view=` value) renders byte-identical
to today: `listProjectBoardIndex` is never called, the toggle control never renders, zero added
queries** — same purity guarantee Phase 22 set for its flag.

**D3 — Volume is a client-side cap, not server pagination, because the base query has no D1
in-array to blow up.** `listProjectBoardIndex` reuses the same `projectIndexWhere` /
`projectIndexOrderBy` helpers `listProjectIndex` already uses (`crm.ts` ~239-274) but with no
`.limit()/.offset()` page window — it's a plain filtered `SELECT`, not an `inArray(id, [...])`
lookup, so the D1 100-bound-param cap (`src/lib/db-batch.ts`) that constrains Phase 22's *batched
per-id* fetches doesn't apply to this query at all. It **does** apply, unchanged, to
`loadProjectMilestoneSummaries` when the timeline flag is also on — that helper already chunks
every `inArray` at ≤90 (`chunkedInArrayFetch`), so handing it however many rows the board loaded
"just works," reused as-is. Two separate volume guards, at two different layers:
- **Whole-board safety valve**: `listProjectBoardIndex` caps at `BOARD_MAX_ROWS = 1000` rows
  (`ORDER BY` + `LIMIT`, matching sort). If the active, filtered result set exceeds it, the board
  shows a truncation notice ("Showing the first 1,000 of N — narrow with search/stage filters or
  use List view") rather than silently dropping rows or crashing. This studio is nowhere near that
  scale; it exists so growth doesn't turn into a silent bug.
- **Per-column display cap**: each column renders at most `COLUMN_CARD_CAP = 25` cards with a
  "Show N more" button. All matching rows for that column are already in memory (loaded once by
  D3's whole-board query) — "Show more" is a **local state change only, zero refetch**.

## 2. Column & card model

**Columns**, in this fixed order (reuses `projectStageOptions`, `crm.ts` ~13-26 — no new stage
list): `inquiry → proposal_sent → retainer_paid → planning → editing → delivered → completed`. If
the stage-filter picker (existing `ProjectSearchFilters`, reused unmodified — see §3) has a
non-empty `stages` selection, only the selected stages render as columns; empty selection ⇒ all 7.
This falls out of reusing `projectIndexWhere` unchanged — no new filter logic.

**Card content** (all fields the row already carries today — no new per-project computation added
by the board itself):
- Project name, linking to `/projects/:id` (existing link pattern).
- Client name (or "Needs primary client," existing copy from `ProjectBulkSelection.tsx` ~310).
- Event date label (`formatDate(project.eventDate)`, already computed for the list).
- Value line: **`budgetLabel` (`formatMoney(project.budgetCents)`) always** — the same "Value"
  field the list row shows today, not a new "true outstanding balance" computation (that would
  require a new per-project invoice+payment batch query the flag-off path must not pay for). **When
  `PROJECT_PROGRESS_TIMELINE === "1"`**, the milestone summary line (`doneCount/totalCount` +
  current-label + overdue tint, `ProjectMilestoneBarSummary`) renders in addition, exactly as
  `ProjectBulkSelection.tsx` ~291-299 already renders it. **When the flag is off, the card shows only
  the value line** — graceful, not a placeholder or broken layout.
- Stage `<select>` (the keyboard/no-drag fallback, D1) — always present, always focusable, not
  hidden behind a menu button. Options = `projectStageOptions`; changing it fires the identical
  mutation a drag would.

## 3. Implementation shape

- **`src/lib/crm.ts`** — add `listProjectBoardIndex(input: { q?, stages?, sort? })`: reuses
  `projectIndexWhere` and `projectIndexOrderBy` verbatim, no pagination params, `LIMIT
  BOARD_MAX_ROWS` (1000) as the D3 safety valve, returns `{ rows, filteredCount, truncated }`
  (`truncated = filteredCount > rows.length`). Read-only, no new tables, no new columns.
- **`src/lib/project-board.ts`** (new, pure — no DB import, enforced by test, mirroring
  `project-milestones.ts`'s purity discipline): the board's non-network logic, so drag/revert/cap
  behavior is unit-testable without rendering a DOM or mocking `fetch`:
  - `groupProjectsByStage(rows, stageOrder)` → `Map<stage, rows[]>`.
  - `moveProjectLocalStage(rows, projectId, nextStage)` → new array with that one project's
    `stage` field updated (used both to apply the optimistic move and, called again with the prior
    stage, to revert it on failure).
  - `visibleColumnCards(columnRows, expandedCount, cap)` → the slice to render + whether "Show
    more" should appear.
- **`src/components/ProjectBoard.tsx`** (new, `"use client"`, mirrors `ProjectBulkSelection.tsx`
  as the closest existing pattern — client state + `fetch` to an existing route, no new
  dependency): holds `projects` state (server rows, client-mutable `stage` only),
  `expandedByStage` state, and `pendingProjectId`. Columns are `useMemo`-derived via
  `groupProjectsByStage` every render — reordering a card is just changing its `stage` in state.
  - **Drag**: native HTML5 Drag and Drop (`draggable`, `onDragStart` carries the project id,
    column `onDragOver`/`onDrop`) — no new dependency; the repo has no dnd library today.
  - **On drop or `<select>` change**: optimistic move via `moveProjectLocalStage`, mark
    `pendingProjectId`, `fetch("/api/projects/{id}/stage", { method: "POST", body: formData })` —
    the exact call `ProjectRowActions` makes. **On success: do nothing further** — unlike
    `ProjectRowActions`/`ProjectBulkSelection`, the board must **not** `window.location.reload()`;
    local state already matches the new canonical stage, and a full reload would defeat the point
    of optimistic UI (lost scroll position, columns re-collapse). **On failure (`!response.ok` or a
    thrown network error): revert** that one project's stage via `moveProjectLocalStage` back to
    its prior value and show an inline error on that card only — no other card's state changes.
  - **Show more**: `expandedByStage` state bump per column, no fetch.
- **`src/app/projects/page.tsx`**: read `view` query param + `PROJECTS_BOARD_VIEW` flag. Flag off
  ⇒ `view` is ignored entirely (today's branch only). Flag on ⇒ a List/Board toggle (plain
  `<Link>`s preserving `q`/`stages`/`sort`, no client component needed for the toggle itself) and,
  in board mode: call `listProjectBoardIndex` instead of the paginated `listProjectIndex`, skip
  `pageSize`/`ProjectsPagination`, and — when `PROJECT_PROGRESS_TIMELINE` is also on — call the
  *existing* `loadProjectMilestoneSummaries` over the board's rows unchanged.
- **`src/components/ProjectSearchFilters.tsx`**: thread the current `view` through as an
  additional hidden field on both its forms, so submitting a search/filter while on the board keeps
  you on the board. This is the one existing file the board touches beyond addition of new files.
- **Flags**: `PROJECTS_BOARD_VIEW === "1"` (this phase) and `PROJECT_PROGRESS_TIMELINE === "1"`
  (Phase 22, reused as-is) — independent, both read as strict `"1"` string checks in the component
  body, matching the repo's existing flag convention (`process.env.X === "1"`, e.g.
  `src/app/system-status/page.tsx`, `src/lib/scheduler.ts`).
- **No** schema change, no migration, no new endpoint, no new mutation function, no new dependency,
  no agent/MCP surface.

## 4. Tests

`project-board.ts` is pure (like `project-milestones.ts`) so most of this is DB-free unit testing;
the route-reuse and flag-off claims need the existing DB-fixture + `renderToStaticMarkup` pattern
(`src/app/projects/page.test.tsx`).

1. **Grouping**: `groupProjectsByStage` buckets rows into exactly one column per stage, preserving
   within-column order; a stage with zero matching rows produces an empty (not missing) bucket
   when that stage is in the requested column list.
2. **Optimistic move + revert are symmetric**: `moveProjectLocalStage(rows, id, "editing")` then
   `moveProjectLocalStage(result, id, originalStage)` round-trips to the original array (modulo the
   single field) — this is the exact operation pair the component calls on drop-then-failure.
3. **Show-more slicing**: `visibleColumnCards` returns exactly `cap` rows + `showMore: true` when
   `columnRows.length > cap` and `expandedCount` hasn't been raised; raising `expandedCount` past
   `columnRows.length` returns all rows + `showMore: false`.
4. **Stage-transition call correctness (drag)**: with `fetch` mocked, dropping a card issues exactly
   one `POST` to `/api/projects/{id}/stage` with a `FormData` body whose `stage` field is the target
   column's value — same assertion shape as `route.test.ts`'s existing coverage, just from the
   client side.
5. **Failure revert**: mocked `fetch` resolving `{ ok: false }` ⇒ the moved card's stage reverts to
   its original column and only that card shows an error; no second request is fired automatically.
6. **Keyboard fallback parity**: changing the per-card `<select>` fires the identical request shape
   as #4 — both entry points go through the same helper, so there is no divergent second mutation
   path to drift from D1.
7. **`listProjectBoardIndex` filter/order parity**: given the same `q`/`stages`/`sort` input, its
   unpaginated row set equals the union of every page `listProjectIndex` would return for that same
   filter (i.e., it reuses the same `where`/`orderBy`, just without the window) — proves it isn't a
   second, drifting filter implementation.
8. **Flag-off purity**: `PROJECTS_BOARD_VIEW` unset ⇒ `/projects?view=board` renders identical
   markup to `/projects` (no board container, no toggle, `listProjectBoardIndex` never invoked —
   spy/mock assertion, mirroring Phase 22's flag-off test).
9. **Milestone graceful-off**: a board card with `milestoneSummary` absent (timeline flag off)
   renders the value line only — no broken layout, no thrown error (this is a straight reuse of
   Phase 22's own rendering guard, just asserted from the board's markup).
10. **Purity guard**: `project-board.ts` imports nothing beyond types (no DB, no `next/*`).

Gate: `npm run lint` exit 0; `npm run build` exit 0; `npm test` all pass.

## 5. Rollout

Dark behind `PROJECTS_BOARD_VIEW`. Enable = set the var; rollback = unset — no migration, no
deploy-ordering constraint, independent of `PROJECT_PROGRESS_TIMELINE`. Future CRs (all explicitly
out of v1, §0): touch-drag support, multi-select drag/bulk board moves, per-column WIP limits or
won/lost swimlanes, server-persisted column collapse/expand state.

## 6. Changelog

### Rev 1 (initial spec) — 2026-07-07
First draft, not yet reviewed. Awaiting Fable adversarial spec review before build; findings will
be folded in as Rev 2 here, in the same format as `phase-22-project-progress-timeline.md` §6.
