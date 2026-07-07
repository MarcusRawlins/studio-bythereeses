import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeProjectMilestones,
  milestoneSummary,
  type MilestoneInput,
  type MilestoneStatus,
  type ProjectMilestone,
} from "./project-milestones";

const here = path.dirname(fileURLToPath(import.meta.url));

function statusByKey(list: ProjectMilestone[], key: string): MilestoneStatus | "missing" {
  return list.find((milestone) => milestone.key === key)?.status ?? "missing";
}

function dateByKey(list: ProjectMilestone[], key: string): string | null | "missing" {
  const milestone = list.find((m) => m.key === key);
  return milestone ? milestone.date : "missing";
}

function baseWeddingInput(overrides: Partial<MilestoneInput> = {}): MilestoneInput {
  return {
    stage: "inquiry",
    type: "wedding",
    createdAt: "2026-01-01T15:00:00.000Z",
    eventDate: "2026-06-13",
    events: [],
    bookings: [],
    proposals: [],
    invoices: [],
    payments: [],
    galleries: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1 — Wedding golden path: booked + paid + galleries fixture walks every
// milestone to done as an explicit `today` advances (spec §4 test 1).
// ---------------------------------------------------------------------------
function test1GoldenPath() {
  const createdAt = "2026-01-01T15:00:00.000Z";
  const weddingDate = "2026-06-13";
  const engagementEventDate = "2026-03-01";
  const visionCallStartAt = "2026-04-15T18:00:00.000Z";

  function goldenInput(overrides: Partial<MilestoneInput>): MilestoneInput {
    return {
      stage: "inquiry",
      type: "wedding",
      createdAt,
      eventDate: weddingDate,
      events: [{ type: "engagement", title: "Engagement session", eventDate: engagementEventDate }],
      bookings: [{ startAt: visionCallStartAt, status: "confirmed", meetingName: "Vision & Timeline Call", title: null }],
      proposals: [],
      invoices: [{ id: "inv-1", status: "sent" }],
      payments: [
        { invoiceId: "inv-1", status: "pending", dueDate: "2026-01-15", label: "Retainer deposit" },
        { invoiceId: "inv-1", status: "pending", dueDate: "2026-06-01", label: "Final balance" },
      ],
      galleries: [],
      ...overrides,
    };
  }

  // Checkpoint A — nothing has happened yet.
  let list = computeProjectMilestones(goldenInput({}), new Date("2026-01-02T12:00:00.000Z"));
  assert.equal(statusByKey(list, "inquiry"), "done", "A: inquiry always done");
  assert.equal(statusByKey(list, "proposal"), "current", "A: proposal is the next pending step");

  // Checkpoint B — proposal sent.
  const proposalsSent: MilestoneInput["proposals"] = [{ status: "sent", sentAt: "2026-01-05T00:00:00.000Z" }];
  list = computeProjectMilestones(goldenInput({ proposals: proposalsSent }), new Date("2026-01-06T12:00:00.000Z"));
  assert.equal(statusByKey(list, "proposal"), "done", "B: proposal done once sent");
  assert.equal(statusByKey(list, "booked"), "current", "B: booked is next");

  // Checkpoint C — retainer paid.
  const paymentsRetainerPaid: MilestoneInput["payments"] = [
    { invoiceId: "inv-1", status: "paid", dueDate: "2026-01-15", label: "Retainer deposit" },
    { invoiceId: "inv-1", status: "pending", dueDate: "2026-06-01", label: "Final balance" },
  ];
  list = computeProjectMilestones(
    goldenInput({ proposals: proposalsSent, payments: paymentsRetainerPaid }),
    new Date("2026-01-16T12:00:00.000Z"),
  );
  assert.equal(statusByKey(list, "booked"), "done", "C: booked done once retainer paid");
  assert.equal(statusByKey(list, "esession"), "current", "C: esession is next (not yet due)");
  assert.equal(dateByKey(list, "esession"), engagementEventDate);

  // Checkpoint D — engagement session date has passed.
  list = computeProjectMilestones(
    goldenInput({ proposals: proposalsSent, payments: paymentsRetainerPaid }),
    new Date("2026-03-02T12:00:00.000Z"),
  );
  assert.equal(statusByKey(list, "esession"), "done", "D: esession done once its date passes");
  assert.equal(statusByKey(list, "esession_delivery"), "current", "D: esession_delivery is next");

  // Checkpoint E — engagement gallery delivered.
  const galleriesWithEsession: MilestoneInput["galleries"] = [
    { status: "delivered", title: "Engagement Session Highlights", deliveredAt: "2026-03-10T12:00:00.000Z", createdAt: "2026-03-10T12:00:00.000Z" },
  ];
  list = computeProjectMilestones(
    goldenInput({ proposals: proposalsSent, payments: paymentsRetainerPaid, galleries: galleriesWithEsession }),
    new Date("2026-03-15T12:00:00.000Z"),
  );
  assert.equal(statusByKey(list, "esession_delivery"), "done", "E: esession_delivery done once gallery delivered");
  assert.equal(statusByKey(list, "vision_call"), "current", "E: vision_call is next (booking not yet occurred)");

  // Checkpoint F — vision & timeline call has occurred.
  list = computeProjectMilestones(
    goldenInput({ proposals: proposalsSent, payments: paymentsRetainerPaid, galleries: galleriesWithEsession }),
    new Date("2026-04-20T12:00:00.000Z"),
  );
  assert.equal(statusByKey(list, "vision_call"), "done", "F: vision_call done once its startAt passes");
  assert.equal(statusByKey(list, "final_payment"), "current", "F: final_payment is next");

  // Checkpoint G — final balance paid.
  const paymentsAllPaid: MilestoneInput["payments"] = [
    { invoiceId: "inv-1", status: "paid", dueDate: "2026-01-15", label: "Retainer deposit" },
    { invoiceId: "inv-1", status: "paid", dueDate: "2026-06-01", label: "Final balance" },
  ];
  list = computeProjectMilestones(
    goldenInput({ proposals: proposalsSent, payments: paymentsAllPaid, invoices: [{ id: "inv-1", status: "paid" }], galleries: galleriesWithEsession }),
    new Date("2026-06-05T12:00:00.000Z"),
  );
  assert.equal(statusByKey(list, "final_payment"), "done", "G: final_payment done once all invoices paid");
  assert.equal(statusByKey(list, "week_of"), "current", "G: week_of is next");

  // Checkpoint H — inside the week-of window.
  list = computeProjectMilestones(
    goldenInput({ proposals: proposalsSent, payments: paymentsAllPaid, invoices: [{ id: "inv-1", status: "paid" }], galleries: galleriesWithEsession }),
    new Date("2026-06-07T12:00:00.000Z"),
  );
  assert.equal(statusByKey(list, "week_of"), "done", "H: week_of done inside the 7-day window");
  assert.equal(statusByKey(list, "wedding_day"), "current", "H: wedding_day is next");

  // Checkpoint I — wedding day itself.
  list = computeProjectMilestones(
    goldenInput({ proposals: proposalsSent, payments: paymentsAllPaid, invoices: [{ id: "inv-1", status: "paid" }], galleries: galleriesWithEsession }),
    new Date("2026-06-13T12:00:00.000Z"),
  );
  assert.equal(statusByKey(list, "wedding_day"), "done", "I: wedding_day done on the day");
  assert.equal(statusByKey(list, "sneak_peek"), "current", "I: sneak_peek is next");

  // Checkpoint J — sneak peek delivered.
  const galleriesWithSneak: MilestoneInput["galleries"] = [
    ...galleriesWithEsession,
    { status: "delivered", title: "Sneak Peek Gallery", deliveredAt: "2026-06-15T12:00:00.000Z", createdAt: "2026-06-15T12:00:00.000Z" },
  ];
  list = computeProjectMilestones(
    goldenInput({ proposals: proposalsSent, payments: paymentsAllPaid, invoices: [{ id: "inv-1", status: "paid" }], galleries: galleriesWithSneak }),
    new Date("2026-06-16T12:00:00.000Z"),
  );
  assert.equal(statusByKey(list, "sneak_peek"), "done", "J: sneak_peek done once a qualifying gallery is delivered");
  assert.equal(statusByKey(list, "full_gallery"), "current", "J: full_gallery is next (only 1 qualifying gallery, window not elapsed)");

  // Checkpoint K — full gallery delivered (a second qualifying gallery).
  const galleriesWithFull: MilestoneInput["galleries"] = [
    ...galleriesWithSneak,
    { status: "delivered", title: "Full Gallery Delivery", deliveredAt: "2026-06-24T12:00:00.000Z", createdAt: "2026-06-24T12:00:00.000Z" },
  ];
  list = computeProjectMilestones(
    goldenInput({ proposals: proposalsSent, payments: paymentsAllPaid, invoices: [{ id: "inv-1", status: "paid" }], galleries: galleriesWithFull }),
    new Date("2026-06-25T12:00:00.000Z"),
  );
  assert.equal(statusByKey(list, "full_gallery"), "done", "K: full_gallery done with 2 qualifying galleries");
  assert.equal(statusByKey(list, "anniversary"), "current", "K: anniversary is next");

  // Checkpoint L — anniversary has passed; fully finished project has ZERO current.
  list = computeProjectMilestones(
    goldenInput({ proposals: proposalsSent, payments: paymentsAllPaid, invoices: [{ id: "inv-1", status: "paid" }], galleries: galleriesWithFull }),
    new Date("2027-07-01T12:00:00.000Z"),
  );
  assert.equal(statusByKey(list, "anniversary"), "done", "L: anniversary done a year+ later");
  assert.ok(list.every((milestone) => milestone.status !== "current"), "L: a fully-finished project has zero current milestones");

  console.log("test 1 (golden path) passed");
}

// ---------------------------------------------------------------------------
// Test 2 — D2 overdue: wedding + 10d, no post-wedding gallery ⇒ sneak_peek
// overdue; adding a delivered gallery flips it done.
// ---------------------------------------------------------------------------
function test2Overdue() {
  const weddingDate = "2026-06-13";
  let input = baseWeddingInput({ eventDate: weddingDate });
  let list = computeProjectMilestones(input, new Date("2026-06-23T12:00:00.000Z")); // +10 days
  assert.equal(statusByKey(list, "sneak_peek"), "overdue", "sneak_peek overdue 10 days after the wedding with no gallery");

  input = baseWeddingInput({
    eventDate: weddingDate,
    galleries: [{ status: "delivered", title: "Sneak peek gallery", deliveredAt: "2026-06-14T12:00:00.000Z", createdAt: "2026-06-14T12:00:00.000Z" }],
  });
  list = computeProjectMilestones(input, new Date("2026-06-23T12:00:00.000Z"));
  assert.equal(statusByKey(list, "sneak_peek"), "done", "sneak_peek flips to done once a qualifying gallery exists");

  console.log("test 2 (D2 overdue) passed");
}

// ---------------------------------------------------------------------------
// Test 3 — Single-delivery collapse: one qualifying gallery + windows elapsed
// ⇒ sneak_peek AND full_gallery done (no phantom overdue).
// ---------------------------------------------------------------------------
function test3SingleDeliveryCollapse() {
  const weddingDate = "2026-06-13";
  const input = baseWeddingInput({
    eventDate: weddingDate,
    galleries: [{ status: "delivered", title: "Full gallery only", deliveredAt: "2026-06-20T12:00:00.000Z", createdAt: "2026-06-20T12:00:00.000Z" }],
  });
  // Past both the sneak-peek (7d) and full-gallery (56d) windows.
  const list = computeProjectMilestones(input, new Date("2026-08-15T12:00:00.000Z"));
  assert.equal(statusByKey(list, "sneak_peek"), "done", "single delivery satisfies sneak_peek");
  assert.equal(statusByKey(list, "full_gallery"), "done", "single delivery + elapsed window satisfies full_gallery (no phantom overdue)");

  console.log("test 3 (single-delivery collapse) passed");
}

// ---------------------------------------------------------------------------
// Test 4 — n/a + current: no engagement event ⇒ rows 4-5 omitted; at most one
// current; a fully-finished project (anniversary passed) has zero current.
// ---------------------------------------------------------------------------
function test4NaAndCurrent() {
  const noEngagementInput = baseWeddingInput({ eventDate: "2026-06-13", events: [] });
  const list = computeProjectMilestones(noEngagementInput, new Date("2026-01-10T12:00:00.000Z"));
  assert.equal(list.find((m) => m.key === "esession"), undefined, "esession omitted with no engagement event");
  assert.equal(list.find((m) => m.key === "esession_delivery"), undefined, "esession_delivery omitted with no engagement event");
  assert.ok(list.filter((m) => m.status === "current").length <= 1, "at most one current milestone");

  const finishedInput = baseWeddingInput({
    eventDate: "2026-06-13",
    events: [{ type: "engagement", title: "Engagement session", eventDate: "2026-03-01" }],
    proposals: [{ status: "accepted", acceptedAt: "2026-01-05T00:00:00.000Z" }],
    payments: [{ invoiceId: "inv-1", status: "paid", dueDate: "2026-01-15", label: "Retainer deposit" }],
    invoices: [{ id: "inv-1", status: "paid" }],
    bookings: [{ startAt: "2026-04-15T18:00:00.000Z", status: "confirmed", meetingName: "Vision & Timeline Call", title: null }],
    galleries: [
      { status: "delivered", title: "Engagement Session Highlights", deliveredAt: "2026-03-10T12:00:00.000Z", createdAt: "2026-03-10T12:00:00.000Z" },
      { status: "delivered", title: "Sneak Peek Gallery", deliveredAt: "2026-06-15T12:00:00.000Z", createdAt: "2026-06-15T12:00:00.000Z" },
      { status: "delivered", title: "Full Gallery Delivery", deliveredAt: "2026-06-24T12:00:00.000Z", createdAt: "2026-06-24T12:00:00.000Z" },
    ],
  });
  const finishedList = computeProjectMilestones(finishedInput, new Date("2027-07-01T12:00:00.000Z"));
  assert.ok(finishedList.every((m) => m.status === "done"), "every remaining milestone is done in the finished fixture");
  assert.equal(finishedList.filter((m) => m.status === "current").length, 0, "a fully-finished project has zero current");

  console.log("test 4 (n/a + current) passed");
}

// ---------------------------------------------------------------------------
// Test 5 — No wedding date ⇒ nothing overdue; date milestones upcoming, undated.
// ---------------------------------------------------------------------------
function test5NoWeddingDate() {
  const input = baseWeddingInput({ eventDate: null, events: [] });
  const list = computeProjectMilestones(input, new Date("2030-01-01T12:00:00.000Z"));

  assert.ok(list.every((m) => m.status !== "overdue"), "nothing is overdue without a wedding date");
  for (const key of ["week_of", "wedding_day", "sneak_peek", "full_gallery", "anniversary"]) {
    assert.equal(statusByKey(list, key), "upcoming", `${key} is upcoming with no wedding date`);
    assert.equal(dateByKey(list, key), null, `${key} is undated with no wedding date`);
  }

  console.log("test 5 (no wedding date) passed");
}

// ---------------------------------------------------------------------------
// Test 6 — final_payment (rev 2, B1).
// ---------------------------------------------------------------------------
function test6FinalPayment() {
  function fpInput(invoices: MilestoneInput["invoices"], payments: MilestoneInput["payments"] = []): MilestoneInput {
    return baseWeddingInput({ eventDate: "2026-06-13", invoices, payments });
  }

  // Zero invoices (HoneyBook-import shape) ⇒ upcoming, NOT done.
  let list = computeProjectMilestones(fpInput([]), new Date("2026-02-01T12:00:00.000Z"));
  assert.notEqual(statusByKey(list, "final_payment"), "done", "zero invoices must not be vacuously done");

  // Draft-only ⇒ upcoming.
  list = computeProjectMilestones(fpInput([{ id: "inv-1", status: "draft" }]), new Date("2026-02-01T12:00:00.000Z"));
  assert.notEqual(statusByKey(list, "final_payment"), "done", "draft-only invoice must not count");

  // One void + one paid ⇒ done (void ignored).
  list = computeProjectMilestones(fpInput([{ id: "inv-void", status: "void" }, { id: "inv-2", status: "paid" }]), new Date("2026-02-01T12:00:00.000Z"));
  assert.equal(statusByKey(list, "final_payment"), "done", "void invoice must be excluded, paid invoice satisfies final_payment");

  // Void-only ⇒ upcoming.
  list = computeProjectMilestones(fpInput([{ id: "inv-void", status: "void" }]), new Date("2026-02-01T12:00:00.000Z"));
  assert.notEqual(statusByKey(list, "final_payment"), "done", "void-only invoices must not count as done");

  // Unpaid non-draft ⇒ not done.
  list = computeProjectMilestones(fpInput([{ id: "inv-1", status: "sent" }]), new Date("2026-02-01T12:00:00.000Z"));
  assert.notEqual(statusByKey(list, "final_payment"), "done", "unpaid non-draft invoice is not done");

  // Fable F1 (the void-and-reissue scenario the loaders now filter): a VOIDED invoice's stale
  // past-due schedule row must NOT paint final_payment overdue, and its paid retainer row must NOT
  // mark booked done. The live reissued invoice is not yet due ⇒ final_payment is NOT overdue.
  list = computeProjectMilestones(
    fpInput(
      [{ id: "inv-void", status: "void" }, { id: "inv-live", status: "sent" }],
      [
        { invoiceId: "inv-void", status: "paid", dueDate: "2026-01-01", label: "Retainer deposit" },
        { invoiceId: "inv-void", status: "pending", dueDate: "2026-01-05", label: "Final balance" },
        { invoiceId: "inv-live", status: "pending", dueDate: "2026-09-01", label: "Final balance" },
      ],
    ),
    new Date("2026-02-01T12:00:00.000Z"),
  );
  assert.notEqual(statusByKey(list, "final_payment"), "overdue", "voided invoice's stale past-due row must NOT make final_payment overdue");
  assert.notEqual(statusByKey(list, "booked"), "done", "a retainer paid on a since-voided invoice must NOT mark booked done (stage inquiry here)");

  // A payment schedule row due EXACTLY today is NOT yet overdue (Fable M3 — overdue only after it passes).
  list = computeProjectMilestones(
    fpInput([{ id: "inv-1", status: "sent" }], [{ invoiceId: "inv-1", status: "pending", dueDate: "2026-02-01", label: "Final balance" }]),
    new Date("2026-02-01T12:00:00.000Z"),
  );
  assert.notEqual(statusByKey(list, "final_payment"), "overdue", "a schedule row due TODAY is not yet overdue");

  // Schedule row dueDate passed, unpaid ⇒ overdue.
  list = computeProjectMilestones(
    fpInput([{ id: "inv-1", status: "sent" }], [{ invoiceId: "inv-1", status: "pending", dueDate: "2026-01-01", label: "Final balance" }]),
    new Date("2026-02-01T12:00:00.000Z"),
  );
  assert.equal(statusByKey(list, "final_payment"), "overdue", "unpaid schedule row past its dueDate is overdue");

  console.log("test 6 (final_payment, rev 2 B1) passed");
}

// ---------------------------------------------------------------------------
// Test 7 — Generic track: a family project WITH the auto-created wedding-titled
// event stays on the generic track (rev 2, M1).
// ---------------------------------------------------------------------------
function test7GenericTrackDespiteWeddingEvent() {
  const input: MilestoneInput = {
    stage: "inquiry",
    type: "family",
    createdAt: "2026-01-01T15:00:00.000Z",
    eventDate: "2026-05-01",
    events: [{ type: "wedding", title: "Wedding day", eventDate: "2026-06-13" }],
    bookings: [],
    proposals: [],
    invoices: [],
    payments: [],
    galleries: [],
  };
  const list = computeProjectMilestones(input, new Date("2026-05-02T12:00:00.000Z"));

  const keys = list.map((m) => m.key).sort();
  assert.deepEqual(keys, ["booked", "completed", "gallery_delivered", "inquiry", "proposal", "session_day"].sort(), "family project uses the generic track key set");
  assert.equal(statusByKey(list, "session_day"), "done", "session_day uses project.eventDate, not the wedding-titled event");
  assert.equal(list.find((m) => m.key === "wedding_day"), undefined, "no wedding_day milestone on the generic track");
  assert.equal(list.find((m) => m.key === "week_of"), undefined, "no week_of milestone on the generic track");

  console.log("test 7 (generic track despite wedding event) passed");
}

// ---------------------------------------------------------------------------
// Test 8 — Timezone (rev 2, M4): gallery deliveredAt 2026-06-13T01:30:00Z (=
// 9:30pm ET June 12, the night before a June 13 wedding) does NOT count as the
// post-wedding sneak peek.
// ---------------------------------------------------------------------------
function test8Timezone() {
  const input = baseWeddingInput({
    eventDate: "2026-06-13",
    galleries: [{ status: "delivered", title: "Sneak peek", deliveredAt: "2026-06-13T01:30:00.000Z", createdAt: "2026-06-13T01:30:00.000Z" }],
  });
  const list = computeProjectMilestones(input, new Date("2026-06-20T12:00:00.000Z"));
  assert.equal(statusByKey(list, "sneak_peek"), "overdue", "a gallery delivered 9:30pm ET the night before the wedding does not count as post-wedding");

  console.log("test 8 (timezone edge case) passed");
}

// ---------------------------------------------------------------------------
// Test 9 — Undated engagement placeholder event ⇒ esession/esession_delivery
// upcoming, never overdue (rev 2, M7).
// ---------------------------------------------------------------------------
function test9UndatedEngagementPlaceholder() {
  const input = baseWeddingInput({
    eventDate: "2026-06-13",
    events: [{ type: "engagement", title: "Engagement session", eventDate: null }],
  });
  const list = computeProjectMilestones(input, new Date("2030-01-01T12:00:00.000Z"));

  assert.equal(statusByKey(list, "esession"), "upcoming", "undated engagement placeholder is upcoming, never overdue, even far in the future");
  assert.equal(dateByKey(list, "esession"), null, "undated engagement placeholder has no date");
  assert.equal(statusByKey(list, "esession_delivery"), "upcoming", "esession_delivery is upcoming with an undated engagement event");
  assert.equal(dateByKey(list, "esession_delivery"), null, "esession_delivery has no due date with an undated engagement event");

  console.log("test 9 (undated engagement placeholder) passed");
}

// ---------------------------------------------------------------------------
// Test 10 — vision_call: matched non-cancelled booking before/after its
// startAt ⇒ upcoming/done; cancelled booking ⇒ n/a (rev 2, M2).
// ---------------------------------------------------------------------------
function test10VisionCall() {
  const upcomingInput = baseWeddingInput({
    eventDate: "2026-06-13",
    bookings: [{ startAt: "2026-04-15T18:00:00.000Z", status: "confirmed", meetingName: "Vision & Timeline Call", title: null }],
  });
  let list = computeProjectMilestones(upcomingInput, new Date("2026-04-01T12:00:00.000Z"));
  assert.equal(statusByKey(list, "vision_call"), "upcoming", "non-cancelled booking before its startAt is upcoming");

  list = computeProjectMilestones(upcomingInput, new Date("2026-04-20T12:00:00.000Z"));
  assert.equal(statusByKey(list, "vision_call"), "done", "non-cancelled booking after its startAt is done");

  const cancelledInput = baseWeddingInput({
    eventDate: "2026-06-13",
    bookings: [{ startAt: "2026-04-15T18:00:00.000Z", status: "cancelled", meetingName: "Vision & Timeline Call", title: null }],
  });
  list = computeProjectMilestones(cancelledInput, new Date("2026-04-20T12:00:00.000Z"));
  assert.equal(list.find((m) => m.key === "vision_call"), undefined, "a cancelled booking is n/a (omitted)");

  console.log("test 10 (vision_call) passed");
}

// ---------------------------------------------------------------------------
// Test 11 — Purity guard: project-milestones.ts imports nothing beyond
// types/timezone helper (no DB).
// ---------------------------------------------------------------------------
function test11PurityGuard() {
  const source = fs.readFileSync(path.join(here, "project-milestones.ts"), "utf8");
  const importLines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("import "));

  assert.equal(importLines.length, 1, "project-milestones.ts must have exactly one import statement");
  assert.ok(importLines[0].includes("@/lib/timezone"), "the only import must be the shared timezone helper");
  assert.ok(!importLines.some((line) => line.includes("@/db")), "project-milestones.ts must never import from @/db");
  assert.ok(!importLines.some((line) => line.includes("drizzle-orm")), "project-milestones.ts must never import drizzle-orm");

  console.log("test 11 (purity guard) passed");
}

function main() {
  test1GoldenPath();
  test2Overdue();
  test3SingleDeliveryCollapse();
  test4NaAndCurrent();
  test5NoWeddingDate();
  test6FinalPayment();
  test7GenericTrackDespiteWeddingEvent();
  test8Timezone();
  test9UndatedEngagementPlaceholder();
  test10VisionCall();
  test11PurityGuard();

  // milestoneSummary sanity check (used by the list-page compact bar).
  const summaryInput = baseWeddingInput({ eventDate: "2026-06-13" });
  const summaryList = computeProjectMilestones(summaryInput, new Date("2026-06-23T12:00:00.000Z"));
  const summary = milestoneSummary(summaryList);
  assert.equal(summary.totalCount, summaryList.length);
  assert.equal(summary.doneCount, summaryList.filter((m) => m.status === "done").length);
  assert.equal(summary.hasOverdue, summaryList.some((m) => m.status === "overdue"));

  console.log("project-milestones tests passed");
}

main();
