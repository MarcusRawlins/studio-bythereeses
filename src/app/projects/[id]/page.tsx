import { AppShell } from "@/components/AppShell";
import { getProject } from "@/lib/crm";
import { formatDate, formatMoney } from "@/lib/format";
import { weddingTimelineQuestionnaireId } from "@/lib/questionnaire-links";
import { listProjectQuestionnaireResponses, questionnaireResponseStatus } from "@/lib/questionnaires";
import { listProjectBookingLinks } from "@/lib/scheduler";
import { CalendarCheck, CalendarPlus, ClipboardList, Copy, ExternalLink, FileSignature, MapPin, Pencil, ReceiptText, Send } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const projectStages = [
  "inquiry",
  "proposal_sent",
  "retainer_paid",
  "planning",
  "editing",
  "delivered",
  "completed",
];

const projectTypes = ["wedding", "engagement", "family", "branding", "portrait", "event", "other"];
const projectEventTypes = ["engagement", "wedding", "rehearsal", "portrait"];

const inputClass =
  "w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition placeholder:text-[#aaa197] focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(47,93,80,0.14)]";

function mapsUrl(...parts: Array<string | null | undefined>) {
  const query = parts.filter(Boolean).join(", ");
  return query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : null;
}

function formatTimestamp(value: string | null) {
  if (!value) return "Not submitted";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function responsePerson(response: {
  respondentName: string | null;
  respondentEmail: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  clientPreferredName: string | null;
  clientEmail: string | null;
}) {
  const clientName = [response.clientFirstName, response.clientLastName].filter(Boolean).join(" ");
  return response.respondentName || response.clientPreferredName || clientName || response.respondentEmail || response.clientEmail || "Unknown respondent";
}

function projectEventTypeValue(type: string) {
  return projectEventTypes.includes(type) ? type : "other";
}

function customProjectEventTypeValue(type: string) {
  return projectEventTypes.includes(type) ? "" : type;
}

function titleize(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ") : "";
}

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ portalLink?: string; saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const { portalLink, saved, error } = await searchParams;
  const data = await getProject(id);
  if (!data) notFound();

  const primaryClient = data.clients[0];
  const [bookingLinks, questionnaireResponses] = await Promise.all([
    listProjectBookingLinks(data.project.id, primaryClient?.id),
    listProjectQuestionnaireResponses(data.project.id),
  ]);

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 lg:flex-row lg:items-end">
          <div>
            <p className="text-sm font-medium capitalize text-[var(--ink-muted)]">{data.project.stage.replaceAll("_", " ")}</p>
            <h1 className="brand-page-title mt-2 text-4xl">{data.project.name}</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">
              {data.project.venueName ?? "Venue TBD"} · {formatDate(data.project.eventDate)}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Link href={`/projects/${data.project.id}/edit`} className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--foreground)]">
              <Pencil className="h-4 w-4" />
              Edit project
            </Link>
            <form action={`/api/projects/${data.project.id}/portal`} method="post">
              <input type="hidden" name="projectId" value={data.project.id} />
              <input type="hidden" name="clientId" value={primaryClient?.id ?? ""} />
              <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">
                Generate portal link
              </button>
            </form>
          </div>
        </header>

        {portalLink && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--accent-strong)]">
                  <Copy className="h-4 w-4" />
                  Portal link generated
                </div>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  Copy this now. For security, the full token is only shown immediately after creation.
                </p>
              </div>
              <a href={portalLink} className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent-strong)] transition hover:bg-white" target="_blank">
                <ExternalLink className="h-4 w-4" />
                Open portal
              </a>
            </div>
            <a href={portalLink} className="mt-3 block break-all rounded-md bg-white/70 px-3 py-2 text-xs underline" target="_blank">
              {portalLink}
            </a>
          </div>
        )}

        {saved === "details" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Project details saved.
          </div>
        )}

        {(saved === "calendar" || saved === "calendar-event") && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            {saved === "calendar" ? "Project date synced to Google Calendar." : "Project event synced to Google Calendar."}
          </div>
        )}

        {saved === "event" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Project event saved.
          </div>
        )}

        {(error === "calendar-date" || error === "calendar-sync") && (
          <div className="rounded-md border border-[var(--danger)] bg-[#fff5f2] p-4 text-sm font-semibold text-[var(--danger)]">
            {error === "calendar-date"
              ? "Add an event date before syncing Google Calendar."
              : "Google Calendar sync failed. Check Scheduler calendar settings and try again."}
          </div>
        )}

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="text-sm text-[var(--ink-muted)]">Project value</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(data.project.budgetCents)}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="text-sm text-[var(--ink-muted)]">Client</div>
            {primaryClient ? (
              <Link href={`/clients/${primaryClient.id}`} className="mt-2 block text-2xl font-semibold transition hover:text-[var(--accent-strong)]">
                {[primaryClient.firstName, primaryClient.lastName].filter(Boolean).join(" ")}
              </Link>
            ) : (
              <div className="mt-2 text-2xl font-semibold">Unassigned</div>
            )}
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="text-sm text-[var(--ink-muted)]">Portal tokens</div>
            <div className="mt-2 text-2xl font-semibold">{data.tokens.length}</div>
          </div>
        </section>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
          <form action={`/api/projects/${data.project.id}/stage`} method="post" className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <input type="hidden" name="projectId" value={data.project.id} />
            <label className="space-y-1.5 text-sm font-medium sm:min-w-72">
              Stage
              <select
                name="stage"
                defaultValue={data.project.stage}
                className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(47,93,80,0.14)]"
              >
                {projectStages.map((stage) => (
                  <option key={stage} value={stage}>
                    {stage.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">
              Update stage
            </button>
          </form>
        </section>

        <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 xl:col-span-2">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-lg font-semibold">Sales package</h2>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">Proposals and invoices connected to this project.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={`/proposals/new?projectId=${data.project.id}`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                  <FileSignature className="h-4 w-4" />
                  New proposal
                </Link>
                <Link href={`/invoices/new?projectId=${data.project.id}`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                  <ReceiptText className="h-4 w-4" />
                  New invoice
                </Link>
              </div>
            </div>
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <div className="rounded-md border border-[var(--line)] p-4">
                <h3 className="font-semibold">Proposals</h3>
                <div className="mt-3 divide-y divide-[var(--line)]">
                  {data.proposals.map((proposal) => (
                    <Link key={proposal.id} href={`/proposals/${proposal.id}`} className="block py-3 transition hover:text-[var(--brand-brown)]">
                      <div className="font-semibold">{proposal.title}</div>
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">{formatMoney(proposal.totalCents)} · {proposal.status.replaceAll("_", " ")}</div>
                    </Link>
                  ))}
                  {!data.proposals.length && <p className="py-3 text-sm text-[var(--ink-muted)]">No proposals yet.</p>}
                </div>
              </div>
              <div className="rounded-md border border-[var(--line)] p-4">
                <h3 className="font-semibold">Invoices</h3>
                <div className="mt-3 divide-y divide-[var(--line)]">
                  {data.invoices.map((invoice) => (
                    <Link key={invoice.id} href={`/invoices/${invoice.id}`} className="block py-3 transition hover:text-[var(--brand-brown)]">
                      <div className="font-semibold">{invoice.invoiceNumber}</div>
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">{formatMoney(invoice.totalCents - invoice.amountPaidCents)} balance · {invoice.status.replaceAll("_", " ")}</div>
                    </Link>
                  ))}
                  {!data.invoices.length && <p className="py-3 text-sm text-[var(--ink-muted)]">No invoices yet.</p>}
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 xl:col-span-2">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <div className="flex items-center gap-2">
                  <ClipboardList className="h-4 w-4 text-[var(--ink-muted)]" />
                  <h2 className="text-lg font-semibold">Questionnaire responses</h2>
                </div>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">Client form responses tied to this project.</p>
              </div>
              <Link href={`/questionnaires/${weddingTimelineQuestionnaireId}/send?projectId=${data.project.id}`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                <Send className="h-4 w-4" />
                Send questionnaire
              </Link>
            </div>
            <div className="mt-5 divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
              {questionnaireResponses.map((response) => {
                const status = questionnaireResponseStatus(response);
                return (
                  <Link
                    key={response.id}
                    href={`/questionnaires/${response.questionnaireId}/responses/${response.id}`}
                    className="grid gap-3 p-4 transition hover:bg-[#fbf9f5] md:grid-cols-[1fr_220px_auto] md:items-center"
                  >
                    <div>
                      <div className="font-semibold">{response.questionnaireTitle}</div>
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">{responsePerson(response)}</div>
                    </div>
                    <div className="text-sm text-[var(--ink-muted)]">
                      {status === "submitted" ? "Submitted" : "Draft saved"} {formatTimestamp(response.submittedAt ?? response.updatedAt)}
                    </div>
                    <span className="w-fit rounded-full border border-[var(--line)] px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                      {status}
                    </span>
                  </Link>
                );
              })}
              {!questionnaireResponses.length && <p className="p-4 text-sm text-[var(--ink-muted)]">No questionnaire responses are linked to this project yet.</p>}
            </div>
          </section>

          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <h2 className="text-lg font-semibold">Project details</h2>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">Venue, location, type, and working notes for this project.</p>
              </div>
              <div className="text-right text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                Calendar sync
                <div className="mt-1 text-sm font-medium normal-case tracking-normal text-[var(--foreground)]">
                  {data.project.calendarSyncStatus.replaceAll("_", " ")}
                </div>
                {data.project.googleCalendarEventId && data.project.calendarSyncStatus === "synced" ? (
                  <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-[var(--line)] px-2.5 py-1 text-xs normal-case tracking-normal text-[var(--accent-strong)]">
                    <CalendarCheck className="h-3.5 w-3.5" />
                    Synced
                  </div>
                ) : data.project.eventDate ? (
                  <form action={`/api/projects/${data.project.id}/calendar`} method="post" className="mt-2">
                    <button className="inline-flex items-center gap-1 rounded-sm border border-[var(--line)] px-2.5 py-1 text-xs font-semibold normal-case tracking-normal transition hover:border-[var(--foreground)]">
                      <CalendarPlus className="h-3.5 w-3.5" />
                      Sync calendar
                    </button>
                  </form>
                ) : (
                  <div className="mt-2 text-xs font-medium normal-case tracking-normal text-[var(--ink-muted)]">Add event date first.</div>
                )}
              </div>
            </div>

            <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Type</dt>
                <dd className="mt-1 font-medium capitalize">{titleize(data.project.type) || "Not set"}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Venue</dt>
                <dd className="mt-1 font-medium">{data.project.venueName || "Venue TBD"}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Venue address</dt>
                <dd className="mt-1 flex gap-1.5 font-medium">
                  {data.project.venueAddress ? <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" /> : null}
                  <span>{data.project.venueAddress || "Address TBD"}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Location</dt>
                <dd className="mt-1 font-medium">{[data.project.city, data.project.state].filter(Boolean).join(", ") || "Location TBD"}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Notes</dt>
                <dd className="mt-1 whitespace-pre-line leading-relaxed text-[var(--foreground)]">{data.project.notes || "No project notes yet."}</dd>
              </div>
            </dl>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              {mapsUrl(data.project.venueAddress, data.project.venueName, data.project.city, data.project.state) ? (
                <a
                  href={mapsUrl(data.project.venueAddress, data.project.venueName, data.project.city, data.project.state) ?? undefined}
                  target="_blank"
                  className="inline-flex items-center gap-2 text-sm font-semibold underline"
                >
                  <MapPin className="h-3.5 w-3.5" />
                  Open current map
                </a>
              ) : null}
            </div>

            <details className="group mt-5 rounded-md border border-[var(--line)]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold transition hover:bg-[#fbf9f5]">
                <span className="inline-flex items-center gap-2">
                  <Pencil className="h-4 w-4" />
                  Edit details
                </span>
                <span className="text-xs uppercase tracking-[0.12em] text-[var(--ink-muted)] group-open:hidden">Open</span>
                <span className="hidden text-xs uppercase tracking-[0.12em] text-[var(--ink-muted)] group-open:inline">Close</span>
              </summary>
              <form action={`/api/projects/${data.project.id}`} method="post" className="grid gap-3 border-t border-[var(--line)] p-4">
                <label className="space-y-1.5 text-sm font-medium">
                  Type
                  <select name="type" defaultValue={data.project.type} className={inputClass}>
                    {projectTypes.map((type) => (
                      <option key={type} value={type}>
                        {type.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Venue
                  <input name="venueName" defaultValue={data.project.venueName ?? ""} placeholder="Venue name" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Venue address
                  <input name="venueAddress" defaultValue={data.project.venueAddress ?? ""} placeholder="Full address for Google Maps" className={inputClass} />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 text-sm font-medium">
                    City
                    <input name="city" defaultValue={data.project.city ?? ""} placeholder="Chatham" className={inputClass} />
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    State
                    <input name="state" defaultValue={data.project.state ?? ""} placeholder="MA" className={inputClass} />
                  </label>
                </div>
                <label className="space-y-1.5 text-sm font-medium">
                  Notes
                  <textarea name="notes" rows={6} defaultValue={data.project.notes ?? ""} placeholder="Project notes, imported details, planning context." className={inputClass} />
                </label>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  {mapsUrl(data.project.venueAddress, data.project.venueName, data.project.city, data.project.state) ? (
                    <a
                      href={mapsUrl(data.project.venueAddress, data.project.venueName, data.project.city, data.project.state) ?? undefined}
                      target="_blank"
                      className="inline-flex items-center gap-2 text-sm font-semibold underline"
                    >
                      <MapPin className="h-3.5 w-3.5" />
                      Open current map
                    </a>
                  ) : (
                    <span className="text-sm text-[var(--ink-muted)]">Add a venue address to enable map lookup.</span>
                  )}
                  <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">
                    Save details
                  </button>
                </div>
              </form>
            </details>
          </section>

          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <h2 className="text-lg font-semibold">Project booking links</h2>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">Signed scheduler links that save bookings back to this project.</p>
            <div className="mt-4 space-y-3">
              {bookingLinks.map(({ meetingType, url }) => (
                <div key={meetingType.id} className="rounded-md border border-[var(--line)] p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-semibold">{meetingType.name}</div>
                    </div>
                    <a href={url} target="_blank" className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                      <ExternalLink className="h-4 w-4" />
                      Open link
                    </a>
                  </div>
                </div>
              ))}
              {!bookingLinks.length && <p className="text-sm text-[var(--ink-muted)]">No active scheduler links yet.</p>}
            </div>
          </section>

          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <details className="group">
              <summary className="list-none cursor-pointer">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div>
                    <h2 className="text-lg font-semibold">Project events</h2>
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">Wedding day, engagement session, welcome party, and other project dates.</p>
                  </div>
                  <span className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition group-open:border-[var(--foreground)] hover:border-[var(--foreground)]">
                    <CalendarPlus className="h-4 w-4" />
                    Add event
                  </span>
                </div>
              </summary>
              <form action={`/api/projects/${data.project.id}/events`} method="post" className="mt-4 grid gap-3 rounded-md border border-dashed border-[var(--line)] bg-[#fbfaf7] p-4 md:grid-cols-2">
                <input type="hidden" name="projectId" value={data.project.id} />
                <label className="space-y-1.5 text-sm font-medium">
                  Event title
                  <input name="title" required placeholder="Engagement session" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Event date
                  <input name="eventDate" type="date" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Type
                  <select name="type" className={inputClass} defaultValue="engagement">
                    <option value="engagement">Engagement</option>
                    <option value="wedding">Wedding</option>
                    <option value="rehearsal">Rehearsal / Welcome party</option>
                    <option value="portrait">Portrait</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Custom type
                  <input name="customType" placeholder="After party, brunch, etc." className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Venue
                  <input name="venueName" placeholder="Location name" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                  Address
                  <input name="venueAddress" placeholder="Full address for Google Maps" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  City
                  <input name="city" placeholder="Beacon" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  State
                  <input name="state" placeholder="NY" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                  Notes
                  <textarea name="notes" rows={3} className={inputClass} />
                </label>
                <div className="md:col-span-2">
                  <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Add event</button>
                  <p className="mt-2 text-xs text-[var(--ink-muted)]">After adding a project event, sync it from the event card above.</p>
                </div>
              </form>
            </details>
            <div className="mt-4 space-y-3">
              {data.events.map((event) => {
                const eventMapsUrl = mapsUrl(event.venueAddress, event.venueName, event.city, event.state);
                return (
                  <div key={event.id} className="rounded-md border border-[var(--line)] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold">{event.title}</div>
                        <div className="mt-1 text-xs capitalize text-[var(--ink-muted)]">{event.type.replaceAll("_", " ")} · {formatDate(event.eventDate)}</div>
                        <div className="mt-2 text-sm">{event.venueName || "Venue TBD"}</div>
                        {eventMapsUrl && (
                          <a href={eventMapsUrl} target="_blank" className="mt-1 inline-flex items-center gap-1 text-xs font-semibold underline">
                            <MapPin className="h-3 w-3" />
                            Open map
                          </a>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2 text-right text-xs capitalize text-[var(--ink-muted)]">
                        <span>{event.calendarSyncStatus.replaceAll("_", " ")}</span>
                        {event.googleCalendarEventId && event.calendarSyncStatus === "synced" ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] px-2.5 py-1 text-xs normal-case text-[var(--accent-strong)]">
                            <CalendarCheck className="h-3.5 w-3.5" />
                            Synced
                          </span>
                        ) : event.eventDate ? (
                          <form action={`/api/projects/${data.project.id}/calendar`} method="post">
                            <input type="hidden" name="eventId" value={event.id} />
                            <button className="inline-flex items-center gap-1 rounded-sm border border-[var(--line)] px-2.5 py-1 text-xs font-semibold normal-case transition hover:border-[var(--foreground)]">
                              <CalendarPlus className="h-3.5 w-3.5" />
                              Sync
                            </button>
                          </form>
                        ) : (
                          <span className="normal-case">Add date first</span>
                        )}
                      </div>
                    </div>
                    <details className="mt-3 rounded-md border border-[var(--line)] bg-[#fbfaf7]">
                      <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-semibold">
                        <span className="inline-flex items-center gap-2">
                          <Pencil className="h-3.5 w-3.5" />
                          Edit event
                        </span>
                        <span className="text-xs font-medium text-[var(--ink-muted)]">Date, venue, notes, and calendar sync</span>
                      </summary>
                      <form action={`/api/projects/${data.project.id}/events/${event.id}`} method="post" className="grid gap-3 border-t border-[var(--line)] p-3 md:grid-cols-2">
                        <input type="hidden" name="projectId" value={data.project.id} />
                        <input type="hidden" name="eventId" value={event.id} />
                        <label className="space-y-1.5 text-sm font-medium">
                          Event title
                          <input name="title" required defaultValue={event.title} className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          Event date
                          <input name="eventDate" type="date" defaultValue={event.eventDate ?? ""} className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          Type
                          <select name="type" className={inputClass} defaultValue={projectEventTypeValue(event.type)}>
                            <option value="engagement">Engagement</option>
                            <option value="wedding">Wedding</option>
                            <option value="rehearsal">Rehearsal / Welcome party</option>
                            <option value="portrait">Portrait</option>
                            <option value="other">Other</option>
                          </select>
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          Custom type
                          <input name="customType" defaultValue={customProjectEventTypeValue(event.type)} placeholder="After party, brunch, etc." className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          Venue
                          <input name="venueName" defaultValue={event.venueName ?? ""} placeholder="Location name" className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          City
                          <input name="city" defaultValue={event.city ?? ""} placeholder="Chatham" className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                          Address
                          <input name="venueAddress" defaultValue={event.venueAddress ?? ""} placeholder="Full address for Google Maps" className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          State
                          <input name="state" defaultValue={event.state ?? ""} placeholder="MA" className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                          Notes
                          <textarea name="notes" rows={3} defaultValue={event.notes ?? ""} className={inputClass} />
                        </label>
                        <div className="md:col-span-2">
                          <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Save event</button>
                        </div>
                      </form>
                    </details>
                  </div>
                );
              })}
              {!data.events.length && <p className="text-sm text-[var(--ink-muted)]">No project events yet.</p>}
            </div>
          </section>

          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <h2 className="text-lg font-semibold">Wedding day locations</h2>
            <div className="mt-4 space-y-3">
              {data.locations.map((location) => {
                const locationMapsUrl = mapsUrl(location.address, location.name, location.city, location.state);
                return (
                  <div key={location.id} className="rounded-md border border-[var(--line)] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold">{location.name}</div>
                        <div className="mt-1 text-xs capitalize text-[var(--ink-muted)]">{location.type.replaceAll("_", " ")}</div>
                        <div className="mt-2 text-sm text-[var(--ink-muted)]">{[location.address, location.city, location.state].filter(Boolean).join(", ") || "Address not set"}</div>
                        {locationMapsUrl && (
                          <a href={locationMapsUrl} target="_blank" className="mt-1 inline-flex items-center gap-1 text-xs font-semibold underline">
                            <MapPin className="h-3 w-3" />
                            Open map
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {!data.locations.length && <p className="text-sm text-[var(--ink-muted)]">No additional wedding day locations yet.</p>}
            </div>
          </section>

          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <h2 className="text-lg font-semibold">Client portal access</h2>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">
                  Secure project-scoped link for this client portal.
                </p>
              </div>
              {data.tokens.length > 0 && (
                <form action={`/api/projects/${data.project.id}/portal`} method="post">
                  <input type="hidden" name="projectId" value={data.project.id} />
                  <input type="hidden" name="clientId" value={primaryClient?.id ?? ""} />
                  <button className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                    <Send className="h-4 w-4" />
                    New link
                  </button>
                </form>
              )}
            </div>
            <div className="mt-4 space-y-3">
              {data.tokens.map((token) => (
                <div key={token.id} className="rounded-md border border-[var(--line)] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">{token.label ?? "Portal link"}</div>
                      <div className="mt-1 text-xs text-[var(--ink-muted)]">Expires {formatDate(token.expiresAt.slice(0, 10))}</div>
                      <div className="mt-1 text-xs text-[var(--ink-muted)]">{token.revokedAt ? "Revoked" : token.lastUsedAt ? `Last used ${formatDate(token.lastUsedAt.slice(0, 10))}` : "Not used yet"}</div>
                    </div>
                    {!token.revokedAt && (
                      <form action={`/api/projects/${data.project.id}/portal/${token.id}/revoke`} method="post">
                        <input type="hidden" name="projectId" value={data.project.id} />
                        <input type="hidden" name="tokenId" value={token.id} />
                        <button className="text-xs font-semibold text-[var(--danger)]">Revoke</button>
                      </form>
                    )}
                  </div>
                </div>
              ))}
              {!data.tokens.length && (
                <div className="rounded-md border border-dashed border-[var(--line)] p-4">
                  <p className="text-sm text-[var(--ink-muted)]">
                    No portal link has been created for this project yet.
                  </p>
                  <form action={`/api/projects/${data.project.id}/portal`} method="post" className="mt-3">
                    <input type="hidden" name="projectId" value={data.project.id} />
                    <input type="hidden" name="clientId" value={primaryClient?.id ?? ""} />
                    <button className="brand-primary-button inline-flex rounded-sm px-4 py-2.5 text-sm">
                      Create portal link
                    </button>
                  </form>
                </div>
              )}
            </div>
          </section>
        </div>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Activity</h2>
            <ExternalLink className="h-4 w-4 text-[var(--ink-muted)]" />
          </div>
          <div className="mt-4 divide-y divide-[var(--line)]">
            {data.activity.map((entry) => (
              <div key={entry.id} className="py-3 text-sm">
                <div className="font-semibold">{entry.action}</div>
                <div className="mt-1 text-xs text-[var(--ink-muted)]">{new Date(entry.createdAt).toLocaleString()}</div>
              </div>
            ))}
            {!data.activity.length && <p className="py-3 text-sm text-[var(--ink-muted)]">No activity yet.</p>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
