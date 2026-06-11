import { db } from "@/db/client";
import { schedulerMeetingTypes } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import type { InviteeQuestion, InviteeQuestionType } from "@/lib/scheduler-types";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

function textValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function numberValue(formData: FormData, key: string, fallback: number) {
  const value = Number(textValue(formData, key));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function safeRevalidatePath(path: string) {
  try {
    revalidatePath(path);
  } catch (error) {
    if (error instanceof Error && error.message.includes("static generation store missing")) return;
    throw error;
  }
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const reservedInviteeQuestionLabels = new Set(["name", "your name", "email", "email address"]);

function questionsFromForm(formData: FormData) {
  const ids = formData.getAll("questionId").map((value) => String(value).trim());
  const labels = formData.getAll("questionLabel").map((value) => String(value).trim());
  const types = formData.getAll("questionType").map((value) => String(value).trim() as InviteeQuestionType);
  const options = formData.getAll("questionOptions").map((value) => String(value).split("\n").map((option) => option.trim()).filter(Boolean));

  return labels.map((label, index) => ({
    id: ids[index] || slugify(label) || `question_${index + 1}`,
    label,
    type: types[index] || "textarea",
    required: false,
    options: options[index] ?? [],
  } satisfies InviteeQuestion)).filter((question) => (
    question.label && !reservedInviteeQuestionLabels.has(question.label.trim().toLowerCase())
  ));
}

function meetingTypeValues(formData: FormData) {
  return {
    slug: slugify(textValue(formData, "slug") || textValue(formData, "name")),
    name: textValue(formData, "name"),
    description: textValue(formData, "description") || null,
    durationMinutes: numberValue(formData, "durationMinutes", 30),
    bufferMinutes: numberValue(formData, "bufferMinutes", 15),
    locationType: textValue(formData, "locationType") || "zoom",
    locationLabel: textValue(formData, "locationLabel") || "Zoom",
    zoomJoinUrl: textValue(formData, "zoomJoinUrl") || null,
    inviteeQuestionsJson: JSON.stringify(questionsFromForm(formData)),
    collectPayment: formData.get("collectPayment") === "on",
    priceCents: formData.get("collectPayment") === "on" ? Math.round(numberValue(formData, "priceDollars", 0) * 100) : null,
    stripePaymentLink: formData.get("collectPayment") === "on" ? textValue(formData, "stripePaymentLink") || null : null,
    smsOptInEnabled: false,
    confirmationMessage: textValue(formData, "confirmationMessage") || null,
    isActive: formData.get("isActive") === "on",
    updatedAt: new Date().toISOString(),
  };
}

export async function POST(request: NextRequest) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const formData = await request.formData();
  const action = textValue(formData, "_action");
  const id = textValue(formData, "meetingTypeId");

  if (action === "delete") {
    if (!id) return NextResponse.json({ error: "Meeting type is required." }, { status: 400 });
    await db.delete(schedulerMeetingTypes).where(eq(schedulerMeetingTypes.id, id));
    await logActivity({ action: "scheduler.meeting_type_deleted", metadata: { id } });
    safeRevalidatePath("/scheduler");
    return NextResponse.redirect(new URL("/scheduler?saved=meeting-type", request.url), 303);
  }

  const values = meetingTypeValues(formData);
  if (!values.name || !values.slug) {
    return NextResponse.json({ error: "Meeting type name is required." }, { status: 400 });
  }

  if (action === "update") {
    if (!id) return NextResponse.json({ error: "Meeting type is required." }, { status: 400 });
    await db.update(schedulerMeetingTypes).set(values).where(eq(schedulerMeetingTypes.id, id));
    await logActivity({ action: "scheduler.meeting_type_updated", metadata: { id, name: values.name, slug: values.slug } });
    safeRevalidatePath("/scheduler");
    safeRevalidatePath(`/book/${values.slug}`);
    return NextResponse.redirect(new URL("/scheduler?saved=meeting-type", request.url), 303);
  }

  await db.insert(schedulerMeetingTypes).values({
    id: crypto.randomUUID(),
    ...values,
    createdAt: new Date().toISOString(),
  });
  await logActivity({ action: "scheduler.meeting_type_created", metadata: { name: values.name, slug: values.slug } });
  safeRevalidatePath("/scheduler");
  return NextResponse.redirect(new URL("/scheduler?saved=meeting-type", request.url), 303);
}
