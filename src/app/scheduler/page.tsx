import { AppShell } from "@/components/AppShell";
import { SchedulerQuestionsBuilder } from "@/components/SchedulerQuestionsBuilder";
import {
  getBookingUrl,
  getSchedulerOverview,
  parseInviteeQuestions,
} from "@/lib/scheduler";
import {
  CalendarCheck,
  Copy,
  DollarSign,
  ExternalLink,
  Link as LinkIcon,
  Pencil,
  Plus,
  X,
  Trash2,
  Video,
} from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

const dayLabels: Record<number, string> = {
  7: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

const weekDays = [7, 1, 2, 3, 4, 5, 6];

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function dollars(cents: number | null) {
  if (!cents) return "";
  return String(cents / 100);
}

function MeetingTypeForm({
  meetingType,
}: {
  meetingType?: Awaited<ReturnType<typeof getSchedulerOverview>>["meetingTypes"][number];
}) {
  const questions = parseInviteeQuestions(meetingType?.inviteeQuestionsJson);
  const action = meetingType ? "update" : "create";

  return (
    <form action="/api/scheduler/meeting-types" method="post" className="grid gap-4">
      <input type="hidden" name="_action" value={action} />
      {meetingType && <input type="hidden" name="meetingTypeId" value={meetingType.id} />}

      <section className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1.5 text-sm font-medium">
          Event type name
          <input name="name" defaultValue={meetingType?.name ?? ""} placeholder="Wedding Photography Discovery Call" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Public link slug
          <input name="slug" defaultValue={meetingType?.slug ?? ""} placeholder="wedding-photography-discovery-call" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
        </label>
        <label className="space-y-1.5 text-sm font-medium md:col-span-2">
          Description
          <textarea name="description" rows={3} defaultValue={meetingType?.description ?? ""} placeholder="What clients should know before booking this call." className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
        </label>
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        <label className="space-y-1.5 text-sm font-medium">
          Duration
          <input name="durationMinutes" inputMode="numeric" defaultValue={meetingType?.durationMinutes ?? 45} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Buffer
          <input name="bufferMinutes" inputMode="numeric" defaultValue={meetingType?.bufferMinutes ?? 15} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Location
          <select name="locationType" defaultValue={meetingType?.locationType ?? "zoom"} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
            <option value="zoom">Zoom</option>
            <option value="phone">Phone</option>
            <option value="in_person">In person</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Location label
          <input name="locationLabel" defaultValue={meetingType?.locationLabel ?? "Zoom"} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
        </label>
        <label className="space-y-1.5 text-sm font-medium md:col-span-4">
          Zoom link for this event
          <input name="zoomJoinUrl" defaultValue={meetingType?.zoomJoinUrl ?? ""} placeholder="Leave blank to use the global Zoom link" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
        </label>
      </section>

      <SchedulerQuestionsBuilder questions={questions} />

      <section className="grid gap-3 rounded-md border border-[var(--line)] bg-white p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input name="collectPayment" type="checkbox" defaultChecked={meetingType?.collectPayment ?? false} />
            Collect payment
          </label>
          <label className="space-y-1.5 text-sm font-medium md:col-span-2">
            Price, dollars
            <input name="priceDollars" inputMode="decimal" defaultValue={dollars(meetingType?.priceCents ?? null)} placeholder="250" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
          </label>
        </div>
        <label className="space-y-1.5 text-sm font-medium">
          Stripe checkout link
          <input name="stripePaymentLink" type="url" defaultValue={meetingType?.stripePaymentLink ?? ""} placeholder="https://pay.stripe.com/..." className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
          <span className="block text-xs font-normal leading-5 text-[var(--ink-muted)]">Optional canonical checkout URL shown on paid public booking links.</span>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Confirmation message
          <textarea name="confirmationMessage" rows={2} defaultValue={meetingType?.confirmationMessage ?? ""} placeholder="Shown after a successful booking." className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input name="isActive" type="checkbox" defaultChecked={meetingType?.isActive ?? true} />
          Active booking link
        </label>
      </section>

      <button className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 transition">
        <Pencil className="h-4 w-4" />
        {meetingType ? "Save event type" : "Create event type"}
      </button>
    </form>
  );
}

export default async function SchedulerPage() {
  const data = await getSchedulerOverview();
  const availabilityByDay = new Map(data.availability.map((window) => [window.day, window]));
  const activeMeetingTypes = data.meetingTypes.filter((meetingType) => meetingType.isActive);
  const previewMeetingType = activeMeetingTypes[0] ?? data.meetingTypes[0];
  const selectedConflictCalendars = new Set((data.settings.googleCalendarIds || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean));
  const connectedCalendarAccounts = data.googleCalendarAccounts ?? [];
  const writableCalendars = data.googleCalendars.filter((calendar) => ["owner", "writer"].includes(calendar.accessRole));
  const isCalendarSelected = (connectionId: string, calendarId: string) => (
    selectedConflictCalendars.has(`${connectionId}::${calendarId}`) || selectedConflictCalendars.has(calendarId)
  );
  const defaultCreateCalendar = writableCalendars.find((calendar) => calendar.accountEmail === "hello@bythereeses.com" && calendar.id === "hello@bythereeses.com")
    ?? writableCalendars.find((calendar) => calendar.primary)
    ?? writableCalendars[0];
  const createCalendarValue = data.settings.googleCreateCalendarId?.includes("::")
    ? data.settings.googleCreateCalendarId
    : defaultCreateCalendar ? `${defaultCreateCalendar.connectionId}::${defaultCreateCalendar.id}` : (data.settings.googleCreateCalendarId ?? "hello@bythereeses.com");

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 sm:flex-row sm:items-end">
          <div>
            <h1 className="brand-page-title text-4xl">Scheduler</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">Event types, booking links, availability, Zoom details, and calendar sync.</p>
          </div>
          <Link href={previewMeetingType ? `/book/${previewMeetingType.slug}` : "/scheduler"} prefetch={false} className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 transition">
            <ExternalLink className="h-4 w-4" />
            Preview booking link
          </Link>
        </header>

        <section className="grid gap-4 lg:grid-cols-4">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <CalendarCheck className="h-4 w-4" />
              Google Calendar
            </div>
            <div className="mt-3 text-2xl font-semibold">{connectedCalendarAccounts.length ? "Connected" : "Needs setup"}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">
              {connectedCalendarAccounts.length ? `${connectedCalendarAccounts.length} account${connectedCalendarAccounts.length === 1 ? "" : "s"} connected` : `Missing ${data.google.missing.join(", ") || "credentials"}`}
            </p>
            {!connectedCalendarAccounts.length && (
              <Link href="/api/google/auth" prefetch={false} className="mt-4 inline-flex text-sm font-semibold underline">
                Start Google setup
              </Link>
            )}
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <LinkIcon className="h-4 w-4" />
              Active links
            </div>
            <div className="mt-3 text-2xl font-semibold">{activeMeetingTypes.length}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Each active event type has a public booking URL.</p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <Video className="h-4 w-4" />
              Zoom
            </div>
            <div className="mt-3 text-2xl font-semibold">{data.settings.zoomJoinUrl || data.meetingTypes.some((meetingType) => meetingType.zoomJoinUrl) ? "Linked" : "Manual link"}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Today-safe recurring links now, unique Zoom meetings later.</p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <ExternalLink className="h-4 w-4" />
              Alerts
            </div>
            <div className="mt-3 text-2xl font-semibold">Email first</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Resend confirmations are used when the API key is configured.</p>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1fr_430px]">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Event types</h2>
              <span className="text-xs text-[var(--ink-muted)]">Manage the booking links you send to people.</span>
            </div>
            <div className="mt-4 space-y-3">
              {data.meetingTypes.map((meetingType) => {
                const bookingUrl = getBookingUrl(meetingType.slug);
                return (
                  <details key={meetingType.id} className="group rounded-md border border-[var(--line)] bg-white open:bg-[#faf7f1]">
                    <summary className="grid cursor-pointer list-none gap-3 p-4 md:grid-cols-[1fr_170px_210px] md:items-center">
                      <div className="border-l-4 border-[var(--brand-brown)] pl-4">
                        <div className="flex items-center gap-2">
                          <div className="font-semibold">{meetingType.name}</div>
                          {meetingType.isActive ? (
                            <span className="rounded-full bg-[#efe7dc] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--brand-brown)]">Active</span>
                          ) : (
                            <span className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Paused</span>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-[var(--ink-muted)]">
                          {meetingType.durationMinutes} min · {meetingType.locationLabel || "Zoom"} · {meetingType.collectPayment ? `$${(meetingType.priceCents ?? 0) / 100}${meetingType.stripePaymentLink ? " · Checkout linked" : " · Checkout needed"}` : "No payment"}
                        </p>
                        <p className="mt-1 break-all text-xs text-[var(--ink-muted)]">{bookingUrl}</p>
                      </div>
                      <div className="text-sm text-[var(--ink-muted)]">Email confirmations</div>
                      <div className="flex gap-2">
                        <Link href={`/book/${meetingType.slug}`} prefetch={false} className="inline-flex flex-1 items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                          <Copy className="h-4 w-4" />
                          Open link
                        </Link>
                        <span className="inline-flex items-center justify-center rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold">
                          <Pencil className="h-4 w-4" />
                        </span>
                      </div>
                    </summary>
                    <div className="border-t border-[var(--line)] p-4">
                      <MeetingTypeForm meetingType={meetingType} />
                      <form action="/api/scheduler/meeting-types" method="post" className="mt-3">
                        <input type="hidden" name="_action" value="delete" />
                        <input type="hidden" name="meetingTypeId" value={meetingType.id} />
                        <button className="inline-flex items-center gap-2 rounded-sm border border-[var(--danger)] px-3 py-2 text-sm font-semibold text-[var(--danger)] transition hover:bg-[var(--danger)] hover:text-white">
                          <Trash2 className="h-4 w-4" />
                          Delete event type
                        </button>
                      </form>
                    </div>
                  </details>
                );
              })}
            </div>

            <details className="mt-5 rounded-md border border-[var(--line)] bg-[#faf7f1] p-4">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold">
                <Plus className="h-4 w-4" />
                Add event type
              </summary>
              <div className="mt-4">
                <MeetingTypeForm />
              </div>
            </details>
          </div>

          <form action="/api/scheduler/settings" method="post" className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Availability settings</h2>
            <div className="mt-4 space-y-4">
              <label className="space-y-1.5 text-sm font-medium">
                Timezone
                <input name="timezone" defaultValue={data.settings.timezone} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
              <div className="grid gap-2">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Weekly availability</div>
                <div className="grid gap-2">
                  {weekDays.map((day) => {
                    const window = availabilityByDay.get(day);
                    return (
                      <div key={day} className="grid gap-2 rounded-md border border-[var(--line)] bg-white p-3">
                        <label className="flex items-center gap-2 text-sm font-semibold">
                          <input name={`availabilityEnabled-${day}`} type="checkbox" defaultChecked={Boolean(window)} />
                          {dayLabels[day]}
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="space-y-1 text-xs font-medium text-[var(--ink-muted)]">
                            Start
                            <input name={`availabilityStart-${day}`} type="time" defaultValue={window?.start ?? "10:00"} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none" />
                          </label>
                          <label className="space-y-1 text-xs font-medium text-[var(--ink-muted)]">
                            End
                            <input name={`availabilityEnd-${day}`} type="time" defaultValue={window?.end ?? "16:00"} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none" />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1.5 text-sm font-medium">
                  Booking window
                  <input name="bookingWindowDays" inputMode="numeric" defaultValue={data.settings.bookingWindowDays} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Notice minutes
                  <input name="minimumNoticeMinutes" inputMode="numeric" defaultValue={data.settings.minimumNoticeMinutes} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
              </div>
              <div className="grid gap-3 rounded-md border border-[var(--line)] bg-white p-3">
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold">Calendars to check for conflicts</div>
                    <Link href="/api/google/auth" prefetch={false} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-xs font-semibold transition hover:border-[var(--foreground)]">
                      <Plus className="h-3.5 w-3.5" />
                      Connect calendar account
                    </Link>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
                    Connect each Google account you want checked. Then select the calendars inside that account that should prevent double bookings.
                  </p>
                </div>
                {connectedCalendarAccounts.length ? (
                  <div className="grid gap-3">
                    {connectedCalendarAccounts.map((account) => (
                      <div key={account.id} className="overflow-hidden rounded-md border border-[var(--line)]">
                        <div className="flex items-start justify-between gap-3 border-b border-[var(--line)] bg-[#faf7f1] px-3 py-3">
                          <div>
                            <div className="text-sm font-semibold">Google Calendar</div>
                            <div className="text-xs text-[var(--ink-muted)]">{account.email}</div>
                            <div className="mt-1 text-xs font-semibold text-[var(--brand-brown)]">
                              Checking {account.calendars.filter((calendar) => isCalendarSelected(account.id, calendar.id)).length} calendar{account.calendars.filter((calendar) => isCalendarSelected(account.id, calendar.id)).length === 1 ? "" : "s"}
                            </div>
                          </div>
                          <X className="mt-1 h-4 w-4 text-[var(--ink-muted)]" />
                        </div>
                        <div className="grid max-h-48 gap-1 overflow-y-auto p-2">
                          {account.calendars.map((calendar) => (
                            <label key={`${account.id}-${calendar.id}`} className="flex items-start gap-2 rounded-sm px-2 py-2 text-sm transition hover:bg-[#f4efe8]">
                              <input
                                name="googleCalendarIds"
                                type="checkbox"
                                value={`${account.id}::${calendar.id}`}
                                defaultChecked={isCalendarSelected(account.id, calendar.id)}
                                className="mt-1"
                              />
                              <span>
                                <span className="font-semibold">{calendar.summary}</span>
                                <span className="mt-0.5 block break-all text-xs text-[var(--ink-muted)]">
                                  {calendar.id}{calendar.primary ? " · Primary" : ""}
                                </span>
                              </span>
                            </label>
                          ))}
                          {!account.calendars.length && (
                            <p className="px-2 py-2 text-xs leading-5 text-[var(--ink-muted)]">No calendars were returned for this account.</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-sm border border-[var(--line)] bg-[#faf7f1] p-3 text-xs leading-5 text-[var(--ink-muted)]">
                    No calendar accounts are connected in the database yet. Use Connect calendar account to add each Google account you want checked.
                  </p>
                )}
              </div>
              <label className="space-y-1.5 text-sm font-medium">
                Calendar to create events on
                {writableCalendars.length ? (
                  <select name="googleCreateCalendarId" defaultValue={createCalendarValue} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                    {writableCalendars.map((calendar) => (
                      <option key={`${calendar.connectionId}-${calendar.id}`} value={`${calendar.connectionId}::${calendar.id}`}>
                        {calendar.summary}{calendar.primary ? " · Primary" : ""} · {calendar.accountEmail}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input name="googleCreateCalendarId" defaultValue={data.settings.googleCreateCalendarId ?? "hello@bythereeses.com"} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                )}
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Global recurring Zoom link
                <input name="zoomJoinUrl" defaultValue={data.settings.zoomJoinUrl ?? ""} placeholder="https://zoom.us/j/..." className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
              <p className="text-xs leading-5 text-[var(--ink-muted)]">
                Generated Zoom links need a Zoom app connection. This field gets the scheduler live today with a recurring link.
              </p>
              <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Save settings</button>
            </div>
          </form>
        </section>

        <section className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)] shadow-sm">
          <div className="grid grid-cols-[1fr_220px_160px] border-b border-[var(--line)] bg-[#eee8de] px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)] max-lg:hidden">
            <div>Booking</div>
            <div>Time</div>
            <div>Status</div>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {data.bookings.map((booking) => (
              <Link key={booking.id} href={`/scheduler/bookings/${booking.id}`} prefetch={false} className="grid gap-2 px-4 py-4 transition hover:bg-[#f6efe5] lg:grid-cols-[1fr_220px_160px] lg:items-center">
                <div>
                  <div className="font-semibold">{booking.attendeeName}</div>
                  <div className="mt-1 text-sm text-[var(--ink-muted)]">
                    {booking.attendeeEmail}
                  </div>
                </div>
                <div className="text-sm text-[var(--ink-muted)]">{formatDateTime(booking.startAt)}</div>
                <div className="text-sm capitalize text-[var(--ink-muted)]">{booking.status.replaceAll("_", " ")} · {booking.calendarSyncStatus.replaceAll("_", " ")}</div>
              </Link>
            ))}
            {!data.bookings.length && <div className="p-8 text-sm text-[var(--ink-muted)]">No bookings yet.</div>}
          </div>
        </section>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <DollarSign className="h-4 w-4" />
            Payment collection
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
            Event types can already mark payment as optional and store a price. The public payment block stays hidden until Stripe is connected and the event type has payment collection enabled.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
