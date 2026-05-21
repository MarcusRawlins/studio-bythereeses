import { AppShell } from "@/components/AppShell";
import { LinkClientToProjectForm } from "@/components/LinkClientToProjectForm";
import { getClientWithProjects, listProjectsForClientLink } from "@/lib/crm";
import { formatDate, formatMoney } from "@/lib/format";
import { CalendarDays, Edit, Mail, Phone } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

function clientName(client: { firstName: string; lastName: string | null }) {
  return [client.firstName, client.lastName].filter(Boolean).join(" ");
}

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getClientWithProjects(id);
  if (!data) notFound();
  const unlinkedProjects = await listProjectsForClientLink(id);

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 sm:flex-row sm:items-end">
          <div>
            <p className="text-sm font-medium text-[var(--ink-muted)]">Client record</p>
            <h1 className="brand-page-title mt-2 text-4xl">{clientName(data.client)}</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">{data.client.preferredName ? `Preferred name: ${data.client.preferredName}` : "No preferred name set"}</p>
          </div>
          <Link href={`/clients/${data.client.id}/edit`} className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 transition">
            <Edit className="h-4 w-4" />
            Edit client
          </Link>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <a href={`mailto:${data.client.email}`} className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm transition hover:bg-[#f6efe5]">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <Mail className="h-4 w-4" />
              Email
            </div>
            <div className="mt-2 break-all text-lg font-semibold">{data.client.email}</div>
          </a>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <Phone className="h-4 w-4" />
              Phone
            </div>
            <div className="mt-2 text-lg font-semibold">{data.client.phone || "Not set"}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <CalendarDays className="h-4 w-4" />
              Linked projects
            </div>
            <div className="mt-2 text-3xl font-semibold">{data.projects.length}</div>
          </div>
        </section>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Notes</h2>
          <p className="mt-3 whitespace-pre-line text-sm leading-6 text-[var(--ink-muted)]">{data.client.notes || "No client notes yet."}</p>
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Link project</h2>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">Connect this client to an existing project and set their role.</p>
          </div>
          <LinkClientToProjectForm clientId={data.client.id} projects={unlinkedProjects} />
        </section>

        <section className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)]">
          <div className="grid grid-cols-[1.2fr_140px_140px_140px] border-b border-[var(--line)] bg-[#eee8de] px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)] max-lg:hidden">
            <div>Project</div>
            <div>Date</div>
            <div>Stage</div>
            <div>Value</div>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {data.projects.map(({ project, participant }) => (
              <Link key={project.id} href={`/projects/${project.id}`} className="grid gap-2 px-4 py-4 transition hover:bg-[#f6efe5] lg:grid-cols-[1.2fr_140px_140px_140px] lg:items-center">
                <div>
                  <div className="font-semibold">{project.name}</div>
                  <div className="mt-1 text-sm capitalize text-[var(--ink-muted)]">{participant.role.replaceAll("_", " ")}</div>
                </div>
                <div className="text-sm text-[var(--ink-muted)]">{formatDate(project.eventDate)}</div>
                <div className="text-sm capitalize text-[var(--ink-muted)]">{project.stage.replaceAll("_", " ")}</div>
                <div className="text-sm font-semibold">{formatMoney(project.budgetCents)}</div>
              </Link>
            ))}
            {!data.projects.length && <div className="p-8 text-sm text-[var(--ink-muted)]">No linked projects yet.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
