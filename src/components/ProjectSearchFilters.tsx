"use client";

import { Search, SlidersHorizontal, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

type ProjectStageOption = {
  label: string;
  value: string;
};

type ProjectSearchFiltersProps = {
  pageSize: number;
  pageSizeOptions: number[];
  rawSearch: string;
  selectedStages: string[];
  sort: string;
  stages: ProjectStageOption[];
  // Phase 17 (kanban board, dark behind PROJECTS_BOARD_VIEW), rev 2 MINOR 6. Optional — when
  // absent (the board flag off, or the list view), this component's rendered markup is
  // byte-identical to before this phase (spec §4 test 8/17).
  view?: string;
};

// Rev 2 MINOR 6: the existing "Clear filters" link drops every query param, including `view` —
// without this fix, clearing filters from the board silently bounced to the list. Built to be
// byte-identical to the pre-Phase-17 link when `view` is absent.
// Exported (not just used internally) so it's directly unit-testable without needing to render
// the filter panel open — that panel is gated behind client-only `isOpen` state, which stays
// `false` under `renderToStaticMarkup` (see `ProjectSearchFilters.test.tsx`).
export function clearFiltersHref(rawSearch: string, view?: string) {
  const base = rawSearch ? `/projects?q=${encodeURIComponent(rawSearch)}` : "/projects";
  if (!view) return base;
  return `${base}${base.includes("?") ? "&" : "?"}view=${encodeURIComponent(view)}`;
}

export function ProjectSearchFilters({
  pageSize,
  pageSizeOptions,
  rawSearch,
  selectedStages,
  sort,
  stages,
  view,
}: ProjectSearchFiltersProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [nextStages, setNextStages] = useState(selectedStages);
  const activeFilterCount = (sort !== "eventDate" ? 1 : 0) + (pageSize !== 200 ? 1 : 0) + selectedStages.length;

  function toggleStage(stage: string) {
    setNextStages((current) => (
      current.includes(stage)
        ? current.filter((value) => value !== stage)
        : [...current, stage]
    ));
  }

  return (
    <section className="relative rounded-[var(--radius-panel)] border border-[var(--line)] bg-[var(--paper)] p-2 shadow-[0_16px_40px_rgba(31,27,24,0.04)]">
      <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]" action="/projects">
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="pageSize" value={pageSize} />
        {selectedStages.length > 0 && <input type="hidden" name="stages" value={selectedStages.join(",")} />}
        {view && <input type="hidden" name="view" value={view} />}
        <label className="relative min-w-0">
          <span className="sr-only">Search projects</span>
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-3)]" />
          <input
            name="q"
            defaultValue={rawSearch}
            placeholder="Search project, client, venue, email"
            className="studio-input studio-search-input min-h-11"
          />
        </label>
        <button
          type="button"
          className="studio-secondary-button inline-flex min-h-11 items-center justify-center gap-2 px-4 text-sm font-semibold"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((value) => !value)}
        >
          <SlidersHorizontal className="h-4 w-4" />
          Filter
          {activeFilterCount > 0 && (
            <span className="ml-1 rounded-full bg-[var(--ink)] px-2 py-0.5 text-[0.65rem] font-semibold text-white">
              {activeFilterCount}
            </span>
          )}
        </button>
        <button className="brand-primary-button min-h-11 px-5 py-2.5">Search</button>
      </form>

      {isOpen && (
        <form
          action="/projects"
          className="absolute right-2 top-[calc(100%+0.5rem)] z-40 w-[min(34rem,calc(100vw-2rem))] rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-4 shadow-[0_24px_60px_rgba(31,27,24,0.16)]"
        >
          <input type="hidden" name="q" value={rawSearch} />
          {nextStages.length > 0 && <input type="hidden" name="stages" value={nextStages.join(",")} />}
          {view && <input type="hidden" name="view" value={view} />}
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Project filters</p>
              <p className="mt-1 text-sm text-[var(--ink-2)]">Sort the list and narrow the visible stages.</p>
            </div>
            <button
              type="button"
              className="studio-secondary-button grid h-8 w-8 place-items-center"
              aria-label="Close filters"
              onClick={() => setIsOpen(false)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.56rem] text-[var(--ink-3)]">Sort</span>
              <select name="sort" defaultValue={sort} className="studio-input">
                <option value="eventDate">Event date</option>
                <option value="createdAt">Recently created</option>
                <option value="name">Project name</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="studio-caps text-[0.56rem] text-[var(--ink-3)]">Rows</span>
              <select name="pageSize" defaultValue={pageSize} className="studio-input">
                {pageSizeOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-4">
            <p className="studio-caps mb-2 text-[0.56rem] text-[var(--ink-3)]">Stages</p>
            <div className="flex flex-wrap gap-2">
              {stages.map((stage) => {
                const checked = nextStages.includes(stage.value);
                return (
                  <button
                    key={stage.value}
                    type="button"
                    className={`studio-chip studio-stage-${stage.value} rounded-full border px-3 py-1.5 transition ${checked ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--line)] bg-[var(--paper)] hover:border-[var(--ink)]"}`}
                    aria-pressed={checked}
                    onClick={() => toggleStage(stage.value)}
                  >
                    {stage.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Link href={clearFiltersHref(rawSearch, view)} prefetch={false} className="text-sm font-semibold text-[var(--ink-3)] transition hover:text-[var(--ink)]">
              Clear filters
            </Link>
            <button className="brand-primary-button min-h-10 px-5 py-2.5">Apply filters</button>
          </div>
        </form>
      )}
    </section>
  );
}
