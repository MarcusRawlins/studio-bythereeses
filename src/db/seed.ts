import { eq } from "drizzle-orm";
import { db } from "./client";
import { clients, invoicePayments, invoices, projectEvents, projectParticipants, projects, proposalLineItems, proposals, schedulerMeetingTypes, schedulerSettings, templates } from "./schema";

const now = new Date().toISOString();
const clientId = "seed-client-alex-taylor";
const projectId = "seed-project-alex-taylor-wedding";
const proposalId = "seed-proposal-alex-taylor";
const invoiceId = "seed-invoice-alex-taylor-retainer";

async function main() {
  await db.insert(schedulerSettings).values({
    id: "default",
    timezone: "America/New_York",
    bookingWindowDays: 30,
    minimumNoticeMinutes: 240,
    availabilityJson: JSON.stringify([
      { day: 2, start: "10:00", end: "16:00" },
      { day: 3, start: "10:00", end: "16:00" },
      { day: 4, start: "10:00", end: "16:00" },
    ]),
    googleCalendarIds: "primary",
    googleCreateCalendarId: "primary",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  await db.insert(schedulerMeetingTypes).values([
    {
      id: "meeting-discovery-call",
      slug: "discovery-call",
      name: "Discovery Call",
      description: "A short intro call for new inquiries.",
      durationMinutes: 20,
      bufferMinutes: 15,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "meeting-planning-call",
      slug: "planning-call",
      name: "Planning Call",
      description: "A planning call for booked clients.",
      durationMinutes: 45,
      bufferMinutes: 15,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "meeting-final-details",
      slug: "final-details-call",
      name: "Final Details Call",
      description: "Final logistics review before the wedding day.",
      durationMinutes: 30,
      bufferMinutes: 15,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
  ]).onConflictDoNothing();

  await db.insert(templates).values([
    {
      id: "template-email-inquiry-follow-up",
      type: "email",
      name: "Inquiry follow-up",
      trigger: "Manual or 2 days after inquiry",
      subject: "Your photography inquiry",
      body: "Warm reply with availability, next steps, and call booking link.",
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "template-email-proposal-sent",
      type: "email",
      name: "Proposal sent",
      trigger: "When proposal is sent",
      subject: "Your proposal, contract, and retainer invoice",
      body: "Deliver proposal, contract, invoice/retainer details, and deadline.",
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "template-questionnaire-wedding-planning",
      type: "questionnaire",
      name: "Wedding planning questionnaire",
      trigger: "90 days before wedding date",
      subject: null,
      body: "Gather timeline, vendors, priorities, family dynamics, and logistics.",
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
  ]).onConflictDoNothing();

  await db.insert(clients).values({
    id: clientId,
    firstName: "Alex",
    lastName: "Taylor",
    email: "alex.taylor@example.com",
    phone: "555-0100",
    preferredName: "Alex",
    notes: "Seed client for local MVP testing.",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  await db.insert(projects).values({
    id: projectId,
    name: "Alex & Taylor Wedding",
    type: "wedding",
    stage: "inquiry",
    status: "active",
    eventDate: "2026-09-19",
    venueName: "The Roundhouse",
    venueAddress: "2 E Main St, Beacon, NY 12508",
    city: "Beacon",
    state: "NY",
    budgetCents: 850000,
    calendarSyncStatus: "needs_google_connection",
    notes: "Seed wedding project.",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  await db.insert(proposals).values({
    id: proposalId,
    projectId,
    title: "Alex & Taylor Wedding Proposal",
    status: "sent",
    packageName: "Wedding Collection",
    totalCents: 850000,
    validUntil: "2026-05-15",
    scopeSummary: "Wedding day photography coverage, planning support, edited image gallery, and usage rights for personal printing and sharing.",
    contractStatus: "drafted",
    invoiceStatus: "created",
    sentAt: now,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  await db.insert(proposalLineItems).values([
    {
      id: "seed-proposal-line-coverage",
      proposalId,
      name: "Wedding photography coverage",
      description: "Wedding day photography coverage and edited image gallery.",
      quantity: 1,
      unitPriceCents: 700000,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "seed-proposal-line-engagement",
      proposalId,
      name: "Engagement session",
      description: "Portrait session before the wedding day.",
      quantity: 1,
      unitPriceCents: 150000,
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]).onConflictDoNothing();

  await db.insert(invoices).values({
    id: invoiceId,
    projectId,
    proposalId,
    invoiceNumber: "INV-20260429-ALEX",
    status: "sent",
    totalCents: 850000,
    amountPaidCents: 0,
    dueDate: "2026-05-15",
    paymentNotes: "Retainer reserves the wedding date. Remaining balance can be split for the client as needed.",
    zelleInfo: "Add Zelle details in invoice settings.",
    venmoInfo: "Add Venmo handle in invoice settings.",
    sentAt: now,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  await db.insert(invoicePayments).values([
    {
      id: "seed-payment-alex-taylor-retainer",
      invoiceId,
      label: "Retainer",
      amountCents: 250000,
      dueDate: "2026-05-15",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "seed-payment-alex-taylor-final",
      invoiceId,
      label: "Final payment",
      amountCents: 600000,
      dueDate: "2026-08-20",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    },
  ]).onConflictDoNothing();

  await db.insert(projectEvents).values({
    id: "seed-event-alex-taylor-wedding-day",
    projectId,
    type: "wedding",
    title: "Wedding day",
    eventDate: "2026-09-19",
    venueName: "The Roundhouse",
    venueAddress: "2 E Main St, Beacon, NY 12508",
    city: "Beacon",
    state: "NY",
    calendarSyncStatus: "needs_google_connection",
    notes: "Primary wedding date.",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  const existingParticipant = await db.query.projectParticipants.findFirst({
    where: eq(projectParticipants.projectId, projectId),
  });

  if (!existingParticipant) {
    await db.insert(projectParticipants).values({
      id: "seed-participant-alex-taylor",
      projectId,
      clientId,
      role: "primary",
      isPrimaryContact: true,
      createdAt: now,
    });
  }

  console.log("Seed data ready.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
