import { AppShell } from "@/components/AppShell";
import { listProjects, projectStageOptions } from "@/lib/crm";
import { formatDate, formatMoney } from "@/lib/format";
import Link from "next/link";

export const dynamic = "force-dynamic";

type ProjectSort = "eventDate" | "createdAt" | "name";

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function getStageHref(stage: string, selectedStages: string[]) {
  const nextStages = selectedStages.includes(stage)
    ? selectedStages.filter((item) => item !== stage)
    : [...selectedStages, stage];
  return nextStages.length ? `/projects?stages=${nextStages.join(",")}` : "/projects";
}

function projectMatchesSearch(row: Awaited<ReturnType<typeof listProjects>>[number], search: string) {
  if (!search) return true;
  const haystack = [
    row.project.name,
    row.project.stage,
    row.project.type,
    row.project.venueName,
    row.project.venueAddress,
    row.client.firstName,
    row.client.lastName,
    row.client.email,
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(search.toLowerCase());
}

type ProjectsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProjectsPage({ searchParams }: ProjectsPageProps) {
  const params = searchParams ? await searchParams : {};
  const rawSort = firstQueryValue(params.sort);
  const rawSearch = firstQueryValue(params.q) ?? "";
  const selectedStages = (firstQueryValue(params.stages) ?? "").split(",").filter(Boolean);
  const sort: ProjectSort = rawSort === "createdAt" || rawSort === "name" ? rawSort : "eventDate";

  const rows = (await listProjects()).filter((row) => {
    const stageMatches = selectedStages.length ? selectedStages.includes(row.project.stage) : true;
    return stageMatches && projectMatchesSearch(row, rawSearch);
  }).toSorted((a, b) => {
    if (sort === "name") {
      return a.project.name.localeCompare(b.project.name);
    }

    if (sort === "createdAt") {
      return String(b.project.createdAt).localeCompare(String(a.project.createdAt));
    }

    return String(a.project.eventDate ?? "9999-12-31").localeCompare(String(b.project.eventDate ?? "9999-12-31"));
  });

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="border-b border-[var(--line)] pb-5">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <h1 className="brand-page-title text-4xl">Projects</h1>
              <p className="mt-2 text-sm text-[var(--ink-muted)]">Every client project, from inquiry through delivery.</p>
            </div>
            <Link href="/projects/new" prefetch={false} className="brand-primary-button inline-flex items-center justify-center rounded-sm px-4 py-2.5 transition">
              Create new project
            </Link>
          </div>
        </header>

        <section className="space-y-4 border-b border-[var(--line)] pb-5">
          <form className="grid gap-3 md:grid-cols-[1fr_190px_auto]" action="/projects">
            {selectedStages.length > 0 && <input type="hidden" name="stages" value={selectedStages.join(",")} />}
            <label className="space-y-1.5 text-sm font-medium">
              Search projects
              <input name="q" defaultValue={rawSearch} placeholder="Project, client, venue, email" className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none transition focus:border-[var(--foreground)]" />
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              Sort
              <select name="sort" defaultValue={sort} className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none transition focus:border-[var(--foreground)]">
                <option value="eventDate">Event date</option>
                <option value="createdAt">Recently created</option>
                <option value="name">Project name</option>
              </select>
            </label>
            <button className="brand-primary-button self-end rounded-sm px-4 py-2.5 transition">Apply</button>
          </form>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Stages</span>
            <Link
              href="/projects"
              prefetch={false}
              className={`rounded-full border px-3 py-1.5 text-sm transition ${selectedStages.length === 0 ? "border-[var(--brand-brown)] bg-[#efe7dc] text-[var(--foreground)] shadow-sm" : "border-[var(--line)] hover:border-[var(--foreground)]"}`}
            >
              All
            </Link>
            {projectStageOptions.map((stage) => (
              <Link
                key={stage.value}
                href={getStageHref(stage.value, selectedStages)}
                prefetch={false}
                className={`rounded-full border px-3 py-1.5 text-sm transition ${selectedStages.includes(stage.value) ? "border-[var(--brand-brown)] bg-[#efe7dc] text-[var(--foreground)] shadow-sm" : "border-[var(--line)] hover:border-[var(--foreground)]"}`}
              >
                {stage.label}
              </Link>
            ))}
          </div>
        </section>

        <section className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)]">
          <div className="grid grid-cols-[1.2fr_1fr_140px_140px_140px] border-b border-[var(--line)] bg-[#eee8de] px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)] max-lg:hidden">
            <div>Project</div>
            <div>Client</div>
            <div>Date</div>
            <div>Stage</div>
            <div>Value</div>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {rows.map(({ project, client }) => (
              <div key={project.id} className="grid gap-2 px-4 py-4 transition hover:bg-[#f6efe5] lg:grid-cols-[1.2fr_1fr_140px_140px_140px] lg:items-center">
                <div>
                  <Link href={`/projects/${project.id}`} prefetch={false} className="font-semibold transition hover:text-[var(--accent-strong)]">
                    {project.name}
                  </Link>
                  <div className="mt-1 text-sm capitalize text-[var(--ink-muted)] lg:hidden">{project.stage.replaceAll("_", " ")}</div>
                </div>
                <div className="text-sm text-[var(--ink-muted)]">
                  <Link href={`/clients/${client.id}`} prefetch={false} className="font-semibold text-[var(--foreground)] transition hover:text-[var(--accent-strong)]">
                    {client.firstName} {client.lastName}
                  </Link>
                  {" · "}
                  {client.email}
                </div>
                <div className="text-sm text-[var(--ink-muted)]">{formatDate(project.eventDate)}</div>
                <div className="text-sm capitalize text-[var(--ink-muted)] max-lg:hidden">{project.stage.replaceAll("_", " ")}</div>
                <div className="text-sm font-semibold">{formatMoney(project.budgetCents)}</div>
              </div>
            ))}
            {!rows.length && <div className="p-8 text-sm text-[var(--ink-muted)]">No projects yet.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
