import { getBookingById, getBookingManageUrls, getMeetingTypeBySlug, getSchedulerSettings } from "@/lib/scheduler";
import { CalendarDays, CheckCircle2, Clock, Mail, Video } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const meetingType = await getMeetingTypeBySlug(slug);

  return {
    title: meetingType ? `Confirmed: ${meetingType.name} | The Reeses Schedule` : "Confirmed | The Reeses Schedule",
    description: "Your call with Alex & Tyler is confirmed.",
  };
}

function formatDateTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export default async function BookingConfirmedPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ booking?: string }>;
}) {
  const { slug } = await params;
  const query = searchParams ? await searchParams : {};
  const meetingType = await getMeetingTypeBySlug(slug);
  if (!meetingType) notFound();
  const booking = query.booking ? await getBookingById(query.booking) : null;
  const settings = await getSchedulerSettings();
  const timeZone = settings?.timezone ?? "America/New_York";
  const manageUrls = booking ? getBookingManageUrls(meetingType.slug, booking) : null;

  return (
    <main className="min-h-screen bg-[#f6f3ee] px-5 py-10 text-[var(--foreground)]">
      <div className="mx-auto max-w-2xl rounded-md border border-[var(--line)] bg-[var(--surface)] p-8 text-center shadow-sm">
        <Image src="/brand/alex-tyler-logo.png" alt="Alex & Tyler" width={230} height={82} priority className="mx-auto h-auto w-52" />
        <CheckCircle2 className="mx-auto mt-8 h-10 w-10 text-[var(--brand-brown)]" />
        <h1 className="brand-page-title mt-5 text-4xl">Confirmed</h1>
        <p className="mx-auto mt-4 max-w-lg text-sm leading-6 text-[var(--ink-muted)]">
          {meetingType.confirmationMessage || `Your ${meetingType.name.toLowerCase()} is on the calendar.`}
        </p>

        {booking && (
          <div className="mx-auto mt-7 grid max-w-md gap-3 rounded-md border border-[var(--line)] bg-[#faf7f1] p-5 text-left text-sm">
            <div className="flex items-center gap-3">
              <CalendarDays className="h-4 w-4 text-[var(--ink-muted)]" />
              <span>{formatDateTime(booking.startAt, timeZone)}</span>
            </div>
            <div className="flex items-center gap-3">
              <Clock className="h-4 w-4 text-[var(--ink-muted)]" />
              <span>{meetingType.durationMinutes} minutes</span>
            </div>
            <div className="flex items-center gap-3">
              <Video className="h-4 w-4 text-[var(--ink-muted)]" />
              <span>{meetingType.locationLabel || "Zoom"}</span>
            </div>
            <div className="flex items-center gap-3">
              <Mail className="h-4 w-4 text-[var(--ink-muted)]" />
              <span>{booking.attendeeEmail}</span>
            </div>
          </div>
        )}

        <p className="mx-auto mt-6 max-w-lg text-xs leading-5 text-[var(--ink-muted)]">
          A confirmation email is on its way. You can reschedule or cancel from this page if your plans change.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {manageUrls && (
            <>
              <Link href={manageUrls.rescheduleUrl} className="inline-flex rounded-sm border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--foreground)]">
                Reschedule
              </Link>
              <Link href={manageUrls.manageUrl} className="inline-flex rounded-sm border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--foreground)]">
                Cancel
              </Link>
            </>
          )}
          <Link href={`/book/${meetingType.slug}`} className="inline-flex rounded-sm border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--foreground)]">
            Book another time
          </Link>
        </div>
      </div>
    </main>
  );
}
