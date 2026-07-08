import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 25 (§3.2, §3.3) — regression guards that PIN already-correct, audit-verified
// behavior so it cannot silently drift back into the gap the audit originally flagged.
// This file changes NO production behavior; it only asserts:
//   (I2) every email.ts export is classified transactional/sequence/helper, and the
//        header contract for each bucket holds (tests 8-10 in the phase-25 spec §6).
//   (I3) the single-Resend-transport invariant, scoped to NON-TEST sources (test 11).

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-email-deliverability-guard-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.RESEND_API_KEY = "re_test_key";
process.env.UNSUBSCRIBE_SECRET = "unsub-secret-value";
process.env.UNSUBSCRIBE_BASE_URL = "https://studio.bythereeses.com";
process.env.ALERT_EMAIL = "tyler@example.com";

const realFetch = globalThis.fetch;
let capturedBodies: Array<Record<string, unknown>> = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (String(url).includes("api.resend.com")) {
    capturedBodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return realFetch(url as string, init as RequestInit);
}) as unknown as typeof fetch;

// Pure classification-sync helper — asserted directly against a synthetic export list
// (spec test 10), independent of the real module, so a fixture doesn't need to actually
// add an unclassified export to src/lib/email.ts.
function findUnclassifiedExports(exportNames: string[], classification: Record<string, string>): string[] {
  return exportNames.filter((name) => !(name in classification));
}

function assertNoListUnsubscribe(bodies: Array<Record<string, unknown>>, label: string) {
  assert.ok(bodies.length > 0, `${label}: expected at least one outbound Resend call`);
  for (const body of bodies) {
    const headers = body.headers as Record<string, string> | undefined;
    assert.ok(!headers?.["List-Unsubscribe"], `${label}: a transactional sender must NOT carry a List-Unsubscribe header`);
  }
}

// Recursive, dependency-free walk of `src/` (mirrors run-tests.mjs's own collector).
function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function grepApiResendCom(root: string, { excludeTestFiles }: { excludeTestFiles: boolean }): string[] {
  const files = walk(root).filter((file) => /\.(ts|tsx|mjs|js)$/.test(file));
  const matches: string[] = [];
  for (const file of files) {
    // Match the runner's full discovery pattern (scripts/run-tests.mjs collects .test.{mjs,ts,tsx};
    // .js included for completeness) so a future .test.tsx stub can't false-positive this guard.
    if (excludeTestFiles && /\.test\.(ts|tsx|mjs|js)$/.test(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    if (content.includes("api.resend.com")) matches.push(file);
  }
  return matches;
}

async function main() {
  const emailModule = await import("./email");
  const {
    sendProjectEmail,
    sendSequenceEmail,
    sendInquiryReplyEmail,
    sendAdminAlertEmail,
    sendPortalMagicLinkEmail,
    sendBookingEmails,
    sendBookingReminderEmail,
    sendBookingCancellationEmail,
    SENDER_CLASSIFICATION,
  } = emailModule as typeof emailModule & { SENDER_CLASSIFICATION: Record<string, "transactional" | "sequence" | "helper"> };

  // =========================================================================
  // Test 10 — classification map stays in sync with the module's actual runtime
  // (function) exports, in BOTH directions; a third "helper" bucket exists for
  // isEmailSuppressed (a predicate, not a mail sender).
  // =========================================================================
  {
    // Synthetic fixture (no real unclassified export needed) — an unclassified new export
    // must be caught by name, with helper entries correctly exempted.
    const synthetic = findUnclassifiedExports(
      ["sendNewThing", "isEmailSuppressed"],
      { isEmailSuppressed: "helper" },
    );
    assert.deepEqual(synthetic, ["sendNewThing"], "an unclassified new export must fail the sync check by name");
  }

  const functionExportNames = Object.keys(emailModule).filter(
    (key) => typeof (emailModule as unknown as Record<string, unknown>)[key] === "function",
  );
  const unclassifiedReal = findUnclassifiedExports(functionExportNames, SENDER_CLASSIFICATION);
  assert.deepEqual(
    unclassifiedReal,
    [],
    `every exported function in email.ts must have a SENDER_CLASSIFICATION entry — classify as transactional, sequence, or helper before merging (missing: ${unclassifiedReal.join(", ")})`,
  );
  const phantomEntries = Object.keys(SENDER_CLASSIFICATION).filter((name) => !functionExportNames.includes(name));
  assert.deepEqual(phantomEntries, [], "SENDER_CLASSIFICATION must not reference an export that no longer exists in email.ts");
  assert.equal(
    SENDER_CLASSIFICATION.isEmailSuppressed,
    "helper",
    "isEmailSuppressed is a predicate helper (used by both transactional and sequence senders), not a mail sender — neither transactional nor sequence",
  );

  // =========================================================================
  // Fixtures for the driven header assertions below (tests 8-9).
  // =========================================================================
  const { rawDb, db } = await import("@/db/client");
  const { schedulerBookings, schedulerMeetingTypes } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const database = rawDb();
  const now = "2026-07-06T12:00:00.000Z";
  database.prepare(
    `INSERT INTO scheduler_meeting_types (id, slug, name, duration_minutes, buffer_minutes, location_type, location_label, zoom_join_url, is_active, created_at, updated_at)
     VALUES ('mt-guard', 'guard-consult', 'Guard Consult', 30, 10, 'zoom', 'Zoom', 'https://zoom.us/j/000', 1, ?, ?)`,
  ).run(now, now);
  database.prepare(
    `INSERT INTO scheduler_bookings (id, meeting_type_id, attendee_name, attendee_email, start_at, end_at, status, created_at, updated_at)
     VALUES ('bk-guard', 'mt-guard', 'Guard Client', 'guard-client@example.com', ?, ?, 'confirmed', ?, ?)`,
  ).run("2026-07-10T15:00:00.000Z", "2026-07-10T16:00:00.000Z", now, now);
  const booking = await db.query.schedulerBookings.findFirst({ where: eq(schedulerBookings.id, "bk-guard") });
  const meetingType = await db.query.schedulerMeetingTypes.findFirst({ where: eq(schedulerMeetingTypes.id, "mt-guard") });
  assert.ok(booking && meetingType, "guard test fixtures (booking + meeting type) must exist");

  const drivenSequence = new Set<string>();
  const drivenTransactional = new Set<string>();

  // =========================================================================
  // Test 8 — the ONE "sequence"-classified sender carries both RFC 8058 headers.
  // =========================================================================
  capturedBodies = [];
  const seqResult = await sendSequenceEmail({ to: "seq-fresh@example.com", subject: "Reminder", text: "hello" });
  assert.equal(seqResult.ok, true, "sequence guard fixture send must succeed (fresh, non-suppressed address)");
  assert.equal(capturedBodies.length, 1);
  const seqHeaders = (capturedBodies[0].headers ?? {}) as Record<string, string>;
  assert.ok(seqHeaders["List-Unsubscribe"], "sendSequenceEmail must carry a List-Unsubscribe header");
  assert.equal(seqHeaders["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click", "sendSequenceEmail must carry RFC 8058 List-Unsubscribe-Post");
  drivenSequence.add("sendSequenceEmail");

  // =========================================================================
  // Test 9 — every "transactional"-classified sender omits BOTH headers.
  // =========================================================================
  capturedBodies = [];
  await sendAdminAlertEmail({ subject: "Test alert", text: "body" });
  assertNoListUnsubscribe(capturedBodies, "sendAdminAlertEmail");
  drivenTransactional.add("sendAdminAlertEmail");

  capturedBodies = [];
  await sendPortalMagicLinkEmail({
    to: "portal-guard@example.com",
    clientFirstName: "Sam",
    links: [{ projectName: "Test Project", url: "https://example.com/portal" }],
    ttlMinutes: 30,
  });
  assertNoListUnsubscribe(capturedBodies, "sendPortalMagicLinkEmail");
  drivenTransactional.add("sendPortalMagicLinkEmail");

  capturedBodies = [];
  await sendBookingEmails({ booking: booking!, meetingType: meetingType! });
  assertNoListUnsubscribe(capturedBodies, "sendBookingEmails");
  drivenTransactional.add("sendBookingEmails");

  capturedBodies = [];
  await sendBookingReminderEmail({ booking: booking!, meetingType: meetingType! });
  assertNoListUnsubscribe(capturedBodies, "sendBookingReminderEmail");
  drivenTransactional.add("sendBookingReminderEmail");

  capturedBodies = [];
  await sendBookingCancellationEmail({ booking: booking!, meetingType: meetingType! });
  assertNoListUnsubscribe(capturedBodies, "sendBookingCancellationEmail");
  drivenTransactional.add("sendBookingCancellationEmail");

  capturedBodies = [];
  await sendInquiryReplyEmail({ to: "inquiry-fresh@example.com", subject: "Re: hi", text: "body" });
  assertNoListUnsubscribe(capturedBodies, "sendInquiryReplyEmail");
  drivenTransactional.add("sendInquiryReplyEmail");

  capturedBodies = [];
  await sendProjectEmail({ to: "project-fresh@example.com", subject: "Update", text: "body" });
  assertNoListUnsubscribe(capturedBodies, "sendProjectEmail");
  drivenTransactional.add("sendProjectEmail");

  // Completeness: every classified "sequence"/"transactional" export was actually exercised
  // above — a new sender added to either bucket without corresponding coverage here fails loudly
  // rather than silently shipping unverified.
  const classifiedSequence = Object.entries(SENDER_CLASSIFICATION).filter(([, c]) => c === "sequence").map(([n]) => n);
  const classifiedTransactional = Object.entries(SENDER_CLASSIFICATION).filter(([, c]) => c === "transactional").map(([n]) => n);
  assert.deepEqual([...drivenSequence].sort(), classifiedSequence.sort(), "every 'sequence'-classified export must be exercised by this guard test");
  assert.deepEqual(
    [...drivenTransactional].sort(),
    classifiedTransactional.sort(),
    "every 'transactional'-classified export must be exercised by this guard test",
  );

  // =========================================================================
  // Test 11 (I3, §3.3, MAJOR 2) — single-transport guard, scoped to NON-TEST sources.
  // =========================================================================
  const srcRoot = path.join(process.cwd(), "src");
  const nonTestMatches = grepApiResendCom(srcRoot, { excludeTestFiles: true });
  const relNonTest = nonTestMatches.map((f) => path.relative(process.cwd(), f).split(path.sep).join("/"));
  assert.deepEqual(
    relNonTest,
    ["src/lib/email.ts"],
    "the literal api.resend.com must appear in EXACTLY one non-test file under src/: src/lib/email.ts — any other match is transport drift",
  );

  // MAJOR 2 — prove the scoping is load-bearing, not decorative: an UNSCOPED grep is red on
  // arrival because 8+ existing test files already reuse this literal as a fetch-stub idiom
  // (`if (String(url).includes("api.resend.com")) ...`), and this guard test file itself
  // (tests 8-9 above) makes another. Every match the unscoped grep adds beyond the single
  // non-test hit must itself be a *.test.ts/*.test.mjs file — never undocumented drift.
  const allMatches = grepApiResendCom(srcRoot, { excludeTestFiles: false });
  const testOnlyExtras = allMatches.filter((f) => !nonTestMatches.includes(f));
  assert.ok(
    testOnlyExtras.length >= 8,
    `expected at least 8 pre-existing test-file stubs (phase-25 spec §3.3) plus this guard test itself; found ${testOnlyExtras.length}`,
  );
  for (const file of testOnlyExtras) {
    assert.ok(
      /\.(test)\.(ts|mjs)$/.test(file),
      `unscoped-only match ${file} must be a *.test.ts/*.test.mjs file (the documented stub idiom), not undiscovered transport drift`,
    );
  }
  assert.ok(
    testOnlyExtras.some((f) => f.endsWith("email-deliverability-guard.test.ts")),
    "this guard test file's own fetch stub (tests 8-9 above) should also match the unscoped grep",
  );

  globalThis.fetch = realFetch;
  console.log("email deliverability guard tests passed");
}

main().catch((error) => {
  globalThis.fetch = realFetch;
  console.error(error);
  process.exit(1);
});
