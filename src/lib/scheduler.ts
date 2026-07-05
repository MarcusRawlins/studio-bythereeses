import { db } from "@/db/client";
import { clients, invoicePayments, projectParticipants, projects, schedulerBookings, schedulerMeetingTypes, schedulerSettings } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { sendBookingCancellationEmail, sendBookingEmails, sendBookingReminderEmail } from "@/lib/email";
import { createGoogleCalendarEvent, deleteGoogleCalendarEvent, getConnectedGoogleAccounts, getGoogleBusyTimes, getGoogleCalendarList, getGoogleCalendarStatus } from "@/lib/google-calendar";
import { publicScheduleBaseUrl } from "@/lib/public-urls";
import type { InviteeQuestion, InviteeQuestionType } from "@/lib/scheduler-types";
import { addDaysToDateKey, dateKeyInTimeZone, dayBoundsInTimeZone, dayNumberForDateKey, formatTimeInTimeZone, zonedTimeToUtc } from "@/lib/timezone";
import { and, asc, desc, eq, gte, lt, lte } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

type AvailabilityWindow = {
  day: number;
  start: string;
  end: string;
};

export type SchedulerSlot = {
  startAt: string;
  endAt: string;
  label: string;
};

type BusyTime = {
  start: Date;
  end: Date;
};

export type SchedulerBookingPaymentInput = {
  status?: string | null;
  paymentMethod?: string | null;
  paidAmountCents?: number | null;
  paidAt?: string | null;
  clientFeeCents?: number | null;
  processingFeeCents?: number | null;
  grossCollectedCents?: number | null;
  netDepositCents?: number | null;
  externalPaymentId?: string | null;
  notes?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

type SlotMeetingType = {
  durationMinutes: number;
  bufferMinutes: number;
};

type SlotSettings = {
  timezone: string;
  minimumNoticeMinutes: number;
};

type StudioSchedulerMeetingTypeOptions = {
  projectId?: string | null;
  clientId?: string | null;
  includeInactive?: boolean;
};

const defaultAvailability: AvailabilityWindow[] = [
  { day: 2, start: "10:00", end: "16:00" },
  { day: 3, start: "10:00", end: "16:00" },
  { day: 4, start: "10:00", end: "16:00" },
];

const defaultQuestion: InviteeQuestion = {
  id: "conversation_goal",
  label: "What would you like to talk through on this call?",
  type: "textarea",
  required: false,
};

const defaultCardFeePercentBps = 290;
const defaultCardFeeFixedCents = 30;

const reservedInviteeQuestionLabels = new Set(["name", "your name", "email", "email address"]);

function sanitizeInviteeQuestions(questions: InviteeQuestion[]) {
  return questions
    .filter((question) => question.label && !reservedInviteeQuestionLabels.has(question.label.trim().toLowerCase()))
    .map((question) => ({ ...question, required: false }));
}

const defaultMeetingTypes = [
  {
    id: "meeting-discovery-call",
    slug: "wedding-photography-discovery-call",
    name: "Wedding Photography Discovery Call",
    description: "A relaxed intro call to talk through your wedding, your priorities, and whether The Reeses is the right fit.",
    durationMinutes: 45,
    bufferMinutes: 15,
    confirmationMessage: "You are on the calendar. We will talk through your wedding, answer questions, and make sure you know the next step.",
  },
  {
    id: "meeting-planning-call",
    slug: "wedding-photography-vision-and-timeline-call",
    name: "Wedding Photography Vision & Timeline Call",
    description: "A deeper planning call for wedding vision, timeline shape, locations, family priorities, and logistics.",
    durationMinutes: 60,
    bufferMinutes: 15,
    confirmationMessage: "You are on the calendar. Bring any timeline thoughts, location notes, and questions you want to work through together.",
  },
] as const;

function parseAvailability(value: string | null | undefined) {
  if (!value) return defaultAvailability;
  try {
    const parsed = JSON.parse(value) as AvailabilityWindow[];
    return parsed.length ? parsed : defaultAvailability;
  } catch {
    return defaultAvailability;
  }
}

export function parseInviteeQuestions(value: string | null | undefined): InviteeQuestion[] {
  if (!value) return [defaultQuestion];
  try {
    const parsed = JSON.parse(value) as InviteeQuestion[];
    const sanitized = sanitizeInviteeQuestions(parsed);
    return sanitized.length ? sanitized : [defaultQuestion];
  } catch {
    return [defaultQuestion];
  }
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function overlaps(startA: Date, endA: Date, startB: Date, endB: Date) {
  return startA < endB && endA > startB;
}

function calendarIdsToCheck(value: string | null | undefined) {
  const google = getGoogleCalendarStatus();
  return (value || google.calendarIds || "hello@bythereeses.com")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function buildSlotsForDate({
  date,
  availability,
  meetingType,
  settings,
  busyTimes,
  minimumStart,
}: {
  date: string;
  availability: AvailabilityWindow[];
  meetingType: SlotMeetingType;
  settings: SlotSettings;
  busyTimes: BusyTime[];
  minimumStart: Date;
}) {
  const day = dayNumberForDateKey(date);
  const windows = availability.filter((window) => window.day === day);
  const slots: SchedulerSlot[] = [];

  for (const window of windows) {
    let cursor = zonedTimeToUtc(date, window.start, settings.timezone);
    const windowEnd = zonedTimeToUtc(date, window.end, settings.timezone);

    while (addMinutes(cursor, meetingType.durationMinutes) <= windowEnd) {
      const startAt = cursor;
      const endAt = addMinutes(cursor, meetingType.durationMinutes);
      const startWithBuffer = addMinutes(startAt, -meetingType.bufferMinutes);
      const endWithBuffer = addMinutes(endAt, meetingType.bufferMinutes);
      const hasConflict = busyTimes.some((busy) => overlaps(startWithBuffer, endWithBuffer, busy.start, busy.end));

      if (startAt > minimumStart && !hasConflict) {
        slots.push({
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          label: formatTimeInTimeZone(startAt, settings.timezone),
        });
      }

      cursor = addMinutes(cursor, 30);
    }
  }

  return slots;
}

function buildCandidateDates(settings: { timezone: string; bookingWindowDays: number }, availability: AvailabilityWindow[]) {
  const availableDays = new Set(availability.map((window) => window.day));
  const candidateDates: string[] = [];
  const today = dateKeyInTimeZone(new Date(), settings.timezone);

  for (let offset = 1; offset <= settings.bookingWindowDays; offset += 1) {
    const date = addDaysToDateKey(today, offset);
    const day = dayNumberForDateKey(date);
    if (availableDays.has(day)) candidateDates.push(date);
  }

  return candidateDates;
}

async function getBusyTimesForRange({
  settings,
  rangeStart,
  rangeEnd,
  bypassGoogleCache,
}: {
  settings: { googleCalendarIds: string | null; timezone: string };
  rangeStart: Date;
  rangeEnd: Date;
  bypassGoogleCache?: boolean;
}) {
  const localBookings = await db.query.schedulerBookings.findMany({
    where: and(
      gte(schedulerBookings.startAt, rangeStart.toISOString()),
      lt(schedulerBookings.startAt, rangeEnd.toISOString()),
    ),
  });
  const localBusy = localBookings.map((booking) => ({
    start: new Date(booking.startAt),
    end: new Date(booking.endAt),
  })).filter((_, index) => localBookings[index].status === "confirmed");

  const google = getGoogleCalendarStatus();
  const googleBusy = google.connected
    ? await getGoogleBusyTimes(rangeStart, rangeEnd, calendarIdsToCheck(settings.googleCalendarIds), { bypassCache: bypassGoogleCache })
    : [];

  return [...localBusy, ...googleBusy];
}

function normalizeEmail(value: FormDataEntryValue | null) {
  return String(value ?? "").trim().toLowerCase();
}

function textValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

// Length caps for the public, unauthenticated booking endpoint, mirroring the
// public questionnaire response route so a single request cannot store an
// unbounded payload.
const MAX_ATTENDEE_NAME_LENGTH = 200;
const MAX_ATTENDEE_EMAIL_LENGTH = 320;
const MAX_ATTENDEE_PHONE_LENGTH = 50;
const MAX_BOOKING_NOTES_LENGTH = 5000;
const MAX_INVITEE_ANSWER_LENGTH = 5000;
const MAX_SERIALIZED_INVITEE_ANSWERS_LENGTH = 100000;

function numberValue(formData: FormData, key: string, fallback: number) {
  const value = Number(textValue(formData, key));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function formCents(formData: FormData, key: string) {
  const number = Number(String(formData.get(key) ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number * 100);
}

function cleanText(value: string | null | undefined) {
  return value?.trim() || null;
}

function requireTylerApprovalForAgentSchedulerPayment(message: string): never {
  throw new Error(message);
}

function positiveCents(value: number | null | undefined, fallback = 0) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.round(Number(value)) : fallback;
}

function calculateCardFeeAmountCents(subtotalCents: number) {
  if (subtotalCents <= 0) return 0;
  return Math.round(subtotalCents * (defaultCardFeePercentBps / 10000)) + defaultCardFeeFixedCents;
}

function schedulerPaymentLedgerAmounts(input: SchedulerBookingPaymentInput) {
  const status = cleanText(input.status) ?? "paid";
  const paymentMethod = cleanText(input.paymentMethod);
  const paidAmountCents = status === "paid" ? positiveCents(input.paidAmountCents) : 0;
  const isCardPayment = paymentMethod === "stripe" || paymentMethod === "credit_card";
  const defaultProcessingFeeCents = isCardPayment ? calculateCardFeeAmountCents(paidAmountCents) : 0;
  const processingFeeCents = status === "paid" ? positiveCents(input.processingFeeCents, defaultProcessingFeeCents) : 0;
  const clientFeeCents = status === "paid" ? positiveCents(input.clientFeeCents, isCardPayment ? processingFeeCents : 0) : 0;
  const grossCollectedCents = status === "paid" ? positiveCents(input.grossCollectedCents, paidAmountCents + clientFeeCents) : 0;
  const netDepositCents = status === "paid" ? positiveCents(input.netDepositCents, Math.max(grossCollectedCents - processingFeeCents, 0)) : 0;

  return {
    status,
    paymentMethod,
    paidAmountCents,
    clientFeeCents,
    processingFeeCents,
    grossCollectedCents,
    netDepositCents,
  };
}

type SchedulerPaymentActivityOptions = {
  action: string;
  actorType: "admin" | "client" | "system" | "agent";
  actorName: string;
  sourceType?: string | null;
  sourceId?: string | null;
  preserveExistingSource?: boolean;
};

async function assertSchedulerPaymentProjectSource(projectId: string | null, sourceType: string | null, sourceId: string | null) {
  if (!sourceType && sourceId) {
    throw new Error("Scheduler booking payment source links require sourceType when sourceId is set.");
  }
  if (sourceType !== "project_source") return;
  if (!projectId) {
    throw new Error("Project is required for project source links.");
  }
  if (!sourceId) {
    throw new Error("Project source id is required.");
  }

  const source = await db.query.projectSources.findFirst({
    where: (row, { and, eq }) => and(eq(row.id, sourceId), eq(row.projectId, projectId)),
  });
  if (!source) {
    throw new Error("Project source not found for this project.");
  }
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

export function getBookingUrl(slug: string) {
  return `${publicScheduleBaseUrl().replace(/\/$/, "")}/book/${slug}`;
}

type ProjectBookingContext = {
  projectId: string;
  clientId?: string | null;
  expiresAt: string;
};

function schedulerLinkSecret() {
  const configured = process.env.SCHEDULER_LINK_SECRET || process.env.AUTH_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SCHEDULER_LINK_SECRET (or AUTH_SECRET) must be set in production.");
  }
  return "local-development-scheduler-link-secret";
}

function base64UrlEncode(value: string) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(payload: string) {
  return createHmac("sha256", schedulerLinkSecret()).update(payload).digest("base64url");
}

function createProjectBookingContext(projectId: string, clientId?: string | null) {
  const payload = base64UrlEncode(JSON.stringify({
    projectId,
    clientId: clientId || null,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(),
  } satisfies ProjectBookingContext));
  return `${payload}.${signPayload(payload)}`;
}

function verifyProjectBookingContext(token: string | null | undefined): ProjectBookingContext | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = signPayload(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const context = JSON.parse(base64UrlDecode(payload)) as ProjectBookingContext;
    if (!context.projectId || new Date(context.expiresAt) < new Date()) return null;
    return context;
  } catch {
    return null;
  }
}

type BookingManageContext = {
  bookingId: string;
  attendeeEmail: string;
  expiresAt: string;
};

function createBookingManageToken(booking: { id: string; attendeeEmail: string }) {
  const payload = base64UrlEncode(JSON.stringify({
    bookingId: booking.id,
    attendeeEmail: booking.attendeeEmail,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(),
  } satisfies BookingManageContext));
  return `${payload}.${signPayload(payload)}`;
}

async function verifyBookingManageToken(token: string | null | undefined) {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = signPayload(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const context = JSON.parse(base64UrlDecode(payload)) as BookingManageContext;
    if (!context.bookingId || new Date(context.expiresAt) < new Date()) return null;
    const booking = await getBookingById(context.bookingId);
    if (!booking || booking.attendeeEmail !== context.attendeeEmail) return null;
    return booking;
  } catch {
    return null;
  }
}

export function getProjectBookingUrl(slug: string, projectId: string, clientId?: string | null) {
  const token = createProjectBookingContext(projectId, clientId);
  return `${getBookingUrl(slug)}?project=${encodeURIComponent(token)}`;
}

export function getBookingManageUrls(slug: string, booking: { id: string; attendeeEmail: string }) {
  const token = createBookingManageToken(booking);
  const base = getBookingUrl(slug);
  return {
    manageUrl: `${base}/manage?token=${encodeURIComponent(token)}`,
    rescheduleUrl: `${base}?reschedule=${encodeURIComponent(token)}`,
  };
}

function questionsFromForm(formData: FormData) {
  const ids = formData.getAll("questionId").map((value) => String(value).trim());
  const labels = formData.getAll("questionLabel").map((value) => String(value).trim());
  const types = formData.getAll("questionType").map((value) => String(value).trim() as InviteeQuestionType);
  const options = formData.getAll("questionOptions").map((value) => String(value).split("\n").map((option) => option.trim()).filter(Boolean));
  const requiredIds = new Set(formData.getAll("questionRequired").map((value) => String(value)));

  return sanitizeInviteeQuestions(labels.map((label, index) => ({
    id: ids[index] || slugify(label) || `question_${index + 1}`,
    label,
    type: types[index] || "textarea",
    required: requiredIds.has(ids[index]),
    options: options[index] ?? [],
  })).filter((question) => question.label));
}

function answersFromForm(formData: FormData, questions: InviteeQuestion[]) {
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    if (question.type === "checkbox") {
      answers[question.id] = formData.getAll(`question_${question.id}`).map((value) => String(value));
    } else {
      answers[question.id] = textValue(formData, `question_${question.id}`);
    }
  }
  return answers;
}

async function findOrCreateSchedulerClient(name: string, email: string, phone: string | null) {
  const existing = await db.query.clients.findFirst({
    where: eq(clients.email, email),
  });
  if (existing) {
    // Public, unauthenticated booking must not overwrite an existing client's
    // contact facts. Only fill the phone when the record has none yet.
    if (!existing.phone && phone) {
      await db.update(clients).set({
        phone,
        updatedAt: new Date().toISOString(),
      }).where(eq(clients.id, existing.id));
    }
    return existing.id;
  }

  const [firstName, ...rest] = name.trim().split(/\s+/);
  const clientId = crypto.randomUUID();
  await db.insert(clients).values({
    id: clientId,
    firstName: firstName || name,
    lastName: rest.join(" ") || null,
    email,
    phone,
    preferredName: firstName || name,
    notes: "Created from scheduler booking.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return clientId;
}

async function linkSchedulerClientToProject(projectId: string | null, clientId: string) {
  if (!projectId) return null;

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) return null;

  const existing = await db.query.projectParticipants.findFirst({
    where: and(
      eq(projectParticipants.projectId, projectId),
      eq(projectParticipants.clientId, clientId),
    ),
  });
  if (!existing) {
    const existingPrimary = await db.query.projectParticipants.findFirst({
      where: and(
        eq(projectParticipants.projectId, projectId),
        eq(projectParticipants.isPrimaryContact, true),
      ),
    });
    await db.insert(projectParticipants).values({
      id: crypto.randomUUID(),
      projectId,
      clientId,
      role: existingPrimary ? "scheduler" : "primary",
      isPrimaryContact: !existingPrimary,
      createdAt: new Date().toISOString(),
    });
  }

  return projectId;
}

export async function ensureSchedulerDefaults() {
  const now = new Date().toISOString();
  const settings = await db.query.schedulerSettings.findFirst({
    where: eq(schedulerSettings.id, "default"),
  });

  if (!settings) {
    await db.insert(schedulerSettings).values({
      id: "default",
      timezone: "America/New_York",
      bookingWindowDays: 30,
      minimumNoticeMinutes: 240,
      availabilityJson: JSON.stringify(defaultAvailability),
      googleCalendarIds: "hello@bythereeses.com",
      googleCreateCalendarId: "hello@bythereeses.com",
      createdAt: now,
      updatedAt: now,
    });
  }

  const meetingTypes = await db.query.schedulerMeetingTypes.findMany();
  if (!meetingTypes.length) {
    await db.insert(schedulerMeetingTypes).values(defaultMeetingTypes.map((meetingType) => ({
      ...meetingType,
      locationType: "zoom",
      locationLabel: "Zoom",
      inviteeQuestionsJson: JSON.stringify([defaultQuestion]),
      collectPayment: false,
      stripePaymentLink: null,
      smsOptInEnabled: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })));
  } else {
    const existingIds = new Set(meetingTypes.map((meetingType) => meetingType.id));
    for (const meetingType of defaultMeetingTypes) {
      if (!existingIds.has(meetingType.id)) {
        await db.insert(schedulerMeetingTypes).values({
          ...meetingType,
          locationType: "zoom",
          locationLabel: "Zoom",
          inviteeQuestionsJson: JSON.stringify([defaultQuestion]),
          collectPayment: false,
          stripePaymentLink: null,
          smsOptInEnabled: false,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }
}

export async function getSchedulerOverview() {
  await ensureSchedulerDefaults();
  const [settings, meetingTypes, bookings] = await Promise.all([
    db.query.schedulerSettings.findFirst({ where: eq(schedulerSettings.id, "default") }),
    db.query.schedulerMeetingTypes.findMany({ orderBy: asc(schedulerMeetingTypes.createdAt) }),
    db.query.schedulerBookings.findMany({ orderBy: desc(schedulerBookings.startAt), limit: 8 }),
  ]);
  const google = getGoogleCalendarStatus();
  const googleCalendarAccounts = await getConnectedGoogleAccounts();
  const googleCalendars = googleCalendarAccounts.length
    ? googleCalendarAccounts.flatMap((account) => account.calendars)
    : google.connected ? await getGoogleCalendarList() : [];

  return {
    settings: settings!,
    meetingTypes,
    bookings,
    google,
    googleCalendarAccounts,
    googleCalendars,
    availability: parseAvailability(settings?.availabilityJson),
  };
}

export async function getSchedulerSettings() {
  await ensureSchedulerDefaults();
  const settings = await db.query.schedulerSettings.findFirst({
    where: eq(schedulerSettings.id, "default"),
  });
  return settings;
}

export async function listProjectBookingLinks(projectId: string, clientId?: string | null) {
  await ensureSchedulerDefaults();
  const meetingTypes = await db.query.schedulerMeetingTypes.findMany({
    where: eq(schedulerMeetingTypes.isActive, true),
    orderBy: asc(schedulerMeetingTypes.createdAt),
  });

  return meetingTypes.map((meetingType) => ({
    meetingType,
    url: getProjectBookingUrl(meetingType.slug, projectId, clientId),
  }));
}

export async function listStudioSchedulerMeetingTypes({
  projectId,
  clientId,
  includeInactive = false,
}: StudioSchedulerMeetingTypeOptions = {}) {
  await ensureSchedulerDefaults();
  const normalizedProjectId = projectId?.trim() || null;
  const normalizedClientId = clientId?.trim() || null;

  if (normalizedProjectId) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, normalizedProjectId) });
    if (!project) throw new Error("Project not found.");
  }
  if (normalizedClientId) {
    const client = await db.query.clients.findFirst({ where: eq(clients.id, normalizedClientId) });
    if (!client) throw new Error("Client not found.");
    if (!normalizedProjectId) throw new Error("Scheduler client links require a project.");
    const participant = await db.query.projectParticipants.findFirst({
      where: and(eq(projectParticipants.projectId, normalizedProjectId), eq(projectParticipants.clientId, normalizedClientId)),
    });
    if (!participant) throw new Error("Scheduler client is not linked to this project.");
  }

  const meetingTypes = await db.query.schedulerMeetingTypes.findMany({
    where: includeInactive ? undefined : eq(schedulerMeetingTypes.isActive, true),
    orderBy: asc(schedulerMeetingTypes.createdAt),
  });

  return meetingTypes.map((meetingType) => ({
    id: meetingType.id,
    slug: meetingType.slug,
    name: meetingType.name,
    description: meetingType.description,
    durationMinutes: meetingType.durationMinutes,
    bufferMinutes: meetingType.bufferMinutes,
    locationType: meetingType.locationType,
    locationLabel: meetingType.locationLabel,
    collectPayment: meetingType.collectPayment,
    priceCents: meetingType.priceCents,
    stripePaymentLink: meetingType.stripePaymentLink,
    isActive: meetingType.isActive,
    confirmationMessage: meetingType.confirmationMessage,
    inviteeQuestions: parseInviteeQuestions(meetingType.inviteeQuestionsJson),
    bookingUrl: getBookingUrl(meetingType.slug),
    projectBookingUrl: normalizedProjectId ? getProjectBookingUrl(meetingType.slug, normalizedProjectId, normalizedClientId) : null,
    updatedAt: meetingType.updatedAt,
  }));
}

export async function getBookingById(id: string) {
  await ensureSchedulerDefaults();
  return db.query.schedulerBookings.findFirst({
    where: eq(schedulerBookings.id, id),
  });
}

export async function getMeetingTypeBySlug(slug: string) {
  await ensureSchedulerDefaults();
  return db.query.schedulerMeetingTypes.findFirst({
    where: eq(schedulerMeetingTypes.slug, slug),
  });
}

export async function getBookingCalendarAvailability(slug: string, preferredDate?: string, preferredMonth?: string) {
  const [settings, meetingType] = await Promise.all([
    db.query.schedulerSettings.findFirst({ where: eq(schedulerSettings.id, "default") }),
    getMeetingTypeBySlug(slug),
  ]);
  if (!settings || !meetingType) return null;

  const availability = parseAvailability(settings.availabilityJson);
  const candidateDates = buildCandidateDates(settings, availability);

  if (!candidateDates.length) {
    return {
      settings,
      meetingType,
      dates: [],
      monthDate: preferredMonth || preferredDate || "",
      selectedDate: undefined,
      slots: [],
    };
  }

  const { start: rangeStart } = dayBoundsInTimeZone(candidateDates[0], settings.timezone);
  const { end: rangeEnd } = dayBoundsInTimeZone(candidateDates[candidateDates.length - 1], settings.timezone);
  const busyTimes = await getBusyTimesForRange({ settings, rangeStart, rangeEnd });
  const minimumStart = addMinutes(new Date(), settings.minimumNoticeMinutes);
  const dates = candidateDates.filter((date) => buildSlotsForDate({
    date,
    availability,
    meetingType,
    settings,
    busyTimes,
    minimumStart,
  }).length > 0);
  const monthDate = preferredMonth || preferredDate || dates[0] || "";
  const selectedDate = preferredDate || (monthDate ? dates.find((date) => date.slice(0, 7) === monthDate.slice(0, 7)) : undefined) || dates[0];
  const selectedDay = selectedDate ? dayNumberForDateKey(selectedDate) : null;
  const selectedAvailability = selectedDay ? availability.filter((window) => window.day === selectedDay) : [];
  const slots = selectedDate ? buildSlotsForDate({
    date: selectedDate,
    availability: selectedAvailability,
    meetingType,
    settings,
    busyTimes,
    minimumStart,
  }) : [];

  return { settings, meetingType, dates, monthDate, selectedDate, slots };
}

export async function getAvailableBookingDates(slug: string) {
  const [settings, meetingType] = await Promise.all([
    db.query.schedulerSettings.findFirst({ where: eq(schedulerSettings.id, "default") }),
    getMeetingTypeBySlug(slug),
  ]);
  if (!settings || !meetingType) return [];

  const availability = parseAvailability(settings.availabilityJson);
  const candidateDates = buildCandidateDates(settings, availability);

  if (!candidateDates.length) return [];

  const { start: rangeStart } = dayBoundsInTimeZone(candidateDates[0], settings.timezone);
  const { end: rangeEnd } = dayBoundsInTimeZone(candidateDates[candidateDates.length - 1], settings.timezone);
  const busyTimes = await getBusyTimesForRange({ settings, rangeStart, rangeEnd });
  const minimumStart = addMinutes(new Date(), settings.minimumNoticeMinutes);

  return candidateDates.filter((date) => buildSlotsForDate({
    date,
    availability,
    meetingType,
    settings,
    busyTimes,
    minimumStart,
  }).length > 0);
}

export async function getAvailableSlots(slug: string, date: string, options?: { bypassGoogleCache?: boolean }): Promise<SchedulerSlot[]> {
  const [settings, meetingType] = await Promise.all([
    db.query.schedulerSettings.findFirst({ where: eq(schedulerSettings.id, "default") }),
    getMeetingTypeBySlug(slug),
  ]);
  if (!settings || !meetingType) return [];

  const day = dayNumberForDateKey(date);
  const availability = parseAvailability(settings.availabilityJson).filter((window) => window.day === day);
  if (!availability.length) return [];

  const { start: dayStart, end: dayEnd } = dayBoundsInTimeZone(date, settings.timezone);
  const busyTimes = await getBusyTimesForRange({
    settings,
    rangeStart: dayStart,
    rangeEnd: dayEnd,
    bypassGoogleCache: options?.bypassGoogleCache,
  });
  const minimumStart = addMinutes(new Date(), settings.minimumNoticeMinutes);

  return buildSlotsForDate({
    date,
    availability,
    meetingType,
    settings,
    busyTimes,
    minimumStart,
  });
}

export async function createSchedulerBookingFromForm(formData: FormData) {
  const meetingTypeId = textValue(formData, "meetingTypeId");
  const meetingTypeSlug = textValue(formData, "meetingTypeSlug");
  const attendeeName = textValue(formData, "attendeeName");
  const attendeeEmail = normalizeEmail(formData.get("attendeeEmail"));
  const attendeePhone = textValue(formData, "attendeePhone") || null;
  const startAt = textValue(formData, "startAt");
  const endAt = textValue(formData, "endAt");
  const notes = textValue(formData, "notes") || null;
  const projectContext = verifyProjectBookingContext(textValue(formData, "projectContext"));
  const rescheduledFromBooking = await verifyBookingManageToken(textValue(formData, "rescheduleToken"));
  if (!meetingTypeId || !attendeeName || !attendeeEmail || !startAt || !endAt) {
    throw new Error("Meeting type, name, email, and time are required.");
  }
  if (
    attendeeName.length > MAX_ATTENDEE_NAME_LENGTH ||
    attendeeEmail.length > MAX_ATTENDEE_EMAIL_LENGTH ||
    (attendeePhone && attendeePhone.length > MAX_ATTENDEE_PHONE_LENGTH) ||
    (notes && notes.length > MAX_BOOKING_NOTES_LENGTH)
  ) {
    throw new Error("One or more booking fields are too long.");
  }

  const [settings, meetingType] = await Promise.all([
    db.query.schedulerSettings.findFirst({ where: eq(schedulerSettings.id, "default") }),
    db.query.schedulerMeetingTypes.findFirst({ where: eq(schedulerMeetingTypes.id, meetingTypeId) }),
  ]);
  if (!settings || !meetingType) throw new Error("Scheduler is not configured.");
  if (!meetingType.isActive) throw new Error("This meeting type is no longer available for booking.");
  const inviteeQuestions = parseInviteeQuestions(meetingType.inviteeQuestionsJson);
  const inviteeAnswers = answersFromForm(formData, inviteeQuestions);
  for (const answer of Object.values(inviteeAnswers)) {
    const tooLong = Array.isArray(answer)
      ? answer.some((entry) => entry.length > MAX_INVITEE_ANSWER_LENGTH)
      : answer.length > MAX_INVITEE_ANSWER_LENGTH;
    if (tooLong) throw new Error("One or more answers are too long.");
  }
  if (JSON.stringify(inviteeAnswers).length > MAX_SERIALIZED_INVITEE_ANSWERS_LENGTH) {
    throw new Error("Submitted answers are too large.");
  }
  const zoomJoinUrl = meetingType.zoomJoinUrl || settings.zoomJoinUrl;
  const selectedDate = dateKeyInTimeZone(new Date(startAt), settings.timezone);
  const availableSlots = await getAvailableSlots(meetingType.slug, selectedDate, { bypassGoogleCache: true });
  const stillAvailable = availableSlots.some((slot) => slot.startAt === startAt && slot.endAt === endAt);
  if (!stillAvailable) {
    throw new Error("That time is no longer available. Please choose another time.");
  }
  const clientId = await findOrCreateSchedulerClient(attendeeName, attendeeEmail, attendeePhone);
  const projectId = await linkSchedulerClientToProject(projectContext?.projectId ?? null, clientId);

  let googleEventId: string | null = null;
  let calendarSyncStatus = "local_only";
  try {
    googleEventId = await createGoogleCalendarEvent({
      summary: `${meetingType.name} with ${attendeeName}`,
      description: [
        notes,
        Object.entries(inviteeAnswers)
          .filter(([, answer]) => Array.isArray(answer) ? answer.length : answer)
          .map(([id, answer]) => {
            const label = inviteeQuestions.find((question) => question.id === id)?.label ?? id;
            return `${label}: ${Array.isArray(answer) ? answer.join(", ") : answer}`;
          })
          .join("\n"),
      ].filter(Boolean).join("\n\n") || undefined,
      attendeeEmail,
      attendeeName,
      startAt: new Date(startAt),
      endAt: new Date(endAt),
      timezone: settings.timezone,
      calendarId: settings.googleCreateCalendarId || "hello@bythereeses.com",
      zoomJoinUrl,
    });
    calendarSyncStatus = googleEventId ? "synced" : "local_only";
  } catch (error) {
    calendarSyncStatus = "sync_failed";
    await logActivity({
      action: "scheduler.google_calendar_create_failed",
      projectId,
      clientId,
      metadata: {
        meetingType: meetingType.name,
        attendeeEmail,
        startAt,
        error: error instanceof Error ? error.message : "Unknown Google Calendar error",
      },
    });
  }
  const bookingId = crypto.randomUUID();

  await db.insert(schedulerBookings).values({
    id: bookingId,
    meetingTypeId,
    projectId,
    clientId,
    attendeeName,
    attendeeEmail,
    attendeePhone,
    smsOptIn: false,
    inviteeAnswersJson: JSON.stringify(inviteeAnswers),
    startAt,
    endAt,
    notes,
    status: "confirmed",
    googleCalendarEventId: googleEventId,
    googleCalendarId: settings.googleCreateCalendarId || "hello@bythereeses.com",
    calendarSyncStatus,
    rescheduledFromBookingId: rescheduledFromBooking?.id ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const booking = await db.query.schedulerBookings.findFirst({
    where: eq(schedulerBookings.id, bookingId),
  });
  if (rescheduledFromBooking) {
    await cancelBookingRecord(rescheduledFromBooking, "Rescheduled by client.", false);
  }
  if (booking) {
    await sendBookingEmails({ booking, meetingType, ...getBookingManageUrls(meetingType.slug, booking) });
  }

  await logActivity({
    action: "scheduler.booking_created",
    projectId,
    clientId,
    metadata: { meetingType: meetingType.name, attendeeEmail, startAt, calendarSyncStatus },
  });

  revalidatePath("/scheduler");
  if (projectId) revalidatePath(`/projects/${projectId}`);
  return { bookingId, meetingTypeSlug };
}

export async function createSchedulerBookingAction(formData: FormData) {
  "use server";

  const { bookingId, meetingTypeSlug } = await createSchedulerBookingFromForm(formData);
  redirect(`/book/${meetingTypeSlug}/confirmed?booking=${bookingId}`);
}

async function cancelBookingRecord(booking: Awaited<ReturnType<typeof getBookingById>>, reason: string | null, sendEmail = true) {
  if (!booking || booking.status === "cancelled") return null;
  const meetingType = await db.query.schedulerMeetingTypes.findFirst({
    where: eq(schedulerMeetingTypes.id, booking.meetingTypeId),
  });
  await deleteGoogleCalendarEvent({
    calendarId: booking.googleCalendarId,
    eventId: booking.googleCalendarEventId,
  });
  const now = new Date().toISOString();
  await db.update(schedulerBookings).set({
    status: "cancelled",
    cancelledAt: now,
    cancellationReason: reason,
    calendarSyncStatus: booking.googleCalendarEventId ? "cancelled" : booking.calendarSyncStatus,
    updatedAt: now,
  }).where(eq(schedulerBookings.id, booking.id));

  const updated = await getBookingById(booking.id);
  if (sendEmail && updated && meetingType) {
    await sendBookingCancellationEmail({ booking: updated, meetingType });
  }
  await logActivity({
    action: "scheduler.booking_cancelled",
    projectId: booking.projectId,
    clientId: booking.clientId,
    metadata: { bookingId: booking.id, reason },
  });
  return updated;
}

export async function cancelSchedulerBookingAction(formData: FormData) {
  "use server";

  const token = textValue(formData, "token");
  const reason = textValue(formData, "reason") || null;
  const booking = await verifyBookingManageToken(token);
  if (!booking) throw new Error("Booking link is invalid or expired.");
  const meetingType = await db.query.schedulerMeetingTypes.findFirst({
    where: eq(schedulerMeetingTypes.id, booking.meetingTypeId),
  });
  await cancelBookingRecord(booking, reason);
  revalidatePath("/scheduler");
  if (booking.projectId) revalidatePath(`/projects/${booking.projectId}`);
  redirect(`/book/${meetingType?.slug ?? "wedding-photography-discovery-call"}/manage?token=${encodeURIComponent(token)}&cancelled=1`);
}

export async function getManagedBooking(token: string | null | undefined) {
  const booking = await verifyBookingManageToken(token);
  if (!booking) return null;
  const meetingType = await db.query.schedulerMeetingTypes.findFirst({
    where: eq(schedulerMeetingTypes.id, booking.meetingTypeId),
  });
  return {
    booking,
    meetingType,
    urls: meetingType ? getBookingManageUrls(meetingType.slug, booking) : null,
  };
}

export async function getSchedulerBookingDetail(id: string) {
  await ensureSchedulerDefaults();
  const booking = await getBookingById(id);
  if (!booking) return null;
  const [meetingType, client, project, allProjects] = await Promise.all([
    db.query.schedulerMeetingTypes.findFirst({ where: eq(schedulerMeetingTypes.id, booking.meetingTypeId) }),
    booking.clientId ? db.query.clients.findFirst({ where: eq(clients.id, booking.clientId) }) : null,
    booking.projectId ? db.query.projects.findFirst({ where: eq(projects.id, booking.projectId) }) : null,
    db.query.projects.findMany({ orderBy: desc(projects.createdAt) }),
  ]);

  return { booking, meetingType, client, project, allProjects };
}

export async function recordSchedulerBookingPaymentFromAgent(bookingId: string, input: SchedulerBookingPaymentInput) {
  return requireTylerApprovalForAgentSchedulerPayment("Payments require Tyler approval before creation or changes. Agents may draft payment reconciliation recommendations as tasks, but cannot record scheduler payments directly.");
}

export async function updateSchedulerBookingPaymentFromAgent(bookingId: string, input: SchedulerBookingPaymentInput) {
  return requireTylerApprovalForAgentSchedulerPayment("Payments require Tyler approval before creation or changes. Agents may draft payment reconciliation recommendations as tasks, but cannot update scheduler payments directly.");
}

async function recordSchedulerBookingPayment(
  bookingId: string,
  input: SchedulerBookingPaymentInput,
  activityOptions: SchedulerPaymentActivityOptions,
) {
  const booking = await db.query.schedulerBookings.findFirst({
    where: eq(schedulerBookings.id, bookingId),
  });
  if (!booking) throw new Error("Booking not found.");

  const meetingType = await db.query.schedulerMeetingTypes.findFirst({
    where: eq(schedulerMeetingTypes.id, booking.meetingTypeId),
  });
  if (!meetingType) throw new Error("Meeting type not found.");

  const ledgerAmounts = schedulerPaymentLedgerAmounts(input);
  const paidAt = ledgerAmounts.status === "paid" ? cleanText(input.paidAt) ?? new Date().toISOString() : null;
  const now = new Date().toISOString();
  const paymentLink = booking.paymentLink ?? meetingType.stripePaymentLink ?? null;
  const externalPaymentId = cleanText(input.externalPaymentId);
  const notes = cleanText(input.notes);
  const paymentSourceType = cleanText(input.sourceType)
    ?? cleanText(activityOptions.sourceType)
    ?? (activityOptions.preserveExistingSource ? booking.paymentSourceType : null);
  const paymentSourceId = cleanText(input.sourceId)
    ?? cleanText(activityOptions.sourceId)
    ?? (activityOptions.preserveExistingSource ? booking.paymentSourceId : null);
  await assertSchedulerPaymentProjectSource(booking.projectId, paymentSourceType, paymentSourceId);
  if (externalPaymentId) {
    const existingExternalPayment = await db.query.schedulerBookings.findFirst({
      where: eq(schedulerBookings.externalPaymentId, externalPaymentId),
    });
    if (existingExternalPayment && existingExternalPayment.id !== booking.id) {
      throw new Error("External payment is already linked to another scheduler booking.");
    }
    const existingInvoicePayment = await db.query.invoicePayments.findFirst({
      where: eq(invoicePayments.externalPaymentId, externalPaymentId),
    });
    if (existingInvoicePayment) {
      throw new Error("External payment is already linked to an invoice payment.");
    }
  }

  await db.update(schedulerBookings).set({
    paymentStatus: ledgerAmounts.status,
    paymentMethod: ledgerAmounts.paymentMethod,
    paidAt,
    paidAmountCents: ledgerAmounts.paidAmountCents,
    clientFeeCents: ledgerAmounts.clientFeeCents,
    processingFeeCents: ledgerAmounts.processingFeeCents,
    grossCollectedCents: ledgerAmounts.grossCollectedCents,
    netDepositCents: ledgerAmounts.netDepositCents,
    externalPaymentId,
    paymentLink,
    paymentNotes: notes,
    paymentSourceType,
    paymentSourceId,
    updatedAt: now,
  }).where(eq(schedulerBookings.id, booking.id));

  await logActivity({
    action: activityOptions.action,
    projectId: booking.projectId,
    clientId: booking.clientId,
    actorType: activityOptions.actorType,
    actorName: activityOptions.actorName,
    metadata: {
      bookingId: booking.id,
      meetingTypeId: booking.meetingTypeId,
      status: ledgerAmounts.status,
      paymentMethod: ledgerAmounts.paymentMethod,
      paidAt,
      paidAmountCents: ledgerAmounts.paidAmountCents,
      clientFeeCents: ledgerAmounts.clientFeeCents,
      processingFeeCents: ledgerAmounts.processingFeeCents,
      grossCollectedCents: ledgerAmounts.grossCollectedCents,
      netDepositCents: ledgerAmounts.netDepositCents,
      externalPaymentId,
      sourceType: paymentSourceType,
      sourceId: paymentSourceId,
    },
  });

  safeRevalidatePath("/scheduler");
  safeRevalidatePath(`/scheduler/bookings/${booking.id}`);
  if (booking.projectId) safeRevalidatePath(`/projects/${booking.projectId}`);

  return {
    bookingId: booking.id,
    projectId: booking.projectId,
    clientId: booking.clientId,
    status: ledgerAmounts.status,
    paymentMethod: ledgerAmounts.paymentMethod,
    paidAt,
    paidAmountCents: ledgerAmounts.paidAmountCents,
    clientFeeCents: ledgerAmounts.clientFeeCents,
    processingFeeCents: ledgerAmounts.processingFeeCents,
    grossCollectedCents: ledgerAmounts.grossCollectedCents,
    netDepositCents: ledgerAmounts.netDepositCents,
    externalPaymentId,
    paymentLink,
    paymentSourceType,
    paymentSourceId,
  };
}

export async function recordSchedulerBookingPaymentFromForm(formData: FormData) {
  const bookingId = textValue(formData, "bookingId");
  if (!bookingId) throw new Error("Booking is required.");

  return recordSchedulerBookingPayment(
    bookingId,
    {
      status: textValue(formData, "status") || "unpaid",
      paymentMethod: textValue(formData, "paymentMethod") || null,
      paidAmountCents: formCents(formData, "paidAmount"),
      paidAt: textValue(formData, "paidAt") || null,
      externalPaymentId: textValue(formData, "externalPaymentId") || null,
      notes: textValue(formData, "notes") || null,
    },
    {
      action: "scheduler.booking_payment_recorded",
      actorType: "admin",
      actorName: "The Reeses Studio",
      sourceType: "admin_booking_payment_form",
      sourceId: bookingId,
    },
  );
}

export async function recordSchedulerBookingPaymentAction(formData: FormData) {
  "use server";

  const { bookingId } = await recordSchedulerBookingPaymentFromForm(formData);
  redirect(`/scheduler/bookings/${bookingId}#payment-${encodeURIComponent(bookingId)}`);
}

export async function linkBookingToProjectAction(formData: FormData) {
  "use server";

  const bookingId = textValue(formData, "bookingId");
  const projectId = textValue(formData, "projectId");
  const booking = await getBookingById(bookingId);
  if (!booking || !projectId) throw new Error("Booking and project are required.");
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) throw new Error("Project not found.");
  if (booking.clientId) await linkSchedulerClientToProject(projectId, booking.clientId);
  await db.update(schedulerBookings).set({
    projectId,
    updatedAt: new Date().toISOString(),
  }).where(eq(schedulerBookings.id, bookingId));
  await logActivity({
    action: "scheduler.booking_linked_to_project",
    projectId,
    clientId: booking.clientId,
    metadata: { bookingId },
  });
  safeRevalidatePath("/scheduler");
  safeRevalidatePath(`/scheduler/bookings/${bookingId}`);
  safeRevalidatePath(`/projects/${projectId}`);
  redirect(`/scheduler/bookings/${bookingId}`);
}

export async function createProjectFromBookingAction(formData: FormData) {
  "use server";

  const bookingId = textValue(formData, "bookingId");
  const projectName = textValue(formData, "projectName");
  const booking = await getBookingById(bookingId);
  if (!booking || !booking.clientId || !projectName) throw new Error("Booking, client, and project name are required.");
  const now = new Date().toISOString();
  const projectId = crypto.randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: projectName,
    type: "wedding",
    stage: "inquiry",
    status: "active",
    notes: `Created from scheduler booking on ${new Date(booking.startAt).toLocaleString("en-US", { timeZone: "America/New_York" })}.`,
    createdAt: now,
    updatedAt: now,
  });
  await linkSchedulerClientToProject(projectId, booking.clientId);
  await db.update(schedulerBookings).set({
    projectId,
    updatedAt: now,
  }).where(eq(schedulerBookings.id, booking.id));
  await logActivity({
    action: "project.created_from_scheduler_booking",
    projectId,
    clientId: booking.clientId,
    metadata: { bookingId },
  });
  revalidatePath("/scheduler");
  redirect(`/projects/${projectId}`);
}

export async function sendDueSchedulerReminders(now = new Date()) {
  await ensureSchedulerDefaults();
  const windowEnd = addMinutes(now, 24 * 60);
  const bookings = await db.query.schedulerBookings.findMany({
    where: and(
      eq(schedulerBookings.status, "confirmed"),
      gte(schedulerBookings.startAt, now.toISOString()),
      lte(schedulerBookings.startAt, windowEnd.toISOString()),
    ),
    orderBy: asc(schedulerBookings.startAt),
    limit: 25,
  });

  let sent = 0;
  for (const booking of bookings.filter((item) => !item.reminderSentAt)) {
    const meetingType = await db.query.schedulerMeetingTypes.findFirst({
      where: eq(schedulerMeetingTypes.id, booking.meetingTypeId),
    });
    if (!meetingType) continue;
    const emailed = await sendBookingReminderEmail({ booking, meetingType, ...getBookingManageUrls(meetingType.slug, booking) });
    if (!emailed) continue;
    await db.update(schedulerBookings).set({
      reminderSentAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }).where(eq(schedulerBookings.id, booking.id));
    sent += 1;
  }

  return { checked: bookings.length, sent };
}

export async function updateSchedulerSettingsAction(formData: FormData) {
  "use server";

  const availability = [7, 1, 2, 3, 4, 5, 6].flatMap((day) => {
    if (formData.get(`availabilityEnabled-${day}`) !== "on") return [];
    const start = textValue(formData, `availabilityStart-${day}`) || "10:00";
    const end = textValue(formData, `availabilityEnd-${day}`) || "16:00";
    if (start >= end) return [];
    return [{ day, start, end }];
  });
  const availabilityJson = JSON.stringify(availability.length ? availability : defaultAvailability);

  const now = new Date().toISOString();
  const values = {
    timezone: textValue(formData, "timezone") || "America/New_York",
    bookingWindowDays: Number(textValue(formData, "bookingWindowDays")) || 30,
    minimumNoticeMinutes: Number(textValue(formData, "minimumNoticeMinutes")) || 240,
    availabilityJson,
    googleCalendarIds: textValue(formData, "googleCalendarIds") || null,
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
  redirect("/scheduler");
}

export async function createMeetingTypeAction(formData: FormData) {
  "use server";

  const name = textValue(formData, "name");
  if (!name) throw new Error("Meeting type name is required.");

  const now = new Date().toISOString();
  const providedSlug = slugify(textValue(formData, "slug"));
  const slug = providedSlug || slugify(name);

  await db.insert(schedulerMeetingTypes).values({
    id: crypto.randomUUID(),
    slug,
    name,
    description: textValue(formData, "description") || null,
    durationMinutes: Number(textValue(formData, "durationMinutes")) || 30,
    bufferMinutes: Number(textValue(formData, "bufferMinutes")) || 15,
    locationType: textValue(formData, "locationType") || "zoom",
    locationLabel: textValue(formData, "locationLabel") || "Zoom",
    zoomJoinUrl: textValue(formData, "zoomJoinUrl") || null,
    inviteeQuestionsJson: JSON.stringify(questionsFromForm(formData)),
    collectPayment: formData.get("collectPayment") === "on",
    priceCents: formData.get("collectPayment") === "on" ? numberValue(formData, "priceDollars", 0) * 100 : null,
    stripePaymentLink: formData.get("collectPayment") === "on" ? textValue(formData, "stripePaymentLink") || null : null,
    smsOptInEnabled: false,
    confirmationMessage: textValue(formData, "confirmationMessage") || null,
    isActive: formData.get("isActive") === "on",
    createdAt: now,
    updatedAt: now,
  });

  await logActivity({
    action: "scheduler.meeting_type_created",
    metadata: { name, slug },
  });

  revalidatePath("/scheduler");
  redirect("/scheduler");
}

export async function updateMeetingTypeAction(formData: FormData) {
  "use server";

  const id = textValue(formData, "meetingTypeId");
  const name = textValue(formData, "name");
  if (!id || !name) throw new Error("Meeting type and name are required.");

  const providedSlug = slugify(textValue(formData, "slug"));
  const slug = providedSlug || slugify(name);

  await db.update(schedulerMeetingTypes).set({
    slug,
    name,
    description: textValue(formData, "description") || null,
    durationMinutes: Number(textValue(formData, "durationMinutes")) || 30,
    bufferMinutes: Number(textValue(formData, "bufferMinutes")) || 15,
    locationType: textValue(formData, "locationType") || "zoom",
    locationLabel: textValue(formData, "locationLabel") || "Zoom",
    zoomJoinUrl: textValue(formData, "zoomJoinUrl") || null,
    inviteeQuestionsJson: JSON.stringify(questionsFromForm(formData)),
    collectPayment: formData.get("collectPayment") === "on",
    priceCents: formData.get("collectPayment") === "on" ? numberValue(formData, "priceDollars", 0) * 100 : null,
    stripePaymentLink: formData.get("collectPayment") === "on" ? textValue(formData, "stripePaymentLink") || null : null,
    smsOptInEnabled: false,
    confirmationMessage: textValue(formData, "confirmationMessage") || null,
    isActive: formData.get("isActive") === "on",
    updatedAt: new Date().toISOString(),
  }).where(eq(schedulerMeetingTypes.id, id));

  await logActivity({
    action: "scheduler.meeting_type_updated",
    metadata: { id, name, slug },
  });

  revalidatePath("/scheduler");
  revalidatePath(`/book/${slug}`);
  redirect("/scheduler");
}

export async function deleteMeetingTypeAction(formData: FormData) {
  "use server";

  const id = textValue(formData, "meetingTypeId");
  if (!id) throw new Error("Meeting type is required.");

  await db.delete(schedulerMeetingTypes).where(eq(schedulerMeetingTypes.id, id));

  await logActivity({
    action: "scheduler.meeting_type_deleted",
    metadata: { id },
  });

  revalidatePath("/scheduler");
  redirect("/scheduler");
}
