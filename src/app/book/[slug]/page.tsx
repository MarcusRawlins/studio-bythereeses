import {
  getBookingCalendarAvailability,
  getMeetingTypeBySlug,
  parseInviteeQuestions,
} from "@/lib/scheduler";
import { CalendarDays, Check, Clock, Mail, MapPin, Phone, User, Video } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const meetingType = await getMeetingTypeBySlug(slug);

  return {
    title: meetingType ? `${meetingType.name} | The Reeses Schedule` : "The Reeses Schedule",
    description: "Book a call with Alex & Tyler.",
  };
}

function formatDateLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function formatFullDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function formatMonth(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function addMonths(value: string, amount: number) {
  const anchor = new Date(`${value}T12:00:00`);
  return new Date(anchor.getFullYear(), anchor.getMonth() + amount, 1).toISOString().slice(0, 10);
}

function formatSlot(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function priceLabel(cents: number | null) {
  if (!cents) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function InstagramGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="4.5" />
      <circle cx="12" cy="12" r="3.25" />
      <circle cx="16.9" cy="7.1" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

function monthCalendarCells(monthDate: string, availableDates: string[]) {
  const available = new Set(availableDates);
  const anchor = new Date(`${monthDate}T12:00:00`);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const cells: Array<{ date: string | null; day: number | null; available: boolean }> = [];

  for (let i = 0; i < first.getDay(); i += 1) {
    cells.push({ date: null, day: null, available: false });
  }

  for (let day = 1; day <= last.getDate(); day += 1) {
    const date = new Date(year, month, day);
    const key = date.toISOString().slice(0, 10);
    cells.push({ date: key, day, available: available.has(key) });
  }

  return cells;
}

export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ date?: string; start?: string; end?: string; project?: string; month?: string; reschedule?: string }>;
}) {
  const { slug } = await params;
  const query = searchParams ? await searchParams : {};
  const availability = await getBookingCalendarAvailability(slug, query.date, query.month);
  const meetingType = availability?.meetingType;
  if (!meetingType || !meetingType.isActive) notFound();

  const settings = availability.settings;
  const timeZone = settings.timezone;
  const dates = availability.dates;
  const monthDate = availability.monthDate;
  const selectedDate = availability.selectedDate;
  const slots = availability.slots;
  const selectedStart = query.start;
  const selectedEnd = query.end;
  const projectContext = query.project ?? "";
  const rescheduleToken = query.reschedule ?? "";
  const stickyQuery = [
    projectContext ? `project=${encodeURIComponent(projectContext)}` : null,
    rescheduleToken ? `reschedule=${encodeURIComponent(rescheduleToken)}` : null,
  ].filter(Boolean).join("&");
  const questions = parseInviteeQuestions(meetingType.inviteeQuestionsJson);
  const price = meetingType.collectPayment ? priceLabel(meetingType.priceCents) : null;
  const calendarCells = monthDate ? monthCalendarCells(monthDate, dates) : [];
  const previousMonth = monthDate ? addMonths(monthDate, -1) : "";
  const nextMonth = monthDate ? addMonths(monthDate, 1) : "";

  return (
    <main className="min-h-screen bg-[#f6f3ee] px-4 py-6 text-[var(--foreground)] sm:py-10">
      <header className="mx-auto mb-6 flex max-w-6xl justify-center">
        <Image src="/brand/alex-tyler-logo.png" alt="Alex & Tyler" width={250} height={90} priority className="h-auto w-56" />
      </header>

      <div className="mx-auto grid max-w-6xl overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)] shadow-sm lg:grid-cols-[360px_1fr]">
        <aside className="border-b border-[var(--line)] lg:border-b-0 lg:border-r">
          <div className="space-y-6 px-8 py-7">
            <div>
              <h1 className="font-['Copperplate_CC'] text-xl font-semibold uppercase leading-snug tracking-[0.08em]">{meetingType.name}</h1>
            </div>

            <div className="space-y-3 text-sm text-[var(--ink-muted)]">
              <div className="flex items-center gap-3">
                <Clock className="h-5 w-5" />
                <span>{meetingType.durationMinutes} minutes</span>
              </div>
              <div className="flex items-center gap-3">
                {meetingType.locationType === "phone" ? (
                  <Phone className="h-5 w-5" />
                ) : meetingType.locationType === "in_person" ? (
                  <MapPin className="h-5 w-5" />
                ) : (
                  <Video className="h-5 w-5" />
                )}
                <span>{meetingType.locationLabel || "Zoom"}</span>
              </div>
              {price && (
                <div className="flex items-center gap-3">
                  <Check className="h-5 w-5" />
                  <span>{price} USD</span>
                </div>
              )}
              {selectedStart && selectedEnd && (
                <div className="flex items-start gap-3">
                  <CalendarDays className="mt-0.5 h-5 w-5" />
                  <span>
                    {formatSlot(selectedStart, timeZone)} - {formatSlot(selectedEnd, timeZone)}, {selectedDate ? formatFullDate(selectedDate) : ""}
                  </span>
                </div>
              )}
            </div>

            <p className="text-sm leading-6 text-[var(--foreground)]">{meetingType.description}</p>
            {meetingType.collectPayment && (
              <p className="rounded-md border border-[var(--line)] bg-[#faf7f1] p-3 text-xs leading-5 text-[var(--ink-muted)]">
                Payment collection is enabled for this event type, but Stripe checkout is not connected yet. Scheduling will stay available without taking payment until Stripe is live.
              </p>
            )}
          </div>
        </aside>

        <section className="min-h-[660px] px-7 py-8 sm:px-10">
          {!selectedStart && (
            <div className="grid gap-8 xl:grid-cols-[1fr_270px]">
              <div>
                <h2 className="text-xl font-semibold">Select a Date & Time</h2>
                <div className="mt-8 flex items-center justify-between">
                  <Link href={`/book/${slug}?month=${previousMonth}${stickyQuery ? `&${stickyQuery}` : ""}`} prefetch={false} className="rounded-full border border-[var(--line)] px-3 py-1 text-sm font-semibold transition hover:border-[var(--brand-brown)]">
                    Prev
                  </Link>
                  <div className="text-base font-semibold">{monthDate ? formatMonth(monthDate) : "Available dates"}</div>
                  <Link href={`/book/${slug}?month=${nextMonth}${stickyQuery ? `&${stickyQuery}` : ""}`} prefetch={false} className="rounded-full border border-[var(--line)] px-3 py-1 text-sm font-semibold transition hover:border-[var(--brand-brown)]">
                    Next
                  </Link>
                </div>
                <div className="mt-2 text-right text-xs text-[var(--ink-muted)]">Eastern Time</div>
                <div className="mt-5 grid grid-cols-7 gap-1 text-center text-xs font-semibold uppercase text-[var(--ink-muted)]">
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <div key={day}>{day}</div>)}
                </div>
                <div className="mt-3 grid grid-cols-7 gap-1.5">
                  {calendarCells.map((cell, index) => {
                    if (!cell.date) return <div key={`blank-${index}`} className="aspect-square" />;
                    if (!cell.available) {
                      return (
                        <div key={cell.date} className="flex aspect-square items-center justify-center rounded-full text-sm text-[var(--ink-muted)] opacity-35">
                          {cell.day}
                        </div>
                      );
                    }

                    return (
                      <Link
                        key={cell.date}
                        href={`/book/${slug}?date=${cell.date}${stickyQuery ? `&${stickyQuery}` : ""}`}
                        prefetch={false}
                        aria-label={formatDateLabel(cell.date)}
                        className={`flex aspect-square items-center justify-center rounded-full border text-sm font-semibold transition ${cell.date === selectedDate ? "border-[var(--brand-brown)] bg-[var(--brand-brown)] text-white" : "border-transparent bg-[#f1ece5] text-[var(--foreground)] hover:border-[var(--brand-brown)]"}`}
                      >
                        {cell.day}
                      </Link>
                    );
                  })}
                </div>
              </div>

              {selectedDate && (
                <div>
                  <h3 className="text-base font-semibold">{formatFullDate(selectedDate)}</h3>
                  <div className="mt-5 grid max-h-[560px] gap-2 overflow-y-auto pr-1">
                    {slots.map((slot) => (
                      <Link
                        key={slot.startAt}
                        href={`/book/${slug}?date=${selectedDate}&start=${encodeURIComponent(slot.startAt)}&end=${encodeURIComponent(slot.endAt)}${stickyQuery ? `&${stickyQuery}` : ""}`}
                        prefetch={false}
                        className="rounded-md border border-[var(--brand-brown)] px-4 py-3 text-center text-sm font-semibold text-[var(--brand-brown)] transition hover:bg-[#efe7dc] hover:text-[var(--foreground)]"
                      >
                        {slot.label}
                      </Link>
                    ))}
                    {!slots.length && <p className="text-sm text-[var(--ink-muted)]">No times available for this date.</p>}
                  </div>
                </div>
              )}
            </div>
          )}

          {selectedStart && selectedEnd && (
            <div className="mx-auto max-w-xl">
              <Link href={`/book/${slug}?date=${selectedDate}${stickyQuery ? `&${stickyQuery}` : ""}`} prefetch={false} className="mb-6 inline-flex rounded-full border border-[var(--line)] px-3 py-2 text-sm font-semibold">
                Back
              </Link>
              <h2 className="text-xl font-semibold">Enter Details</h2>
              {rescheduleToken && (
                <p className="mt-2 rounded-md border border-[var(--line)] bg-[#faf7f1] p-3 text-sm text-[var(--ink-muted)]">
                  This will create the new time first, then cancel the old booking.
                </p>
              )}
              <form action="/api/scheduler/bookings" method="post" className="mt-5 grid gap-4">
                <input type="hidden" name="meetingTypeId" value={meetingType.id} />
                <input type="hidden" name="meetingTypeSlug" value={meetingType.slug} />
                <input type="hidden" name="projectContext" value={projectContext} />
                <input type="hidden" name="rescheduleToken" value={rescheduleToken} />
                <input type="hidden" name="startAt" value={selectedStart} />
                <input type="hidden" name="endAt" value={selectedEnd} />
                <label className="space-y-1.5 text-sm font-medium">
                  <span className="inline-flex items-center gap-2"><User className="h-3.5 w-3.5" /> Name *</span>
                  <input name="attendeeName" required className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  <span className="inline-flex items-center gap-2"><Mail className="h-3.5 w-3.5" /> Email *</span>
                  <input name="attendeeEmail" required type="email" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Phone
                  <input name="attendeePhone" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                {questions.map((question) => (
                  <div key={question.id} className="space-y-1.5 text-sm font-medium">
                    <div>{question.label}{question.required ? " *" : ""}</div>
                    {question.type === "textarea" && (
                      <textarea name={`question_${question.id}`} required={question.required} rows={3} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                    )}
                    {question.type === "text" && (
                      <input name={`question_${question.id}`} required={question.required} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                    )}
                    {question.type === "select" && (
                      <select name={`question_${question.id}`} required={question.required} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                        <option value="">Select one</option>
                        {(question.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                      </select>
                    )}
                    {(question.type === "radio" || question.type === "checkbox") && (
                      <div className="grid gap-2 rounded-md border border-[var(--line)] bg-[#faf7f1] p-3">
                        {(question.options ?? []).map((option) => (
                          <label key={option} className="flex items-center gap-2 text-sm">
                            <input name={`question_${question.id}`} type={question.type} value={option} required={question.required && question.type === "radio"} />
                            {option}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                <label className="space-y-1.5 text-sm font-medium">
                  Anything else we should know?
                  <textarea name="notes" rows={3} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                {meetingType.collectPayment && (
                  <div className="rounded-md border border-[var(--line)] bg-[#faf7f1] p-4 text-sm leading-6">
                    Payment collection is enabled for this event type. Stripe checkout will appear here once payment processing is connected.
                  </div>
                )}
                <button className="brand-primary-button rounded-sm px-4 py-3 transition">Schedule Event</button>
              </form>
            </div>
          )}
        </section>
      </div>
      <footer className="mx-auto mt-5 flex max-w-6xl flex-wrap items-center justify-between gap-3 text-sm text-[var(--ink-muted)]">
        <Link href="https://bythereeses.com" prefetch={false} aria-label="The Reeses website">
          <Image src="/brand/at-badge-dark.png" alt="Alex & Tyler" width={44} height={56} className="h-11 w-auto" />
        </Link>
        <div className="flex flex-wrap gap-3">
          <Link href="mailto:hello@bythereeses.com" prefetch={false} aria-label="Email The Reeses" className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--line)] transition hover:border-[var(--brand-brown)] hover:bg-[#efe7dc] hover:text-[var(--foreground)]">
            <Mail className="h-4 w-4" />
          </Link>
          <Link href="https://www.instagram.com/bythereeses" prefetch={false} aria-label="The Reeses Instagram" className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--line)] transition hover:border-[var(--brand-brown)] hover:bg-[#efe7dc] hover:text-[var(--foreground)]">
            <InstagramGlyph className="h-4 w-4" />
          </Link>
        </div>
      </footer>
    </main>
  );
}
