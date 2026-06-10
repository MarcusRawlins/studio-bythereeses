import { AppShell } from "@/components/AppShell";
import { CreateProjectForClientForm } from "@/components/CreateProjectForClientForm";
import { LinkClientToProjectForm } from "@/components/LinkClientToProjectForm";
import { getClientWithProjects, listClientMergeCandidates, listProjectsForClientLink } from "@/lib/crm";
import { formatActivityAction, formatDate, formatMoney } from "@/lib/format";
import { Activity, CalendarDays, ClipboardList, Edit, FileSignature, Mail, MessageSquareText, Phone, ReceiptText, UserRound, UsersRound } from "lucide-react";
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
  const [unlinkedProjects, mergeCandidates] = await Promise.all([
    listProjectsForClientLink(id),
    listClientMergeCandidates(id),
  ]);

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

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <UserRound className="h-4 w-4" />
              Instagram
            </div>
            <div className="mt-2 text-lg font-semibold">{data.client.instagramHandle || "Not set"}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <MessageSquareText className="h-4 w-4" />
              Communication
            </div>
            <div className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">{data.client.communicationPreference || "No preference set"}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <ClipboardList className="h-4 w-4" />
              Source
            </div>
            <div className="mt-2 text-lg font-semibold">{data.client.referralSource || "Not set"}</div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <CalendarDays className="h-4 w-4" />
              Bookings
            </div>
            <div className="mt-2 text-2xl font-semibold">{data.bookings.length}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <FileSignature className="h-4 w-4" />
              Proposals
            </div>
            <div className="mt-2 text-2xl font-semibold">{data.proposals.length}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <ReceiptText className="h-4 w-4" />
              Invoices
            </div>
            <div className="mt-2 text-2xl font-semibold">{data.invoices.length}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <ClipboardList className="h-4 w-4" />
              Questionnaires
            </div>
            <div className="mt-2 text-2xl font-semibold">{data.questionnaireResponses.length}</div>
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

        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Create project</h2>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">Start a new canonical project using this client as the primary contact.</p>
          </div>
          <CreateProjectForClientForm clientId={data.client.id} />
        </section>

        {mergeCandidates.length > 0 && (
          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <UsersRound className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="text-lg font-semibold">Merge duplicate</h2>
            </div>
            <form action={`/api/clients/${data.client.id}/merge`} method="post" className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
              <label className="space-y-1.5 text-sm font-medium">
                Duplicate client
                <select name="duplicateClientId" required className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(47,93,80,0.14)]">
                  <option value="">Select client</option>
                  {mergeCandidates.map((client) => (
                    <option key={client.id} value={client.id}>
                      {clientName(client)} · {client.email}
                    </option>
                  ))}
                </select>
              </label>
              <input type="hidden" name="actorName" value="Tyler" />
              <button className="rounded-sm border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--foreground)]">
                Merge into this client
              </button>
            </form>
          </section>
        )}

        <section className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)]">
          <div className="border-b border-[var(--line)] px-4 py-3">
            <h2 className="text-lg font-semibold">Projects</h2>
          </div>
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

        <section className="grid gap-5 xl:grid-cols-2">
          <div className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)]">
            <div className="border-b border-[var(--line)] px-4 py-3">
              <h2 className="text-lg font-semibold">Bookings</h2>
            </div>
            <div className="divide-y divide-[var(--line)]">
              {data.bookings.map((booking) => (
                <Link key={booking.id} href={`/scheduler/bookings/${booking.id}`} prefetch={false} className="block px-4 py-4 transition hover:bg-[#f6efe5]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{booking.meetingName}</div>
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">{booking.projectName ?? "Unlinked booking"} · {formatDate(booking.startAt)}</div>
                    </div>
                    <span className="studio-chip capitalize">{booking.status.replaceAll("_", " ")}</span>
                  </div>
                </Link>
              ))}
              {!data.bookings.length && <div className="p-5 text-sm text-[var(--ink-muted)]">No scheduler bookings linked to this client yet.</div>}
            </div>
          </div>

          <div className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)]">
            <div className="border-b border-[var(--line)] px-4 py-3">
              <h2 className="text-lg font-semibold">Questionnaires</h2>
            </div>
            <div className="divide-y divide-[var(--line)]">
              {data.questionnaireResponses.map((response) => (
                <Link key={response.id} href={`/questionnaires/${response.questionnaireId}/responses/${response.id}`} prefetch={false} className="block px-4 py-4 transition hover:bg-[#f6efe5]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{response.questionnaireTitle}</div>
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">{response.projectName ?? "No project"} · Updated {formatDate(response.updatedAt)}</div>
                    </div>
                    <span className="studio-chip capitalize">{response.status}</span>
                  </div>
                </Link>
              ))}
              {!data.questionnaireResponses.length && <div className="p-5 text-sm text-[var(--ink-muted)]">No questionnaire responses linked to this client yet.</div>}
            </div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-2">
          <div className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)]">
            <div className="border-b border-[var(--line)] px-4 py-3">
              <h2 className="text-lg font-semibold">Proposals</h2>
            </div>
            <div className="divide-y divide-[var(--line)]">
              {data.proposals.map((proposal) => (
                <Link key={proposal.id} href={`/proposals/${proposal.id}`} prefetch={false} className="block px-4 py-4 transition hover:bg-[#f6efe5]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{proposal.title}</div>
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">{proposal.projectName} · {formatMoney(proposal.totalCents)}</div>
                    </div>
                    <span className="studio-chip capitalize">{proposal.status.replaceAll("_", " ")}</span>
                  </div>
                </Link>
              ))}
              {!data.proposals.length && <div className="p-5 text-sm text-[var(--ink-muted)]">No proposals linked through this client record yet.</div>}
            </div>
          </div>

          <div className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)]">
            <div className="border-b border-[var(--line)] px-4 py-3">
              <h2 className="text-lg font-semibold">Invoices</h2>
            </div>
            <div className="divide-y divide-[var(--line)]">
              {data.invoices.map((invoice) => (
                <Link key={invoice.id} href={`/invoices/${invoice.id}`} prefetch={false} className="block px-4 py-4 transition hover:bg-[#f6efe5]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{invoice.invoiceNumber}</div>
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">
                        {invoice.projectName} · Open {formatMoney(invoice.openBalanceCents)}
                        {invoice.nextPaymentDueDate ? ` · Next due ${formatDate(invoice.nextPaymentDueDate)}` : ""}
                      </div>
                    </div>
                    <span className="studio-chip capitalize">{invoice.status.replaceAll("_", " ")}</span>
                  </div>
                </Link>
              ))}
              {!data.invoices.length && <div className="p-5 text-sm text-[var(--ink-muted)]">No invoices linked through this client record yet.</div>}
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)]">
          <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3">
            <Activity className="h-4 w-4 text-[var(--ink-muted)]" />
            <h2 className="text-lg font-semibold">Activity</h2>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {data.activity.map((entry) => (
              <div key={entry.id} className="px-4 py-4">
                <div className="font-semibold">{formatActivityAction(entry.action)}</div>
                <div className="mt-1 text-sm text-[var(--ink-muted)]">{formatDate(entry.createdAt)} · {entry.actorName ?? entry.actorType}</div>
              </div>
            ))}
            {!data.activity.length && <div className="p-5 text-sm text-[var(--ink-muted)]">No client activity yet.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
