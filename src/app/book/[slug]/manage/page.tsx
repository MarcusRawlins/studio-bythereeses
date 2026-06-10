import { cancelSchedulerBookingAction, getManagedBooking } from "@/lib/scheduler";
import { CalendarDays, CheckCircle2, Clock, Mail, Video } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export default async function ManageBookingPage({
  searchParams,
}: {
  searchParams?: Promise<{ token?: string; cancelled?: string }>;
}) {
  const query = searchParams ? await searchParams : {};
  const data = await getManagedBooking(query.token);
  if (!data || !data.meetingType || !data.urls) notFound();
  const isCancelled = data.booking.status === "cancelled" || query.cancelled === "1";

  return (
    <main className="min-h-screen bg-[#f6f3ee] px-5 py-10 text-[var(--foreground)]">
      <div className="mx-auto max-w-2xl rounded-md border border-[var(--line)] bg-[var(--surface)] p-8 shadow-sm">
        <Link href="https://bythereeses.com" prefetch={false} aria-label="The Reeses website" className="block text-center">
          <span className="studio-caps block text-[0.62rem] text-[var(--ink-muted)]">The Reeses</span>
          <span className="font-serif text-3xl leading-none text-[var(--foreground)]">Studio</span>
        </Link>
        <div className="mt-8 text-center">
          {isCancelled && <CheckCircle2 className="mx-auto h-10 w-10 text-[var(--brand-brown)]" />}
          <h1 className="brand-page-title mt-5 text-4xl">{isCancelled ? "Cancelled" : "Manage Booking"}</h1>
          <p className="mx-auto mt-4 max-w-lg text-sm leading-6 text-[var(--ink-muted)]">
            {isCancelled ? "This booking has been cancelled." : "Need to move or cancel your time? You can do that here."}
          </p>
        </div>

        <div className="mx-auto mt-7 grid max-w-md gap-3 rounded-md border border-[var(--line)] bg-[#faf7f1] p-5 text-left text-sm">
          <div className="flex items-center gap-3">
            <CalendarDays className="h-4 w-4 text-[var(--ink-muted)]" />
            <span>{formatDateTime(data.booking.startAt)}</span>
          </div>
          <div className="flex items-center gap-3">
            <Clock className="h-4 w-4 text-[var(--ink-muted)]" />
            <span>{data.meetingType.durationMinutes} minutes</span>
          </div>
          <div className="flex items-center gap-3">
            <Video className="h-4 w-4 text-[var(--ink-muted)]" />
            <span>{data.meetingType.locationLabel || "Zoom"}</span>
          </div>
          <div className="flex items-center gap-3">
            <Mail className="h-4 w-4 text-[var(--ink-muted)]" />
            <span>{data.booking.attendeeEmail}</span>
          </div>
        </div>

        {!isCancelled && (
          <div className="mx-auto mt-7 grid max-w-md gap-3">
            <Link href={data.urls.rescheduleUrl} className="brand-primary-button rounded-sm px-4 py-3 text-center transition">
              Reschedule
            </Link>
            <form action={cancelSchedulerBookingAction} className="grid gap-3 rounded-md border border-[var(--line)] p-4">
              <input type="hidden" name="token" value={query.token ?? ""} />
              <label className="space-y-1.5 text-sm font-medium">
                Cancellation note
                <textarea name="reason" rows={3} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
              <button className="rounded-sm border border-[var(--danger)] px-4 py-2.5 text-sm font-semibold text-[var(--danger)] transition hover:bg-[var(--danger)] hover:text-white">
                Cancel booking
              </button>
            </form>
          </div>
        )}
      </div>
    </main>
  );
}
