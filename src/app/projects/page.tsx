import { AppShell } from "@/components/AppShell";
import { ProjectBulkSelection } from "@/components/ProjectBulkSelection";
import { ProjectSearchFilters } from "@/components/ProjectSearchFilters";
import { listProjectIndex, projectStageOptions, type ProjectIndexSort } from "@/lib/crm";
import { formatDate, formatMoney } from "@/lib/format";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
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
}) {
  const searchParams = new URLSearchParams();
  if (params.q) searchParams.set("q", params.q);
  if (params.sort && params.sort !== "eventDate") searchParams.set("sort", params.sort);
  if (params.stages?.length) searchParams.set("stages", params.stages.join(","));
  if (params.pageSize && params.pageSize !== defaultPageSize) searchParams.set("pageSize", String(params.pageSize));
  if (params.page && params.page > 1) searchParams.set("page", String(params.page));
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
