import { AppShell } from "@/components/AppShell";
import { createProjectFromBookingAction, getBookingManageUrls, getSchedulerBookingDetail, linkBookingToProjectAction } from "@/lib/scheduler";
import { ArrowLeft, CalendarDays, ExternalLink, LinkIcon, Mail, Phone, User } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function parseAnswers(value: string | null) {
  if (!value) return [];
  try {
    return Object.entries(JSON.parse(value) as Record<string, string | string[]>);
  } catch {
    return [];
  }
}

export default async function SchedulerBookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getSchedulerBookingDetail(id);
  if (!data || !data.meetingType) notFound();
  const answers = parseAnswers(data.booking.inviteeAnswersJson);
  const manageUrls = getBookingManageUrls(data.meetingType.slug, data.booking);

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 lg:flex-row lg:items-end">
          <div>
            <Link href="/scheduler" className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">
              <ArrowLeft className="h-4 w-4" />
              Back to scheduler
            </Link>
            <h1 className="brand-page-title mt-3 text-4xl">{data.meetingType.name}</h1>
            <p className="mt-2 text-sm capitalize text-[var(--ink-muted)]">{data.booking.status.replaceAll("_", " ")} · {data.booking.calendarSyncStatus.replaceAll("_", " ")}</p>
          </div>
          <a href={manageUrls.manageUrl} target="_blank" className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--foreground)]">
            <ExternalLink className="h-4 w-4" />
            Public manage page
          </a>
        </header>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]"><User className="h-4 w-4" /> Name</div>
            <div className="mt-2 text-lg font-semibold">{data.booking.attendeeName}</div>
          </div>
          <a href={`mailto:${data.booking.attendeeEmail}`} className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 transition hover:bg-[#f6efe5]">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]"><Mail className="h-4 w-4" /> Email</div>
            <div className="mt-2 break-all text-lg font-semibold">{data.booking.attendeeEmail}</div>
          </a>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]"><Phone className="h-4 w-4" /> Phone</div>
            <div className="mt-2 text-lg font-semibold">{data.booking.attendeePhone || "Not set"}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]"><CalendarDays className="h-4 w-4" /> Time</div>
            <div className="mt-2 text-lg font-semibold">{formatDateTime(data.booking.startAt)}</div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-2">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <h2 className="text-lg font-semibold">Booking answers</h2>
            <div className="mt-4 divide-y divide-[var(--line)]">
              {answers.map(([key, answer]) => (
                <div key={key} className="py-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">{key.replaceAll("_", " ")}</div>
                  <div className="mt-1 text-sm leading-6">{Array.isArray(answer) ? answer.join(", ") : answer || "No answer"}</div>
                </div>
              ))}
              {!answers.length && <p className="py-3 text-sm text-[var(--ink-muted)]">No custom answers collected.</p>}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
              <h2 className="text-lg font-semibold">Client and project</h2>
              <div className="mt-4 grid gap-3 text-sm">
                <div>Client: {data.client ? <Link href={`/clients/${data.client.id}`} className="font-semibold underline">{data.client.firstName} {data.client.lastName}</Link> : "Not linked"}</div>
                <div>Project: {data.project ? <Link href={`/projects/${data.project.id}`} className="font-semibold underline">{data.project.name}</Link> : "Not linked"}</div>
              </div>
              {!data.project && (
                <form action={linkBookingToProjectAction} className="mt-5 grid gap-3">
                  <input type="hidden" name="bookingId" value={data.booking.id} />
                  <label className="space-y-1.5 text-sm font-medium">
                    Link to existing project
                    <select name="projectId" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                      <option value="">Select project</option>
                      {data.allProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                  </label>
                  <button className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--foreground)]">
                    <LinkIcon className="h-4 w-4" />
                    Link booking
                  </button>
                </form>
              )}
            </div>

            {!data.project && data.client && (
              <form action={createProjectFromBookingAction} className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
                <input type="hidden" name="bookingId" value={data.booking.id} />
                <h2 className="text-lg font-semibold">Create project from booking</h2>
                <label className="mt-4 block space-y-1.5 text-sm font-medium">
                  Project name
                  <input name="projectName" placeholder={`${data.booking.attendeeName} Wedding`} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                <button className="brand-primary-button mt-3 rounded-sm px-4 py-2.5 transition">Create project</button>
              </form>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
