import { db } from "@/db/client";
import { schedulerSettings } from "@/db/schema";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

const defaultAvailability = [
  { day: 2, start: "10:00", end: "16:00" },
  { day: 3, start: "10:00", end: "16:00" },
  { day: 4, start: "10:00", end: "16:00" },
];

function textValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function numberValue(formData: FormData, key: string, fallback: number) {
  const value = Number(textValue(formData, key));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function selectedCalendarIds(formData: FormData) {
  const selected = formData.getAll("googleCalendarIds")
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (selected.length) return selected.join(",");
  return null;
}

export async function POST(request: NextRequest) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const formData = await request.formData();
  const availability = [7, 1, 2, 3, 4, 5, 6].flatMap((day) => {
    if (formData.get(`availabilityEnabled-${day}`) !== "on") return [];
    const start = textValue(formData, `availabilityStart-${day}`) || "10:00";
    const end = textValue(formData, `availabilityEnd-${day}`) || "16:00";
    if (start >= end) return [];
    return [{ day, start, end }];
  });
  const now = new Date().toISOString();
  const values = {
    timezone: textValue(formData, "timezone") || "America/New_York",
    bookingWindowDays: numberValue(formData, "bookingWindowDays", 30),
    minimumNoticeMinutes: numberValue(formData, "minimumNoticeMinutes", 240),
    availabilityJson: JSON.stringify(availability.length ? availability : defaultAvailability),
    googleCalendarIds: selectedCalendarIds(formData),
    googleCreateCalendarId: textValue(formData, "googleCreateCalendarId") || "hello@bythereeses.com",
    zoomJoinUrl: textValue(formData, "zoomJoinUrl") || null,
    updatedAt: now,
  };

  const existing = await db.query.schedulerSettings.findFirst({
    where: eq(schedulerSettings.id, "default"),
  });

  if (existing) {
    await db.update(schedulerSettings).set(values).where(eq(schedulerSettings.id, "default"));
  } else {
    await db.insert(schedulerSettings).values({
      id: "default",
      ...values,
      createdAt: now,
    });
  }

  revalidatePath("/scheduler");
  return NextResponse.redirect(new URL("/scheduler?saved=settings", request.url), 303);
}
