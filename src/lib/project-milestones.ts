// Phase 22 — project progress / milestone timeline (CR-1), spec rev 2
// (docs/specs/phase-22-project-progress-timeline.md).
//
// PURE compute module: derives a read-only milestone projection over existing canonical data
// (stage, typed project events, scheduler bookings, proposals, invoices + payment schedule rows,
// delivered galleries). NO cron, NO writes, NO parallel stage system — `projects.stage` stays the
// only written state. This file imports ONLY types and the shared timezone helper (no `@/db`,
// no other `@/lib/*` module) so it can be unit-tested without a database (see the purity guard in
// project-milestones.test.ts, spec §4 test 11).

import { addDaysToDateKey, dateKeyInTimeZone } from "@/lib/timezone";

// Spec §3: agenda/dashboard default timezone — "today" and all ISO-datetime normalization use
// this zone (America/New_York), matching `src/app/page.tsx` / `src/lib/agenda.ts`.
const TIME_ZONE = "America/New_York";

// Thresholds are module constants per spec §2 row 5/10/11.
export const ESESSION_DELIVERY_DAYS = 21;
export const SNEAK_PEEK_DAYS = 7;
export const FULL_GALLERY_DAYS = 56;

export type MilestoneStatus = "done" | "current" | "upcoming" | "overdue" | "n/a";

export type MilestoneKey =
  | "inquiry"
  | "proposal"
  | "booked"
  | "esession"
  | "esession_delivery"
  | "vision_call"
  | "final_payment"
  | "week_of"
  | "wedding_day"
  | "sneak_peek"
  | "full_gallery"
  | "anniversary"
  | "session_day"
  | "gallery_delivered"
  | "completed";

export type ProjectMilestone = {
  key: MilestoneKey;
  label: string;
  status: MilestoneStatus;
  // The date this milestone is/was due, or (for done milestones where meaningful) the date it
  // completed on. Null when there is no relevant date (undated engagement, no wedding date, etc).
  date: string | null;
};

export type MilestoneInputEvent = {
  type: string;
  title: string;
  eventDate: string | null;
};

export type MilestoneInputBooking = {
  startAt: string;
  status: string;
  meetingName: string | null;
  title?: string | null;
};

export type MilestoneInputProposal = {
  status: string;
  sentAt?: string | null;
  acceptedAt?: string | null;
  signedAt?: string | null;
  contractStatus?: string | null;
};

export type MilestoneInputInvoice = {
  id: string;
  status: string;
  dueDate?: string | null;
};

// Rev 2 (M3): schedule rows of non-void invoices — the real due dates (`invoicePayments.dueDate`),
// NOT `invoices.dueDate` which is optional/rarely set. `label` is included (build order step 2)
// so the "retainer payment row paid" arm of the `booked` milestone can identify the retainer
// payment without re-deriving it from invoice shape.
export type MilestoneInputPayment = {
  invoiceId?: string | null;
  status: string;
  dueDate: string | null;
  label?: string | null;
};

export type MilestoneInputGallery = {
  status: string;
  title: string;
  deliveredAt: string | null;
  createdAt: string;
};

export type MilestoneInput = {
  stage: string;
  type: string;
  createdAt: string;
  eventDate: string | null;
  events: MilestoneInputEvent[];
  bookings: MilestoneInputBooking[];
  proposals: MilestoneInputProposal[];
  invoices: MilestoneInputInvoice[];
  payments: MilestoneInputPayment[];
  galleries: MilestoneInputGallery[];
};

// Mirrors `projectStages` in `src/lib/crm.ts` ~13-21 (kept as a local literal copy — importing
// crm.ts would drag in `@/db` and break purity).
const PROJECT_STAGE_ORDER = ["inquiry", "proposal_sent", "retainer_paid", "planning", "editing", "delivered", "completed"];

function stageAtLeast(stage: string, target: string): boolean {
  const rank = PROJECT_STAGE_ORDER.indexOf(stage);
  const targetRank = PROJECT_STAGE_ORDER.indexOf(target);
  if (rank === -1 || targetRank === -1) return false;
  return rank >= targetRank;
}

// Mirrors `proposalIsAcceptedOrSigned` in `src/lib/sales.ts` ~539-541 (duplicated, not imported —
// sales.ts is not a pure module). A merely-SENT proposal also counts as "sent" for the `proposal`
// milestone (spec §2 row 2).
function proposalIsAcceptedOrSigned(proposal: MilestoneInputProposal): boolean {
  return Boolean(proposal.acceptedAt || proposal.signedAt || proposal.status === "accepted" || proposal.contractStatus === "signed");
}

function proposalIsSentOrBeyond(proposal: MilestoneInputProposal): boolean {
  return (
    proposalIsAcceptedOrSigned(proposal)
    || Boolean(proposal.sentAt)
    || proposal.status === "sent"
    || proposal.status === "viewed"
  );
}

// Mirrors `isRetainerPaymentLabel` in `src/lib/retainer-selection.ts` (duplicated for the same
// purity reason — kept as the one place this exact regex is defined for this module).
function isRetainerPaymentLabel(label: string | null | undefined): boolean {
  return /\b(retainer|deposit)\b/i.test(label ?? "");
}

// Rev 2 (M1): wedding track is `project.type === "wedding"` ONLY — event-presence is NOT used,
// because `createProjectFromForm` inserts a `type:"wedding"`, title "Wedding day" event for ANY
// project type whenever eventDate/venue is set (`crm.ts` ~979-994).
function isWeddingTrack(input: MilestoneInput): boolean {
  return input.type === "wedding";
}

// Reuses the existing wedding-event predicate (`crm.ts` ~2315: `type === "wedding"` or title
// "wedding day").
function isWeddingEvent(event: MilestoneInputEvent): boolean {
  return event.type === "wedding" || event.title.toLowerCase() === "wedding day";
}

// Rev 2 (M5): `project.eventDate` primary (the canonical, agent-guarded wedding date), fallback to
// the MAX-DATED wedding-predicate event, ignoring null-dated events entirely.
function resolveWeddingDate(input: MilestoneInput): string | null {
  if (input.eventDate) return input.eventDate;
  let latest: string | null = null;
  for (const event of input.events) {
    if (!isWeddingEvent(event) || !event.eventDate) continue;
    if (latest === null || event.eventDate > latest) latest = event.eventDate;
  }
  return latest;
}

// Rev 2 minor: e-session title regex, excluded from sneak-peek/full-gallery counts and used to
// positively identify an e-session delivery gallery.
const ESESSION_TITLE_REGEX = /engagement|e.?session/i;

function isDeliveredGallery(gallery: MilestoneInputGallery): boolean {
  return gallery.status === "delivered";
}

// Rev 2 minor: gallery "date" = coalesce(deliveredAt, createdAt), normalized via the shared
// timezone helper BEFORE comparison (rev 2, M4 — legacy delivered rows may have null deliveredAt,
// and a datetime near midnight ET must not be misread as the next UTC calendar day).
function galleryDateKey(gallery: MilestoneInputGallery): string {
  return dateKeyInTimeZone(new Date(gallery.deliveredAt ?? gallery.createdAt), TIME_ZONE);
}

function bookingDateKey(booking: MilestoneInputBooking): string {
  return dateKeyInTimeZone(new Date(booking.startAt), TIME_ZONE);
}

function addYearToDateKey(date: string): string {
  const [year, month, day] = date.split("-");
  return [String(Number(year) + 1).padStart(4, "0"), month, day].join("-");
}

// Rev 2 (M1/B1): the SAME final_payment predicate is reused by the wedding track (row 7) and the
// generic track's `completed` milestone. Rev 2 (B1): requires >= 1 non-draft, non-void invoice;
// void is excluded and never blocks forever; zero/draft-only/void-only invoices are `upcoming`,
// never vacuously done (HoneyBook imports create retainer_paid projects with zero invoice rows).
// Rev 2 (Fable diff review M1): the set of invoice ids that are LIVE — status ∉ {draft, void}.
// A voided (or still-draft) invoice's schedule rows survive in `invoicePayments`, so both the
// final_payment overdue scan and the `booked` "retainer paid" arm MUST ignore payment rows whose
// parent invoice is voided/draft — otherwise a voided-and-reissued invoice paints a healthy
// project permanently OVERDUE (amber), the exact false signal this feature exists to prevent.
function liveInvoiceIds(input: MilestoneInput): Set<string> {
  return new Set(
    input.invoices.filter((invoice) => invoice.status !== "draft" && invoice.status !== "void").map((invoice) => invoice.id),
  );
}

// A payment row counts only when its parent invoice is live (or, defensively, when no invoiceId is
// carried — the loaders always set it, so this only guards hand-built fixtures).
function paymentOnLiveInvoice(payment: MilestoneInputPayment, liveIds: Set<string>): boolean {
  return payment.invoiceId == null || liveIds.has(payment.invoiceId);
}

function finalPaymentStatus(input: MilestoneInput, todayKey: string): { status: MilestoneStatus; date: string | null } {
  const relevantInvoices = input.invoices.filter((invoice) => invoice.status !== "draft" && invoice.status !== "void");
  if (!relevantInvoices.length) return { status: "upcoming", date: null };
  const liveIds = liveInvoiceIds(input);

  const allPaid = relevantInvoices.every((invoice) => invoice.status === "paid");
  if (allPaid) return { status: "done", date: null };

  // Rev 2 (M3): overdue uses the payment SCHEDULE ROW dueDate (`invoicePayments.dueDate`), not
  // `invoices.dueDate`.
  const overdueRows = input.payments
    .filter(
      (payment) =>
        payment.status !== "paid"
        && payment.status !== "refunded" // a refunded row is settled, not an outstanding due (Fable F5)
        && payment.dueDate
        && payment.dueDate < todayKey // Rev 2 (M3): overdue only AFTER the due date passes, not ON it
        && paymentOnLiveInvoice(payment, liveIds),
    )
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1));
  if (overdueRows.length) return { status: "overdue", date: overdueRows[0].dueDate };

  return { status: "upcoming", date: null };
}

function weddingTrackMilestones(input: MilestoneInput, todayKey: string): ProjectMilestone[] {
  const weddingDate = resolveWeddingDate(input);
  const milestones: ProjectMilestone[] = [];

  // 1. inquiry — always done; project existing is the fact.
  milestones.push({
    key: "inquiry",
    label: "Inquiry",
    status: "done",
    date: dateKeyInTimeZone(new Date(input.createdAt), TIME_ZONE),
  });

  // 2. proposal
  const proposalDone = stageAtLeast(input.stage, "proposal_sent") || input.proposals.some(proposalIsSentOrBeyond);
  milestones.push({
    key: "proposal",
    label: "Proposal sent",
    status: proposalDone ? "done" : "upcoming",
    date: null,
  });

  // 3. booked (retainer paid) — a retainer payment on a since-voided invoice does NOT count (M1).
  const bookedLiveIds = liveInvoiceIds(input);
  const bookedDone = stageAtLeast(input.stage, "retainer_paid")
    || input.payments.some(
      (payment) =>
        isRetainerPaymentLabel(payment.label)
        && payment.status === "paid"
        && paymentOnLiveInvoice(payment, bookedLiveIds),
    );
  milestones.push({
    key: "booked",
    label: "Booked (retainer paid)",
    status: bookedDone ? "done" : "upcoming",
    date: null,
  });

  // 4. esession — track-scoped to a single engagement-typed event (prefer a dated one; fall back
  // to the undated placeholder). Rev 2 (M7): undated engagement ⇒ upcoming, undated, never
  // overdue.
  const engagementEvents = input.events.filter((event) => event.type === "engagement");
  if (!engagementEvents.length) {
    milestones.push({ key: "esession", label: "Engagement session", status: "n/a", date: null });
  } else {
    const engagementEvent = engagementEvents.find((event) => event.eventDate) ?? engagementEvents[0];
    if (!engagementEvent.eventDate) {
      milestones.push({ key: "esession", label: "Engagement session", status: "upcoming", date: null });
    } else {
      const done = todayKey >= engagementEvent.eventDate;
      milestones.push({
        key: "esession",
        label: "Engagement session",
        status: done ? "done" : "upcoming",
        date: engagementEvent.eventDate,
      });
    }

    // 5. esession_delivery
    const engagementEventDate = engagementEvent.eventDate;
    if (!engagementEventDate) {
      milestones.push({ key: "esession_delivery", label: "E-session gallery", status: "upcoming", date: null });
    } else {
      const delivered = input.galleries.some((gallery) => {
        if (!isDeliveredGallery(gallery)) return false;
        if (ESESSION_TITLE_REGEX.test(gallery.title)) return true;
        if (!weddingDate) return false;
        return galleryDateKey(gallery) < weddingDate;
      });
      if (delivered) {
        milestones.push({ key: "esession_delivery", label: "E-session gallery", status: "done", date: null });
      } else {
        const dueDate = addDaysToDateKey(engagementEventDate, ESESSION_DELIVERY_DAYS);
        const status: MilestoneStatus = todayKey >= dueDate ? "overdue" : "upcoming";
        milestones.push({ key: "esession_delivery", label: "E-session gallery", status, date: dueDate });
      }
    }
  }

  // 6. vision_call — rev 2 (M2): sourced from scheduler bookings, not projectEvents.
  const visionCallMatches = input.bookings.filter(
    (booking) => booking.status !== "cancelled" && /vision|timeline|planning|consult/i.test(`${booking.meetingName ?? ""} ${booking.title ?? ""}`),
  );
  if (!visionCallMatches.length) {
    milestones.push({ key: "vision_call", label: "Vision & timeline call", status: "n/a", date: null });
  } else {
    const earliest = [...visionCallMatches].sort((a, b) => (a.startAt < b.startAt ? -1 : 1))[0];
    const done = visionCallMatches.some((booking) => bookingDateKey(booking) <= todayKey);
    milestones.push({
      key: "vision_call",
      label: "Vision & timeline call",
      status: done ? "done" : "upcoming",
      date: bookingDateKey(earliest),
    });
  }

  // 7. final_payment
  const finalPayment = finalPaymentStatus(input, todayKey);
  milestones.push({ key: "final_payment", label: "Final payment", status: finalPayment.status, date: finalPayment.date });

  // 8. week_of
  if (!weddingDate) {
    milestones.push({ key: "week_of", label: "Week of wedding", status: "upcoming", date: null });
  } else {
    const dueDate = addDaysToDateKey(weddingDate, -7);
    milestones.push({ key: "week_of", label: "Week of wedding", status: todayKey >= dueDate ? "done" : "upcoming", date: dueDate });
  }

  // 9. wedding_day
  if (!weddingDate) {
    milestones.push({ key: "wedding_day", label: "Wedding day", status: "upcoming", date: null });
  } else {
    milestones.push({ key: "wedding_day", label: "Wedding day", status: todayKey >= weddingDate ? "done" : "upcoming", date: weddingDate });
  }

  // 10 + 11. sneak_peek / full_gallery
  if (!weddingDate) {
    milestones.push({ key: "sneak_peek", label: "Sneak peek delivered", status: "upcoming", date: null });
    milestones.push({ key: "full_gallery", label: "Full gallery delivered", status: "upcoming", date: null });
  } else {
    const qualifying = input.galleries.filter(
      (gallery) => isDeliveredGallery(gallery) && !ESESSION_TITLE_REGEX.test(gallery.title) && galleryDateKey(gallery) >= weddingDate,
    );

    const sneakPeekDone = qualifying.length >= 1;
    const sneakPeekDueDate = addDaysToDateKey(weddingDate, SNEAK_PEEK_DAYS);
    if (sneakPeekDone) {
      milestones.push({ key: "sneak_peek", label: "Sneak peek delivered", status: "done", date: null });
    } else {
      const status: MilestoneStatus = todayKey >= sneakPeekDueDate ? "overdue" : "upcoming";
      milestones.push({ key: "sneak_peek", label: "Sneak peek delivered", status, date: sneakPeekDueDate });
    }

    // Rev 2 minor / spec §2 row 11: single-delivery collapse — one qualifying gallery + the
    // sneak-peek window elapsed completes BOTH milestones (no phantom overdue on full_gallery).
    const fullGalleryDone = qualifying.length >= 2
      || (qualifying.length === 1 && todayKey >= sneakPeekDueDate)
      || stageAtLeast(input.stage, "delivered");
    if (fullGalleryDone) {
      milestones.push({ key: "full_gallery", label: "Full gallery delivered", status: "done", date: null });
    } else {
      const fullGalleryDueDate = addDaysToDateKey(weddingDate, FULL_GALLERY_DAYS);
      const status: MilestoneStatus = todayKey >= fullGalleryDueDate ? "overdue" : "upcoming";
      milestones.push({ key: "full_gallery", label: "Full gallery delivered", status, date: fullGalleryDueDate });
    }
  }

  // 12. anniversary
  if (!weddingDate) {
    milestones.push({ key: "anniversary", label: "Anniversary", status: "upcoming", date: null });
  } else {
    const anniversaryDate = addYearToDateKey(weddingDate);
    milestones.push({
      key: "anniversary",
      label: "Anniversary",
      status: todayKey >= anniversaryDate ? "done" : "upcoming",
      date: anniversaryDate,
    });
  }

  return milestones;
}

function genericTrackMilestones(input: MilestoneInput, todayKey: string): ProjectMilestone[] {
  const milestones: ProjectMilestone[] = [];

  milestones.push({
    key: "inquiry",
    label: "Inquiry",
    status: "done",
    date: dateKeyInTimeZone(new Date(input.createdAt), TIME_ZONE),
  });

  const proposalDone = stageAtLeast(input.stage, "proposal_sent") || input.proposals.some(proposalIsSentOrBeyond);
  milestones.push({ key: "proposal", label: "Proposal sent", status: proposalDone ? "done" : "upcoming", date: null });

  const bookedDone = stageAtLeast(input.stage, "retainer_paid")
    || input.payments.some((payment) => isRetainerPaymentLabel(payment.label) && payment.status === "paid");
  milestones.push({ key: "booked", label: "Booked (retainer paid)", status: bookedDone ? "done" : "upcoming", date: null });

  // Rev 2 (M1): session day uses `project.eventDate` ONLY — the auto-created wedding-titled event
  // on a non-wedding project is ignored for track/labels.
  if (!input.eventDate) {
    milestones.push({ key: "session_day", label: "Session day", status: "upcoming", date: null });
  } else {
    milestones.push({
      key: "session_day",
      label: "Session day",
      status: todayKey >= input.eventDate ? "done" : "upcoming",
      date: input.eventDate,
    });
  }

  const galleryDelivered = input.galleries.some((gallery) => isDeliveredGallery(gallery));
  milestones.push({ key: "gallery_delivered", label: "Gallery delivered", status: galleryDelivered ? "done" : "upcoming", date: null });

  const finalPayment = finalPaymentStatus(input, todayKey);
  const completedDone = stageAtLeast(input.stage, "completed")
    || (stageAtLeast(input.stage, "delivered") && finalPayment.status === "done");
  milestones.push({ key: "completed", label: "Completed", status: completedDone ? "done" : "upcoming", date: null });

  return milestones;
}

// Spec §2 "Statuses": at most one `current` (rev 2, M6) — the first non-done, non-n/a milestone,
// in catalog order. A fully-finished project (every milestone done or n/a) has ZERO current. An
// `overdue` milestone is left `overdue` (the amber signal already marks "the current position");
// only an `upcoming` first-pending milestone gets relabeled `current`.
function applyAtMostOneCurrent(list: ProjectMilestone[]): ProjectMilestone[] {
  for (const milestone of list) {
    if (milestone.status === "done" || milestone.status === "n/a") continue;
    if (milestone.status === "upcoming") milestone.status = "current";
    break;
  }
  return list;
}

export function computeProjectMilestones(input: MilestoneInput, today: Date): ProjectMilestone[] {
  const todayKey = dateKeyInTimeZone(today, TIME_ZONE);
  const raw = isWeddingTrack(input) ? weddingTrackMilestones(input, todayKey) : genericTrackMilestones(input, todayKey);
  const withCurrent = applyAtMostOneCurrent(raw);
  // n/a milestones are omitted from rendering entirely (spec §2 "Statuses").
  return withCurrent.filter((milestone) => milestone.status !== "n/a");
}

export type MilestoneSummaryValue = {
  doneCount: number;
  totalCount: number;
  currentLabel: string | null;
  hasOverdue: boolean;
};

export function milestoneSummary(list: ProjectMilestone[]): MilestoneSummaryValue {
  const doneCount = list.filter((milestone) => milestone.status === "done").length;
  const current = list.find((milestone) => milestone.status === "current");
  const hasOverdue = list.some((milestone) => milestone.status === "overdue");
  return {
    doneCount,
    totalCount: list.length,
    currentLabel: current?.label ?? null,
    hasOverdue,
  };
}
