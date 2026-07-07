# Phase 17 — Kanban pipeline board

Status: spec rev 2 (build-ready — Fable spec review findings folded in, see §6 changelog).
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

**Success predicate is NOT `response.ok` (rev 2, BLOCKER 1).** The stage route always
succeeds via a **303 redirect** (`src/app/api/projects/[id]/stage/route.ts:16`,
`NextResponse.redirect(new URL(`/projects/${id}`, request.url), 303)`), and `fetch` transparently
follows redirects — so `response.ok` reflects the *final* hop, not the mutation. Two failure
modes this hides, both real behind this proxy (`pages-proxy/_worker.js` documents the identical
trap in its own comments at ~231, ~239, ~247, for the inbound-email/Twilio webhooks): an
**expired admin session** 303s the POST to `/admin/login`, which is a `200` HTML page — `fetch`
follows it, lands on a 200, `response.ok` is `true`, and the board reports success on a move that
never touched the database (silent canonical divergence — the card looks moved everywhere except
the database). Conversely, a **successful** move that 303s to `/projects/:id` and that page then
throws (500) reads `response.ok === false` — a false revert on a write that actually committed.
**FIX**: the success predicate is `response.ok && new URL(response.url).pathname ===
"/projects/" + id` (`response.url` is the *final*, post-redirect URL `fetch` exposes). When the
final URL's path is `/admin/login` instead, treat it as a **distinct** outcome from an ordinary
failure: revert the optimistic move (identical to any other failure) **and** hard-navigate the
whole tab to `/admin/login` (`window.location.assign`, not a client-state error banner — the
session is gone, no further board interaction is trustworthy) preserving `next` back to the
current `/projects?view=board...` URL, matching the proxy's own `?next=` bounce convention
(`pages-proxy/_worker.js:560`). A mocked-`fetch` test asserts this: `fetch` resolving
`{ ok: true, url: ".../admin/login" }` reverts the card AND triggers the login hard-navigate, not
a silent false-positive success. The followed-redirect full-page GET on every move (the request
that would return `/admin/login`'s HTML) is an accepted v1 cost — no HEAD/no-redirect variant of
the route is introduced; it stays a plain `fetch` with default redirect-following.

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
- **Whole-board safety valve**: `listProjectBoardIndex` caps at `BOARD_MAX_ROWS = 300` rows (rev 2,
  MEDIUM 3 — lowered from the original 1,000; rather than separately pricing the 1,000-row worst
  case for RSC payload size and per-move batch amplification, 300 is simply picked, which keeps
  both bounded without a second tier of justification) (`ORDER BY` + `LIMIT`, matching sort). The
  cap applies to whichever stage set is active — the rev-2 default in-flight scope (§2, MAJOR 2)
  ordinarily, or all 7 stages (including the unbounded `completed`) only once a user explicitly
  opts into `completed` via the stage filter. If the active, filtered result set exceeds the cap,
  the board shows a truncation notice ("Showing the first 300 of N — narrow with search/stage
  filters or use List view") rather than silently dropping rows or crashing. This studio is
  nowhere near that scale; it exists so growth doesn't turn into a silent bug.
- **Per-column display cap**: each column renders at most `COLUMN_CARD_CAP = 25` cards with a
  "Show N more" button. All matching rows for that column are already in memory (loaded once by
  D3's whole-board query) — "Show more" is a **local state change only, zero refetch**.

## 2. Column & card model

**Columns**, in this fixed order (reuses `projectStageOptions`, `crm.ts` ~13-26 — no new stage
list): `inquiry → proposal_sent → retainer_paid → planning → editing → delivered → completed`.

**Default scope excludes `completed` (rev 2, MAJOR 2).** `completed`-stage projects stay
`status: "active"` forever (`crm.ts` ~260 — the board's active-only filter never excludes them by
itself), and the board's default sort (`coalesce(eventDate, '9999-12-31') asc`, `crm.ts` ~273)
means a completed wedding with no future event date sorts alongside (or ahead of, once the date's
past) undated new inquiries — so an unbounded, always-rendered `completed` column plus the
`BOARD_MAX_ROWS` truncation cap (§3, D3) would silently truncate the **newest inquiries**, not
stale completed cards, once the studio has enough history. **FIX**: the board's default column
set (empty/absent `stages` query param) is the **6 in-flight stages**, `inquiry` through
`delivered` — `completed` is omitted by default. `completed` renders as a column only when the
stage-filter picker (existing `ProjectSearchFilters`, reused — see §3 for its one rev-2 addition)
has it **explicitly** selected. This still falls out of reusing `projectIndexWhere` unchanged — no
new filter logic, just a non-empty default `stages` value the board's Server Component passes to
`listProjectBoardIndex` when the `stages` query param itself is absent. The truncation notice (§3,
D3) is restated accordingly: it now describes the active (default 6-stage, or user-widened)
scope, not "all projects."

**Duplicate rows (rev 2, MINOR 7).** `listProjectBoardIndex`'s underlying join is
project-to-participant, one row per participant — the same shape `listProjects` already guards
with a seen-`project.id` filter (`crm.ts` ~231-236). Without the identical guard, a project with
more than one primary-flagged participant row would render as duplicate cards on the board (not
just a cosmetic dupe — it also inflates the per-column count past the true row count and can flip
`truncated` on when it shouldn't be). **FIX**: `listProjectBoardIndex` applies the same
seen-`project.id` de-duplication before returning rows, so `filteredCount`/`truncated` and the
rendered card count all agree with the true distinct-project count.

**Board membership vs. filters (rev 2, MINOR 8, stated explicitly).** Two behaviors are correct
and intentional, not bugs: (1) dragging or `<select>`-ing a card to a stage that the *active* stage
filter does not include (e.g., the user has narrowed to a subset of stages and moves a card to one
outside it) makes that card disappear from the board — it moved successfully, it's just no longer
in the filtered/rendered set; this is the same "moved out of view" behavior list-view stage filters
already have. (2) if that same move's request then fails, the optimistic-move revert (§3) still
fires and the card reappears on the board in its prior (in-filter) stage, exactly as any other
failed move reverts — reverting doesn't special-case "the card had already left the visible set."

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
  BOARD_MAX_ROWS` (300 — rev 2, MEDIUM 3, down from 1000) as the D3 safety valve. **Rev 2, MINOR
  7**: applies the same seen-`project.id` de-duplication `listProjects` already does (`crm.ts`
  ~231-236) before computing `filteredCount`/`truncated`, so a project with more than one primary
  participant row can't yield duplicate cards or a wrong truncated flag. **Rev 2, MAJOR 2**: when
  the caller's `stages` input is empty/absent, defaults to the 6 in-flight stages (`inquiry`
  through `delivered`) rather than "no stage filter" — `completed` requires an explicit `stages`
  selection that includes it, same as any other stage. Returns `{ rows, filteredCount, truncated
  }` (`truncated = filteredCount > rows.length`). Read-only, no new tables, no new columns.
- **`src/lib/project-board.ts`** (new, pure — no DB import, enforced by test, mirroring
  `project-milestones.ts`'s purity discipline): the board's non-network logic, so drag/revert/cap
  behavior is unit-testable without rendering a DOM or mocking `fetch`:
  - `groupProjectsByStage(rows, stageOrder)` → `Map<stage, rows[]>`.
  - `moveProjectLocalStage(rows, projectId, nextStage)` → new array with that one project's
    `stage` field updated (used both to apply the optimistic move and, called again with the prior
    stage, to revert it on failure).
  - `visibleColumnCards(columnRows, expandedCount, cap)` → the slice to render + whether "Show
    more" should appear.
  - `isValidProjectStage(stage, stageOptions)` (rev 2, MEDIUM 4) → `boolean` — a plain
    `stageOptions.some(...)` membership check. Both drop and `<select>`-change call this **before**
    firing the optimistic move or the request; an out-of-catalog target is rejected client-side
    with no request sent. This exists because the server does not: `projectStageValue` (`crm.ts`
    ~174-178) silently **coerces** any unrecognized value to `"inquiry"` rather than rejecting it,
    so a client-side "revert on invalid stage" can never fire (there is nothing for it to revert
    from — the request would "succeed" into the wrong stage). The client guard is the only place
    this can be caught; the coercion itself is unchanged, out of scope, and noted here for anyone
    who later wires new stage sources into the board.
  - `boardMoveOutcome(response: { ok: boolean; url: string }, projectId: string): "success" |
    "login-bounce" | "failure"` (rev 2, BLOCKER 1) — the pure success predicate: `"success"` only
    when `response.ok && new URL(response.url).pathname === "/projects/" + projectId`;
    `"login-bounce"` when the final URL's path is `/admin/login` (regardless of `response.ok`,
    which is `true` for that 200 login page — see D1); `"failure"` otherwise. Pure and
    URL-string-driven so it's unit-testable without a real `fetch`/`Response`.
- **`src/components/ProjectBoard.tsx`** (new, `"use client"`, mirrors `ProjectBulkSelection.tsx`
  as the closest existing pattern — client state + `fetch` to an existing route, no new
  dependency): holds `projects` state (server rows, client-mutable `stage` only, **received
  pre-slimmed from the server component — see the `page.tsx` bullet below, rev 2 MEDIUM 3**),
  `expandedByStage` state, and **`pendingProjectIds` (rev 2, MINOR 5) — a `Set<string>` / map
  keyed by project id, not a single scalar `pendingProjectId`**, so one card's in-flight move does
  not block drag/`<select>` interaction on every other card. Columns are `useMemo`-derived via
  `groupProjectsByStage` every render — reordering a card is just changing its `stage` in state.
  - **Drag**: native HTML5 Drag and Drop (`draggable`, `onDragStart` carries the project id,
    column `onDragOver`/`onDrop`) — no new dependency; the repo has no dnd library today.
  - **On drop or `<select>` change**: first, `isValidProjectStage` (rev 2, MEDIUM 4) — reject
    silently (no request, no state change) if the target isn't in `projectStageOptions`. Otherwise:
    optimistic move via `moveProjectLocalStage`, mark that project id pending in
    `pendingProjectIds`, `fetch("/api/projects/{id}/stage", { method: "POST", body: formData,
    signal })` — the exact call `ProjectRowActions` makes, plus **an `AbortController` with a
    ~15s timeout (rev 2, MINOR 5)**, mirroring the existing `AbortController` + `setTimeout`
    pattern in `src/components/QuickFind.tsx`. Evaluate the response via `boardMoveOutcome`
    (rev 2, BLOCKER 1):
    - `"success"`: do nothing further — unlike `ProjectRowActions`/`ProjectBulkSelection`, the
      board must **not** `window.location.reload()`; local state already matches the new canonical
      stage, and a full reload would defeat the point of optimistic UI (lost scroll position,
      columns re-collapse).
    - `"login-bounce"`: revert that one project's stage via `moveProjectLocalStage`, **and**
      hard-navigate the tab to `/admin/login` (preserving `next` back to the current board URL) —
      the session is gone; no further optimistic board state can be trusted (D1).
    - `"failure"` (includes `!response.ok`, a thrown network error, **and the abort timeout**):
      revert that one project's stage via `moveProjectLocalStage` back to its prior value and show
      an inline error on that card only — no other card's state changes. **On the abort-timeout
      path specifically (rev 2, MINOR 5)**, the inline copy reads "Couldn't confirm — refresh"
      rather than a generic failure message, since the server may have committed the move despite
      the client giving up waiting; it does not claim the move definitely failed.
    - In all three outcomes, clear that project id from `pendingProjectIds` in a `finally`.
  - **Show more**: `expandedByStage` state bump per column, no fetch.
- **`src/app/projects/page.tsx`**: read `view` query param + `PROJECTS_BOARD_VIEW` flag. Flag off
  ⇒ `view` is ignored entirely (today's branch only). Flag on ⇒ a List/Board toggle (plain
  `<Link>`s preserving `q`/`stages`/`sort`, no client component needed for the toggle itself) and,
  in board mode: call `listProjectBoardIndex` instead of the paginated `listProjectIndex` (with the
  rev-2 default in-flight `stages` scope, MAJOR 2), skip `pageSize`/`ProjectsPagination`, and —
  when `PROJECT_PROGRESS_TIMELINE` is also on — call the *existing* `loadProjectMilestoneSummaries`
  over the board's rows unchanged. **Rev 2, MEDIUM 3**: before handing rows to `<ProjectBoard>`,
  map each row down to the slim card shape (`id`, `name`, `stage`, `dateLabel`, `budgetLabel`,
  client `{ id, firstName, lastName, email }` or `null`, `milestoneSummary`) exactly as this same
  file already does for `<ProjectBulkSelection>` (`projects/page.tsx` ~187-202) — the full DB row
  (every project/client column) must not cross the RSC boundary into the client bundle a second
  time; the board reuses the identical mapping shape, not a new one.
- **`src/components/ProjectSearchFilters.tsx`**: thread the current `view` through as an
  additional hidden field on both its `<form>`s, so submitting a search/filter while on the board
  keeps you on the board. **Rev 2, MINOR 6**: the "Clear filters" control is a plain `<Link>`
  (`ProjectSearchFilters.tsx:136`), not one of the two forms, and today drops every param including
  `view` — add `view` to that link's target query string too (when present) so clearing filters
  from the board returns to an empty-filter **board**, not a silent bounce to the list. The new
  `view` prop is **optional** on this component; when the board flag is off, `view` is never passed
  and nothing about the component's rendered markup changes — byte-identical to today, matching
  D2's flag-off purity guarantee. This remains the one existing file the board touches beyond
  addition of new files.
- **Flags**: `PROJECTS_BOARD_VIEW === "1"` (this phase) and `PROJECT_PROGRESS_TIMELINE === "1"`
  (Phase 22, reused as-is) — independent, both read as strict `"1"` string checks in the component
  body, matching the repo's existing flag convention (`process.env.X === "1"`, e.g.
  `src/app/system-status/page.tsx`, `src/lib/scheduler.ts`).
- **No** schema change, no migration, no new endpoint, no new mutation function, no new dependency,
  no agent/MCP surface. (Rev 2 confirms every finding folded in above is satisfiable within these
  same hard scope guarantees — none required a new endpoint, table, column, or dependency.)

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
5. **Failure revert**: mocked `fetch` resolving `{ ok: false, url: ".../projects/:id" }` ⇒ the
   moved card's stage reverts to its original column and only that card shows an error; no second
   request is fired automatically.
6. **Keyboard fallback parity**: changing the per-card `<select>` fires the identical request shape
   as #4 — both entry points go through the same helper, so there is no divergent second mutation
   path to drift from D1.
7. **`listProjectBoardIndex` filter/order parity**: given the same `q`/`stages`/`sort` input, its
   unpaginated row set equals the union of every page `listProjectIndex` would return for that same
   filter (i.e., it reuses the same `where`/`orderBy`, just without the window) — proves it isn't a
   second, drifting filter implementation.
8. **Flag-off purity**: `PROJECTS_BOARD_VIEW` unset ⇒ `/projects?view=board` renders identical
   markup to `/projects` (no board container, no toggle, `listProjectBoardIndex` never invoked —
   spy/mock assertion, mirroring Phase 22's flag-off test). Includes `ProjectSearchFilters` with no
   `view` prop passed ⇒ markup identical to today (rev 2, MINOR 6).
9. **Milestone graceful-off**: a board card with `milestoneSummary` absent (timeline flag off)
   renders the value line only — no broken layout, no thrown error (this is a straight reuse of
   Phase 22's own rendering guard, just asserted from the board's markup).
10. **Purity guard**: `project-board.ts` imports nothing beyond types (no DB, no `next/*`).
11. **Login-bounce success predicate (rev 2, BLOCKER 1)**: `boardMoveOutcome({ ok: true, url:
    ".../admin/login" }, projectId)` returns `"login-bounce"`, not `"success"` — a mocked `fetch`
    resolving that shape reverts the moved card **and** triggers the login hard-navigate (asserted
    via a mocked `window.location.assign`), it does not silently report success. Conversely,
    `boardMoveOutcome({ ok: true, url: ".../projects/:id" }, projectId)` returns `"success"`, and
    `boardMoveOutcome({ ok: false, url: ".../projects/:id" }, projectId)` (a real failure that
    still redirected somewhere sane) returns `"failure"`, not `"login-bounce"`.
12. **Default in-flight scope (rev 2, MAJOR 2)**: `listProjectBoardIndex({})` (no `stages` input)
    returns only rows in the 6 in-flight stages — a fixture row with `stage: "completed"` is
    excluded; passing `stages: ["completed"]` explicitly includes it. The truncation notice copy
    reflects the active (default or widened) scope, not "all projects."
13. **Dedupe (rev 2, MINOR 7)**: a project fixture with two primary-flagged participant rows
    produces exactly one card in `listProjectBoardIndex`'s output, and `filteredCount`/`truncated`
    are computed off the de-duplicated count.
14. **Slim card shape (rev 2, MEDIUM 3)**: the props passed from `projects/page.tsx` to
    `<ProjectBoard>` contain only `id`, `name`, `stage`, `dateLabel`, `budgetLabel`, client
    `{id, firstName, lastName, email}`/`null`, and `milestoneSummary` — no other project/client
    column leaks into the client-component boundary (assert via the same shape-check pattern used
    for `<ProjectBulkSelection>`'s existing mapping).
15. **Invalid-stage guard (rev 2, MEDIUM 4)**: `isValidProjectStage("bogus-stage",
    projectStageOptions)` is `false`; simulating a drop/`<select>`-change with a target outside
    `projectStageOptions` fires **no** request and leaves board state unchanged — proving the
    client, not the coercing server (`crm.ts` ~174-178), is what gates this.
16. **Pending-request lifecycle (rev 2, MINOR 5)**: with one card's move in flight (pending),
    every other card remains draggable/selectable — `pendingProjectIds` gates only the pending
    project's own card, not a scalar that disables the whole board. A mocked `fetch` that never
    resolves before the ~15s `AbortController` timeout fires ⇒ the card reverts with the copy
    "Couldn't confirm — refresh" (not a generic failure message), and the abort is treated as
    `"failure"` in `boardMoveOutcome`'s terms, not silently swallowed.
17. **Clear-filters preserves view (rev 2, MINOR 6)**: on the board (`?view=board&...`), the
    "Clear filters" link's target includes `view=board`; on the list (no `view`), its target
    excludes `view` entirely (unchanged today behavior) — proves the added param is conditional,
    not a regression on the flag-off/list path.
18. **Board membership vs. filter (rev 2, MINOR 8)**: moving a card to a stage outside the active
    stage filter removes it from the rendered board (not an error state); if that request then
    fails, the revert re-adds the card to the board in its prior (in-filter) stage.

Gate: `npm run lint` exit 0; `npm run build` exit 0; `npm test` all pass.

## 5. Rollout

Dark behind `PROJECTS_BOARD_VIEW`. Enable = set the var; rollback = unset — no migration, no
deploy-ordering constraint, independent of `PROJECT_PROGRESS_TIMELINE`. Future CRs (all explicitly
out of v1, §0): touch-drag support, multi-select drag/bulk board moves, per-column WIP limits or
won/lost swimlanes, server-persisted column collapse/expand state.

## 6. Changelog

### Rev 2 (Fable spec review) — 2026-07-07

**Verdict: APPROVE WITH CHANGES.** All eight findings below were verified against the cited code
before being folded in (route redirect behavior, `crm.ts` filter/sort/coercion, the
`ProjectSearchFilters` "Clear filters" link, and the `projects/page.tsx` slim-mapping precedent).
None required loosening the rev-1 hard scope guarantees (§3) — no new endpoint, table, column, or
dependency was needed for any fix.

| # | Severity | Finding | Fix (this rev) |
|---|---|---|---|
| 1 | BLOCKER | `!response.ok` is the wrong success signal behind this proxy: the stage route always 303s (`stage/route.ts:16`); an expired session 303s to `/admin/login` (200 HTML) and `fetch` follows it, so `ok:true` on a move that never happened; conversely a real move whose redirect target 500s reads `ok:false` → false revert. Same trap the proxy's own comments (`pages-proxy/_worker.js` ~231/239/247) document for other endpoints. | New pure predicate `boardMoveOutcome` (§3, `project-board.ts`): `"success"` only when `response.ok && new URL(response.url).pathname === "/projects/" + id`; a final URL of `/admin/login` is its own `"login-bounce"` outcome → revert + hard-navigate to login (preserving `next`), distinct from ordinary `"failure"`. Mocked login-bounce test added (§4 #11). Followed-redirect full GET stays an accepted v1 cost. |
| 2 | MAJOR | The `completed` column is unbounded — `completed`-stage projects stay `status:"active"` forever (`crm.ts` ~260) — and the default sort (`coalesce(eventDate,'9999-12-31') asc`, `crm.ts` ~273) means row-limit truncation would drop the **newest inquiries**, not stale completed cards. | Board defaults to the 6 in-flight stages (`inquiry`→`delivered`); `completed` renders only when explicitly selected via the existing stage filter (§2, §3 `listProjectBoardIndex`). Truncation notice restated to describe the active (default-or-widened) scope. Test added (§4 #12). |
| 3 | MEDIUM | RSC payload + per-move batch amplification: the board was passing full DB rows to the client island instead of a slim shape. | Server component maps rows to the slim card shape (`id, name, stage, dateLabel, budgetLabel, client{id,firstName,lastName,email}\|null, milestoneSummary`) before handing them to `<ProjectBoard>`, reusing the identical mapping `projects/page.tsx` ~187-202 already does for `<ProjectBulkSelection>` (§3). `BOARD_MAX_ROWS` lowered 1000→300 (simpler than separately pricing the 1000-row worst case). Test added (§4 #14). |
| 4 | MEDIUM | The server never rejects an invalid stage — `projectStageValue` coerces any unrecognized value to `"inquiry"` (`crm.ts` ~174-178) — so a client "revert on invalid stage" path could never fire. | Added `isValidProjectStage` (§3, `project-board.ts`); both drop and `<select>`-change check membership in `projectStageOptions` **before** firing the request, rejecting out-of-catalog targets client-side with no request sent. Server coercion is unchanged and explicitly noted as the reason the guard must live client-side. Test added (§4 #15). |
| 5 | MINOR | Pending-request lifecycle under-specified: a single scalar `pendingProjectId` would block every other card while one move is in flight; no request timeout was specified; failure copy didn't account for the server possibly having committed. | `pendingProjectIds` is a per-card set/map, not a scalar (§3, `ProjectBoard.tsx`). Added an `AbortController` with a ~15s timeout, mirroring the existing pattern in `QuickFind.tsx`. Timeout path shows "Couldn't confirm — refresh" rather than a generic failure message. Test added (§4 #16). |
| 6 | MINOR | `view=board` did not survive "Clear filters" — that control is a plain `<Link>` (`ProjectSearchFilters.tsx:136`) that drops every query param, including `view`. | `view` added to the Clear-filters link's target (conditionally, when present). The new `view` prop on `ProjectSearchFilters` is optional and renders nothing extra when absent — flag-off markup stays byte-identical (§3). Test added (§4 #17). |
| 7 | MINOR | `listProjectBoardIndex` did not dedupe by `project.id`; a project with more than one primary participant row would render duplicate cards and could flip `truncated` incorrectly. | Applies the same seen-`project.id` dedupe `listProjects` already uses (`crm.ts` ~231-236) before computing `filteredCount`/`truncated` (§2, §3). Test added (§4 #13). |
| 8 | MINOR | Board-membership-vs-filter interaction between a move and the active stage filter was implicit, not stated. | Stated explicitly (§2): moving a card to a stage hidden by the active filter correctly makes it leave the board; a subsequently failed request's revert correctly makes it reappear. Test added (§4 #18). |

No findings were disagreed with or dropped — all eight are folded in as specified above.

### Rev 1 (initial spec) — 2026-07-07
First draft, not yet reviewed. Awaiting Fable adversarial spec review before build; findings will
be folded in as Rev 2 here, in the same format as `phase-22-project-progress-timeline.md` §6.
