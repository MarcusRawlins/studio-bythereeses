import { createSchedulerBookingFromForm } from "@/lib/scheduler";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const { bookingId, meetingTypeSlug } = await createSchedulerBookingFromForm(formData);
    return NextResponse.redirect(new URL(`/book/${meetingTypeSlug}/confirmed?booking=${bookingId}`, request.url), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Booking could not be created.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
