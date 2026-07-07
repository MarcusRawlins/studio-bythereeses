import { AppShell } from "@/components/AppShell";
import { ProjectBoard } from "@/components/ProjectBoard";
import { ProjectBulkSelection } from "@/components/ProjectBulkSelection";
import { ProjectSearchFilters } from "@/components/ProjectSearchFilters";
import { listProjectBoardIndex, listProjectIndex, projectStageOptions, type ProjectIndexSort } from "@/lib/crm";
import { formatDate, formatMoney } from "@/lib/format";
import { loadProjectMilestoneSummaries } from "@/lib/project-milestones-batch";
import { BOARD_MAX_ROWS } from "@/lib/project-board";
import { ChevronLeft, ChevronRight, LayoutGrid, List, Plus } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

const defaultPageSize = 200;
const pageSizeOptions = [50, 100, 200];

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function positiveInteger(value: string | string[] | undefined, fallback = 1) {
  const parsed = Number(firstQueryValue(value));
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function projectPageSize(value: string | string[] | undefined) {
  const parsed = positiveInteger(value, defaultPageSize);
  return pageSizeOptions.includes(parsed) ? parsed : defaultPageSize;
}

function projectsHref(params: {
  q?: string;
  sort?: ProjectIndexSort;
  stages?: string[];
  page?: number;
  pageSize?: number;
  view?: "board";
}) {
  const searchParams = new URLSearchParams();
  if (params.q) searchParams.set("q", params.q);
  if (params.sort && params.sort !== "eventDate") searchParams.set("sort", params.sort);
  if (params.stages?.length) searchParams.set("stages", params.stages.join(","));
  if (params.pageSize && params.pageSize !== defaultPageSize) searchParams.set("pageSize", String(params.pageSize));
  if (params.page && params.page > 1) searchParams.set("page", String(params.page));
  if (params.view) searchParams.set("view", params.view);
  const query = searchParams.toString();
  return query ? `/projects?${query}` : "/projects";
}

function ProjectsPagination({
  currentPage,
  pageSize,
  rawSearch,
  selectedStages,
  sort,
  totalPages,
  withTopLink = false,
}: {
  currentPage: number;
  pageSize: number;
  rawSearch: string;
  selectedStages: string[];
  sort: ProjectIndexSort;
  totalPages: number;
  withTopLink?: boolean;
}) {
  return (
    <nav className="flex flex-col gap-3 border-t border-[var(--line)] pt-5 sm:flex-row sm:items-center sm:justify-between" aria-label="Projects pagination">
      <p className="studio-caps text-[0.58rem] text-[var(--ink-3)]">
        Page {currentPage} of {totalPages}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {withTopLink && (
          <a href="#projects-list" className="studio-secondary-button inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold">
            Top of list
          </a>
        )}
        {currentPage > 1 ? (
          <Link
            href={projectsHref({ q: rawSearch, sort, stages: selectedStages, page: currentPage - 1, pageSize })}
            prefetch={false}
            className="studio-secondary-button inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold"
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Link>
        ) : null}
        {currentPage < totalPages ? (
          <Link
            href={projectsHref({ q: rawSearch, sort, stages: selectedStages, page: currentPage + 1, pageSize })}
            prefetch={false}
            className="studio-secondary-button inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

// Phase 17 (kanban board, dark behind PROJECTS_BOARD_VIEW), spec §3. Plain `<Link>`s, no client
// component needed for the toggle itself — preserves `q`/`stages`/`sort` across the switch.
function ProjectsViewToggle({
  rawSearch,
  selectedStages,
  sort,
  view,
}: {
  rawSearch: string;
  selectedStages: string[];
  sort: ProjectIndexSort;
  view: "list" | "board";
}) {
  const linkClass = (active: boolean) =>
    `studio-secondary-button inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold ${active ? "border-[var(--ink)] text-[var(--ink)]" : "text-[var(--ink-3)]"}`;

  return (
    <nav className="flex items-center gap-2" aria-label="Projects view toggle">
      <Link
        href={projectsHref({ q: rawSearch, sort, stages: selectedStages })}
        prefetch={false}
        className={linkClass(view === "list")}
        aria-current={view === "list" ? "page" : undefined}
      >
        <List className="h-4 w-4" />
        List
      </Link>
      <Link
        href={projectsHref({ q: rawSearch, sort, stages: selectedStages, view: "board" })}
        prefetch={false}
        className={linkClass(view === "board")}
        aria-current={view === "board" ? "page" : undefined}
      >
        <LayoutGrid className="h-4 w-4" />
        Board
      </Link>
    </nav>
  );
}

type ProjectsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProjectsPage({ searchParams }: ProjectsPageProps) {
  const params = searchParams ? await searchParams : {};
  const rawSort = firstQueryValue(params.sort);
  const rawSearch = firstQueryValue(params.q) ?? "";
  const notice = firstQueryValue(params.notice);
  const selectedStages = (firstQueryValue(params.stages) ?? "").split(",").filter(Boolean);
  const sort: ProjectIndexSort = rawSort === "createdAt" || rawSort === "name" ? rawSort : "eventDate";

  // Phase 17 (dark behind PROJECTS_BOARD_VIEW), spec §3 D2. Flag off => `view` is never computed
  // beyond this boolean/ternary and the board branch below is unreachable — the rest of this
  // function runs byte-identically to before this phase: `listProjectBoardIndex` is never called,
  // no toggle renders, and `ProjectSearchFilters` never receives a `view` prop.
  const projectsBoardViewEnabled = process.env.PROJECTS_BOARD_VIEW === "1";
  const view: "board" | "list" = projectsBoardViewEnabled && firstQueryValue(params.view) === "board" ? "board" : "list";

  if (view === "board") {
    const boardIndex = await listProjectBoardIndex({ q: rawSearch, stages: selectedStages, sort });

    // Phase 22 (dark behind PROJECT_PROGRESS_TIMELINE), reused unchanged. Zero added queries when
    // the flag is off.
    const projectProgressTimelineEnabled = process.env.PROJECT_PROGRESS_TIMELINE === "1";
    const milestoneSummaryByProjectId = projectProgressTimelineEnabled
      ? await loadProjectMilestoneSummaries(boardIndex.rows.map(({ project }) => project), new Date())
      : new Map();

    // Rev 2, MEDIUM 3: slim card shape — the same mapping shape the list branch already uses for
    // `<ProjectBulkSelection>` below, so no extra project/client column crosses the RSC boundary
    // into the client bundle a second time.
    const boardCards = boardIndex.rows.map(({ project, client }) => ({
      id: project.id,
      name: project.name,
      stage: project.stage,
      dateLabel: formatDate(project.eventDate),
      budgetLabel: formatMoney(project.budgetCents),
      client: client ? {
        id: client.id,
        firstName: client.firstName,
        lastName: client.lastName,
        email: client.email,
      } : null,
      milestoneSummary: milestoneSummaryByProjectId.get(project.id) ?? null,
    }));

    return (
      <AppShell>
        <div className="space-y-[var(--gap)]">
          <header className="border-b border-[var(--line)] pb-6">
            <div className="grid gap-6 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="min-w-0">
                <div className="studio-caps mb-3 flex flex-wrap items-center gap-3 text-[0.58rem] text-[var(--ink-3)]">
                  <span>The Studio</span>
                  <span className="hidden h-px w-7 bg-[var(--ink)] sm:inline-block" />
                  <span>{boardIndex.filteredCount} projects</span>
                </div>
                <h1 className="brand-page-title text-5xl sm:text-6xl md:text-7xl">Projects</h1>
                <p className="mt-3 max-w-2xl font-[var(--serif)] text-lg italic text-[var(--ink-2)] sm:text-xl">Inquiry through delivery, in one place.</p>
              </div>
              <Link href="/projects/new" prefetch={false} className="brand-primary-button inline-flex min-h-11 w-full items-center justify-center gap-2 px-4 py-2.5 transition sm:w-auto">
                <Plus className="h-4 w-4" />
                Create new project
              </Link>
            </div>
          </header>

          <ProjectsViewToggle rawSearch={rawSearch} selectedStages={selectedStages} sort={sort} view="board" />

          <ProjectSearchFilters
            pageSize={defaultPageSize}
            pageSizeOptions={pageSizeOptions}
            rawSearch={rawSearch}
            selectedStages={selectedStages}
            sort={sort}
            stages={projectStageOptions}
            view="board"
          />

          {boardIndex.truncated && (
            <div className="rounded-[var(--radius-panel)] border border-[var(--line)] bg-[var(--paper-2)] p-4 text-sm font-semibold text-[var(--ink-2)]">
              Showing the first {BOARD_MAX_ROWS} of {boardIndex.filteredCount} matching projects — narrow with search/stage filters or use List view.
            </div>
          )}

          <ProjectBoard activeStages={boardIndex.stages} projects={boardCards} stages={projectStageOptions} />
        </div>
      </AppShell>
    );
  }

  const requestedPage = positiveInteger(params.page);
  const pageSize = projectPageSize(params.pageSize);
  const projectIndex = await listProjectIndex({
    q: rawSearch,
    stages: selectedStages,
    sort,
    page: requestedPage,
    pageSize,
  });
  const { rows: pageRows, totalCount, filteredCount, totalPages, currentPage, rangeStart, rangeEnd } = projectIndex;

  // Phase 22 (dark behind PROJECT_PROGRESS_TIMELINE). Zero added queries when the flag is off —
  // `loadProjectMilestoneSummaries` (5 batched, chunked fetches; rev 2 B2) is only ever invoked
  // inside this branch.
  const projectProgressTimelineEnabled = process.env.PROJECT_PROGRESS_TIMELINE === "1";
  const milestoneSummaryByProjectId = projectProgressTimelineEnabled
    ? await loadProjectMilestoneSummaries(pageRows.map(({ project }) => project), new Date())
    : new Map();

  const countLabel = filteredCount === totalCount
    ? pageRows.length === filteredCount
      ? `${totalCount} canonical projects loaded`
      : `Showing ${rangeStart}-${rangeEnd} of ${totalCount} canonical projects`
    : filteredCount
      ? `Showing ${rangeStart}-${rangeEnd} of ${filteredCount} canonical projects shown (${totalCount} total)`
      : `0 of ${totalCount} canonical projects shown`;

  return (
    <AppShell>
      <div className="space-y-[var(--gap)]">
        <header className="border-b border-[var(--line)] pb-6">
          <div className="grid gap-6 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="min-w-0">
              <div className="studio-caps mb-3 flex flex-wrap items-center gap-3 text-[0.58rem] text-[var(--ink-3)]">
                <span>The Studio</span>
                <span className="hidden h-px w-7 bg-[var(--ink)] sm:inline-block" />
                <span>{filteredCount} projects</span>
              </div>
              <h1 className="brand-page-title text-5xl sm:text-6xl md:text-7xl">Projects</h1>
              <p className="mt-3 max-w-2xl font-[var(--serif)] text-lg italic text-[var(--ink-2)] sm:text-xl">Inquiry through delivery, in one place.</p>
              <p className="studio-caps mt-3 text-[0.58rem] text-[var(--ink-3)]">{countLabel}</p>
            </div>
            <Link href="/projects/new" prefetch={false} className="brand-primary-button inline-flex min-h-11 w-full items-center justify-center gap-2 px-4 py-2.5 transition sm:w-auto">
              <Plus className="h-4 w-4" />
              Create new project
            </Link>
          </div>
        </header>

        {notice === "seed-data-removed" && (
          <div className="rounded-[var(--radius-panel)] border border-[var(--line)] bg-[var(--paper-2)] p-4 text-sm font-semibold text-[var(--ink-2)]">
            That Alex &amp; Taylor seed project was part of the old local scaffold. Studio is now using the restored canonical database below.
          </div>
        )}

        {projectsBoardViewEnabled && (
          <ProjectsViewToggle rawSearch={rawSearch} selectedStages={selectedStages} sort={sort} view="list" />
        )}

        <ProjectSearchFilters
          pageSize={pageSize}
          pageSizeOptions={pageSizeOptions}
          rawSearch={rawSearch}
          selectedStages={selectedStages}
          sort={sort}
          stages={projectStageOptions}
        />

        {filteredCount > pageSize && (
          <ProjectsPagination
            currentPage={currentPage}
            pageSize={pageSize}
            rawSearch={rawSearch}
            selectedStages={selectedStages}
            sort={sort}
            totalPages={totalPages}
          />
        )}

        <ProjectBulkSelection
          rows={pageRows.map(({ project, client }) => ({
            project: {
              id: project.id,
              name: project.name,
              stage: project.stage,
              dateLabel: formatDate(project.eventDate),
              budgetLabel: formatMoney(project.budgetCents),
              milestoneSummary: milestoneSummaryByProjectId.get(project.id) ?? null,
            },
            client: client ? {
              id: client.id,
              firstName: client.firstName,
              lastName: client.lastName,
              email: client.email,
            } : null,
          }))}
          stages={projectStageOptions}
          totalCount={totalCount}
        />

        {filteredCount > pageSize && (
          <ProjectsPagination
            currentPage={currentPage}
            pageSize={pageSize}
            rawSearch={rawSearch}
            selectedStages={selectedStages}
            sort={sort}
            totalPages={totalPages}
            withTopLink
          />
        )}
      </div>
    </AppShell>
  );
}
