import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { clearFiltersHref, ProjectSearchFilters } from "./ProjectSearchFilters";

const baseProps = {
  pageSize: 200,
  pageSizeOptions: [50, 100, 200],
  rawSearch: "",
  selectedStages: [],
  sort: "eventDate",
  stages: [
    { value: "inquiry", label: "Inquiry" },
    { value: "planning", label: "Planning" },
  ],
};

// ---------------------------------------------------------------------------
// Test 17 — Clear-filters preserves view (rev 2, MINOR 6, spec §4 test 17): on the board
// (`?view=board&...`), the "Clear filters" link's target includes `view=board`; on the list (no
// `view`), its target excludes `view` entirely (unchanged today behavior) — proves the added
// param is conditional, not a regression on the flag-off/list path.
//
// `clearFiltersHref` backs that link but the filter panel containing it is gated behind
// client-only `isOpen` state (stays `false` under `renderToStaticMarkup`, which has no
// interactivity) — so it's exported and tested directly here, per the repo's existing pattern of
// extracting a plain helper out of a "use client" file for direct unit testing (e.g.
// `QuickFind.tsx`'s `formatProjectMeta`).
// ---------------------------------------------------------------------------
assert.equal(clearFiltersHref("alex", "board"), "/projects?q=alex&view=board");
assert.equal(clearFiltersHref("", "board"), "/projects?view=board");
assert.equal(clearFiltersHref("alex", undefined), "/projects?q=alex", "byte-identical to the pre-Phase-17 link when view is absent");
assert.equal(clearFiltersHref("", undefined), "/projects", "byte-identical to the pre-Phase-17 link when both are absent");

console.log("test 17 (clear filters preserves view) passed");

// ---------------------------------------------------------------------------
// Companion coverage: the always-visible search form (not gated behind `isOpen`) carries the
// hidden `view` field when `view` is passed, and carries none when it's absent — proving the
// flag-off/list markup stays byte-identical (spec §4 test 8's ProjectSearchFilters half).
// ---------------------------------------------------------------------------
const withView = renderToStaticMarkup(<ProjectSearchFilters {...baseProps} view="board" />);
assert.match(withView, /name="view" value="board"/);

const withoutView = renderToStaticMarkup(<ProjectSearchFilters {...baseProps} />);
assert.doesNotMatch(withoutView, /name="view"/);

console.log("project search filters tests passed");
