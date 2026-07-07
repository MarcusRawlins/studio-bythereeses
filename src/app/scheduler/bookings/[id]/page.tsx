import { AppShell } from "@/components/AppShell";
import { MEETING_NOTE_TEMPLATE } from "@/lib/project-communications";
import { createProjectFromBookingAction, getBookingManageUrls, getSchedulerBookingDetail, linkBookingToProjectAction, recordSchedulerBookingPaymentAction } from "@/lib/scheduler";
import { ArrowLeft, CalendarDays, CreditCard, ExternalLink, LinkIcon, Mail, NotebookPen, Phone, User } from "lucide-react";
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

function formatMoney(cents: number | null | undefined) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents ?? 0) / 100);
}

function paymentDateValue(value: string | null) {
  if (!value) return "";
  return value.slice(0, 16);
}

export default async function SchedulerBookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getSchedulerBookingDetail(id);
  if (!data || !data.meetingType) notFound();
  const answers = parseAnswers(data.booking.inviteeAnswersJson);
  const manageUrls = getBookingManageUrls(data.meetingType.slug, data.booking);
  const meetingNotesEnabled = process.env.MEETING_NOTES_ENABLED === "1";

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
            <div
              id={`payment-${data.booking.id}`}
              className="scroll-mt-6 rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 target:bg-[var(--accent-soft)]"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Payment</h2>
                  <p className="mt-1 text-sm capitalize text-[var(--ink-muted)]">{data.booking.paymentStatus.replaceAll("_", " ")}</p>
                </div>
                <CreditCard className="h-5 w-5 text-[var(--ink-muted)]" />
              </div>

              <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Service paid</div>
                  <div className="mt-1 font-semibold">{formatMoney(data.booking.paidAmountCents)}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Gross collected</div>
                  <div className="mt-1 font-semibold">{formatMoney(data.booking.grossCollectedCents)}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Client fee</div>
                  <div className="mt-1 font-semibold">{formatMoney(data.booking.clientFeeCents)}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Net deposit</div>
                  <div className="mt-1 font-semibold">{formatMoney(data.booking.netDepositCents)}</div>
                </div>
              </div>

              {data.booking.paymentLink && (
                <a href={data.booking.paymentLink} target="_blank" className="mt-4 inline-flex items-center gap-2 text-sm font-semibold underline">
                  <ExternalLink className="h-4 w-4" />
                  Open checkout link
                </a>
              )}

              <form action={recordSchedulerBookingPaymentAction} className="mt-5 grid gap-3 border-t border-[var(--line)] pt-4">
                <input type="hidden" name="bookingId" value={data.booking.id} />
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1.5 text-sm font-medium">
                    Status
                    <select name="status" defaultValue={data.booking.paymentStatus} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                      <option value="unpaid">Unpaid</option>
                      <option value="pending">Pending</option>
                      <option value="paid">Paid</option>
                      <option value="refunded">Refunded</option>
                      <option value="waived">Waived</option>
                    </select>
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    Method
                    <select name="paymentMethod" defaultValue={data.booking.paymentMethod ?? ""} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                      <option value="">Not set</option>
                      <option value="stripe">Stripe</option>
                      <option value="credit_card">Credit card</option>
                      <option value="zelle">Zelle</option>
                      <option value="venmo">Venmo</option>
                      <option value="check">Check</option>
                      <option value="cash">Cash</option>
                    </select>
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    Paid amount
                    <input name="paidAmount" defaultValue={data.booking.paidAmountCents ? (data.booking.paidAmountCents / 100).toFixed(2) : data.meetingType.priceCents ? (data.meetingType.priceCents / 100).toFixed(2) : ""} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    Paid at
                    <input name="paidAt" type="datetime-local" defaultValue={paymentDateValue(data.booking.paidAt)} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                  </label>
                </div>
                <label className="space-y-1.5 text-sm font-medium">
                  External payment id
                  <input name="externalPaymentId" defaultValue={data.booking.externalPaymentId ?? ""} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Notes
                  <textarea name="notes" defaultValue={data.booking.paymentNotes ?? ""} rows={3} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Save payment</button>
              </form>
            </div>

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

            {meetingNotesEnabled && (
              <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
                <div className="flex items-center gap-2">
                  <NotebookPen className="h-5 w-5 text-[var(--ink-muted)]" />
                  <h2 className="text-lg font-semibold">Meeting notes</h2>
                </div>
                {data.project ? (
                  <>
                    <form action={`/api/projects/${data.project.id}/communications`} method="post" className="mt-4 grid gap-3">
                      <input type="hidden" name="projectId" value={data.project.id} />
                      <input type="hidden" name="bookingId" value={data.booking.id} />
                      <input type="hidden" name="channel" value="note" />
                      <input type="hidden" name="direction" value="internal" />
                      <label className="space-y-1.5 text-sm font-medium">
                        Notes
                        <textarea
                          name="body"
                          required
                          rows={8}
                          defaultValue={MEETING_NOTE_TEMPLATE}
                          className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none"
                        />
                      </label>
                      <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Save meeting note</button>
                    </form>
                    <div className="mt-5 divide-y divide-[var(--line)]">
                      {data.notes.map((note) => (
                        <div key={note.id} className="py-3">
                          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">{formatDateTime(note.createdAt)}</div>
                          <p className="mt-1 whitespace-pre-line text-sm leading-6">{note.body}</p>
                        </div>
                      ))}
                      {!data.notes.length && <p className="py-3 text-sm text-[var(--ink-muted)]">No meeting notes yet.</p>}
                    </div>
                  </>
                ) : (
                  <p className="mt-4 text-sm text-[var(--ink-muted)]">Link this booking to a project to add meeting notes.</p>
                )}
              </div>
            )}

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
