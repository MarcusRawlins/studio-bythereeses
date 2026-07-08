import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-sequences-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.RESEND_API_KEY = "re_test_key";
process.env.UNSUBSCRIBE_SECRET = "unsub-secret-value";
process.env.UNSUBSCRIBE_BASE_URL = "https://studio.bythereeses.com";

// Clean flag env at import time — every SEQUENCES_* flag starts OFF.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("SEQUENCES_")) delete process.env[key];
}

// Controllable Resend/Twilio transport spy.
const realFetch = globalThis.fetch;
let resendCalls = 0;
let twilioCalls = 0;
let resendMode: "ok" | "throw" | "reject" = "ok";
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("api.resend.com")) {
    resendCalls += 1;
    if (resendMode === "throw") throw new Error("network down");
    if (resendMode === "reject") return new Response("bad", { status: 422 });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  if (u.includes("api.twilio.com")) twilioCalls += 1;
  return realFetch(url as string, init as RequestInit);
}) as unknown as typeof fetch;

const NOW = new Date("2026-07-06T15:00:00.000Z"); // 11:00 ET — within business hours
const NOW2 = new Date("2026-07-13T15:00:00.000Z");

async function main() {
  const { rawDb } = await import("@/db/client");
  const seq = await import("./sequences");
  const database = rawDb();

  const iso = "2026-07-06T12:00:00.000Z";

  // ---- fixture helpers ----
  function addProject(id: string, opts: { eventDate?: string } = {}) {
    database.prepare(
      "INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at) VALUES (?, ?, 'wedding', 'inquiry', 'active', ?, ?, ?)",
    ).run(id, `${id} project`, opts.eventDate ?? null, iso, iso);
  }
  function addClient(id: string, email: string) {
    database.prepare(
      "INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at) VALUES (?, ?, 'Client', ?, ?, ?)",
    ).run(id, id, email, iso, iso);
  }
  function link(projectId: string, clientId: string) {
    database.prepare(
      "INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at) VALUES (?, ?, ?, 'primary', 1, ?)",
    ).run(`p-${projectId}-${clientId}`, projectId, clientId, iso);
  }
  function addOverdueInvoice(id: string, projectId: string, dueDate: string, totalCents = 100000) {
    database.prepare(
      "INSERT INTO invoices (id, project_id, invoice_number, status, total_cents, amount_paid_cents, due_date, created_at, updated_at) VALUES (?, ?, ?, 'sent', ?, 0, ?, ?, ?)",
    ).run(id, projectId, `INV-${id}`, totalCents, dueDate, iso, iso);
    database.prepare(
      "INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, paid_amount_cents, created_at, updated_at) VALUES (?, ?, 'Balance', ?, ?, 'pending', 0, ?, ?)",
    ).run(`pay-${id}`, id, totalCents, dueDate, iso, iso);
  }
  const draftsFor = (projectId: string) =>
    (database.prepare("SELECT COUNT(*) AS c FROM project_communications WHERE project_id = ? AND source_type = 'sequence_step' AND status = 'draft'").get(projectId) as { c: number }).c;
  const sentFor = (projectId: string) =>
    (database.prepare("SELECT COUNT(*) AS c FROM project_communications WHERE project_id = ? AND source_type = 'sequence_step' AND status = 'sent'").get(projectId) as { c: number }).c;
  const ledger = (projectId: string) =>
    database.prepare("SELECT step_key AS stepKey, status, mode FROM sequence_sends WHERE project_id = ? ORDER BY step_key").all(projectId) as Array<{ stepKey: string; status: string; mode: string }>;
  const enrollmentStatus = (sequenceKey: string, anchorKey: string) =>
    (database.prepare("SELECT status FROM sequence_enrollments WHERE sequence_key = ? AND anchor_key = ?").get(sequenceKey, anchorKey) as { status: string } | undefined)?.status;
  const activityCount = (action: string) =>
    (database.prepare("SELECT COUNT(*) AS c FROM activity_logs WHERE action = ?").get(action) as { c: number }).c;

  // =========================================================================
  // A. FLAG OFF — SEQUENCES_ENABLED unset ⇒ hard no-op.
  // =========================================================================
  addProject("project-dun");
  addClient("client-dun", "dun@example.com");
  link("project-dun", "client-dun");
  addOverdueInvoice("invoice-dun", "project-dun", "2026-06-16"); // 20 days overdue

  const off = await seq.runDueSequences(NOW);
  assert.deepEqual(off, { skipped: "flag_off" }, "SEQUENCES_ENABLED unset → {skipped:flag_off}");
  assert.equal((database.prepare("SELECT COUNT(*) AS c FROM sequence_enrollments").get() as { c: number }).c, 0, "flag off: zero enrollments");
  assert.equal((database.prepare("SELECT COUNT(*) AS c FROM sequence_sends").get() as { c: number }).c, 0, "flag off: zero ledger rows");
  assert.equal((database.prepare("SELECT COUNT(*) AS c FROM project_communications").get() as { c: number }).c, 0, "flag off: zero comms");

  process.env.SEQUENCES_ENABLED = "1";
  process.env.SEQUENCES_DUNNING = "1";

  // =========================================================================
  // B. IDEMPOTENCY + ONE-STEP-PER-RUN (late enrollment 20 days overdue).
  //    Two runs → exactly ONE draft (latest-due day-14), earlier steps
  //    superseded, and ZERO Resend calls (draft mode, autosend off).
  // =========================================================================
  await seq.runDueSequences(NOW);
  await seq.runDueSequences(NOW);
  assert.equal(draftsFor("project-dun"), 1, "late 20-day enrollment fires exactly ONE draft across two runs");
  assert.equal(resendCalls, 0, "draft mode makes ZERO Resend calls");
  const dunLedger = ledger("project-dun");
  const byStep = Object.fromEntries(dunLedger.map((r) => [r.stepKey, r.status]));
  assert.equal(byStep["dunning-day-14"], "done", "latest-due day-14 is the fired (done) step");
  assert.equal(byStep["dunning-day-7"], "superseded", "day-7 superseded (not day-1/7/14 at once)");
  assert.equal(byStep["dunning-day-1"], "superseded", "day-1 superseded");
  const draftRow = database.prepare("SELECT subject, created_by, channel FROM project_communications WHERE project_id = 'project-dun'").get() as { subject: string; created_by: string; channel: string };
  assert.ok(/gentle reminder/i.test(draftRow.subject), "dunning template rendered (gentle tone)");
  assert.equal(draftRow.created_by, "system", "draft created by systemActor");
  assert.equal(draftRow.channel, "email", "dunning is email");

  // =========================================================================
  // C. DUNNING STOPS ON PAID — re-checked at fire time.
  // =========================================================================
  addProject("project-stop");
  addClient("client-stop", "stop@example.com");
  link("project-stop", "client-stop");
  addOverdueInvoice("invoice-stop", "project-stop", "2026-06-28"); // 8 days overdue → day-7 due, day-14 not yet
  await seq.runDueSequences(NOW);
  assert.equal(draftsFor("project-stop"), 1, "8-day-overdue invoice drafts one step (day-7)");
  assert.equal(ledger("project-stop").find((r) => r.stepKey === "dunning-day-7")?.status, "done", "day-7 fired");

  // Pay the invoice in full.
  database.prepare("UPDATE invoice_payments SET status = 'paid', paid_amount_cents = 100000 WHERE id = 'pay-invoice-stop'").run();
  database.prepare("UPDATE invoices SET amount_paid_cents = 100000 WHERE id = 'invoice-stop'").run();
  await seq.runDueSequences(NOW2); // day-14 is now due — but stop-on-paid must win
  assert.equal(enrollmentStatus("dunning", "invoice-stop"), "completed", "paid invoice → enrollment completed at fire time");
  assert.equal(draftsFor("project-stop"), 1, "no further dunning step fires after payment (still just day-7)");

  // =========================================================================
  // D. FREQUENCY CAP — a client at the weekly cap is skipped (no slot consumed).
  // =========================================================================
  addProject("project-cap");
  addClient("client-cap", "cap@example.com");
  link("project-cap", "client-cap");
  addOverdueInvoice("invoice-cap", "project-cap", "2026-06-16");
  for (let i = 0; i < 3; i += 1) {
    database.prepare(
      "INSERT INTO sequence_sends (id, project_id, client_id, sequence_key, step_key, dedupe_key, channel, mode, status, attempts, fired_at) VALUES (?, 'project-cap', 'client-cap', 'dunning', ?, ?, 'email', 'draft', 'done', 0, ?)",
    ).run(`cap-fill-${i}`, `filler-${i}`, `cap-filler-${i}`, "2026-07-05T12:00:00.000Z");
  }
  const cappedBefore = activityCount("sequence.capped");
  await seq.runDueSequences(NOW);
  assert.equal(draftsFor("project-cap"), 0, "capped client gets NO draft");
  assert.ok(activityCount("sequence.capped") > cappedBefore, "sequence.capped activity logged");
  assert.equal(ledger("project-cap").filter((r) => r.stepKey.startsWith("dunning-day")).length, 0, "capped run consumes NO ledger slot for the real step");

  // =========================================================================
  // E. PRE-EVENT CONDITIONALS — questionnaire/booking presence skips steps.
  // =========================================================================
  process.env.SEQUENCES_PREEVENT = "1";
  // pe-skip: has a questionnaire response AND a confirmed timeline booking.
  addProject("project-pe-skip", { eventDate: "2026-07-16" });
  addClient("client-pe-skip", "peskip@example.com");
  link("project-pe-skip", "client-pe-skip");
  database.prepare("INSERT INTO questionnaires (id, title, status, created_at, updated_at) VALUES ('q-1', 'Planning', 'active', ?, ?)").run(iso, iso);
  database.prepare(
    "INSERT INTO questionnaire_responses (id, questionnaire_id, project_id, answers_json, created_at, updated_at) VALUES ('qr-1', 'q-1', 'project-pe-skip', '[]', ?, ?)",
  ).run(iso, iso);
  database.prepare(
    "INSERT INTO scheduler_meeting_types (id, slug, name, created_at, updated_at) VALUES ('mt-timeline', 'timeline-planning', 'Timeline Planning Call', ?, ?)",
  ).run(iso, iso);
  database.prepare(
    "INSERT INTO scheduler_bookings (id, meeting_type_id, project_id, attendee_name, attendee_email, start_at, end_at, status, created_at, updated_at) VALUES ('bk-1', 'mt-timeline', 'project-pe-skip', 'Client', 'peskip@example.com', ?, ?, 'confirmed', ?, ?)",
  ).run("2026-07-10T15:00:00.000Z", "2026-07-10T16:00:00.000Z", iso, iso);

  // pe-fire: no questionnaire, no booking → questionnaire step fires.
  addProject("project-pe-fire", { eventDate: "2026-07-16" });
  addClient("client-pe-fire", "pefire@example.com");
  link("project-pe-fire", "client-pe-fire");

  await seq.runDueSequences(NOW);
  assert.equal(draftsFor("project-pe-skip"), 0, "questionnaire present + call booked ⇒ pre-event steps skip");
  assert.equal(draftsFor("project-pe-fire"), 1, "no questionnaire/booking ⇒ a pre-event step drafts");
  const peSubject = (database.prepare("SELECT subject FROM project_communications WHERE project_id = 'project-pe-fire'").get() as { subject: string }).subject;
  assert.ok(/questionnaire/i.test(peSubject), "latest-due pre-event step (questionnaire) rendered");

  // =========================================================================
  // F. AUTO-SEND vs DRAFT — dunning auto-sends only with the per-sequence opt-in.
  // =========================================================================
  process.env.SEQUENCES_DUNNING_AUTOSEND = "1";
  addProject("project-auto");
  addClient("client-auto", "auto@example.com");
  link("project-auto", "client-auto");
  addOverdueInvoice("invoice-auto", "project-auto", "2026-06-16");
  resendMode = "ok";
  const resendBeforeAuto = resendCalls;
  await seq.runDueSequences(NOW);
  assert.equal(resendCalls - resendBeforeAuto, 1, "auto-send opt-in → exactly one Resend call (claim→send→done)");
  assert.equal(sentFor("project-auto"), 1, "auto-send materializes a SENT email comm");
  assert.equal(draftsFor("project-auto"), 0, "auto-send does not leave a draft");
  const autoLedger = ledger("project-auto").find((r) => r.stepKey === "dunning-day-14");
  assert.equal(autoLedger?.status, "done", "auto-send ledger row done");
  assert.equal(autoLedger?.mode, "auto_send", "ledger mode auto_send");
  // SMS never auto-sends: no sequence ever produced an sms comm.
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM project_communications WHERE channel = 'sms' AND source_type = 'sequence_step'").get() as { c: number }).c,
    0,
    "no sequence ever produces an SMS comm (SMS never auto-sends)",
  );

  // =========================================================================
  // G. REVIEW is DRAFT-ONLY even with autosend flags on elsewhere.
  // =========================================================================
  process.env.SEQUENCES_REVIEW = "1";
  addProject("project-rev");
  addClient("client-rev", "rev@example.com");
  link("project-rev", "client-rev");
  database.prepare(
    "INSERT INTO project_workflow_runs (id, project_id, workflow_key, workflow_name, status, selected_step_keys_json, created_at, updated_at) VALUES ('run-1', 'project-rev', 'six-figure-maximized-workflow', 'wf', 'active', '[]', ?, ?)",
  ).run(iso, iso);
  database.prepare(
    "INSERT INTO project_workflow_steps (id, workflow_run_id, project_id, step_key, title, instructions, assigned_agent, status, created_at, updated_at) VALUES ('ws-1', 'run-1', 'project-rev', 'gallery-delivery', 'Deliver', 'x', 'Agent', 'completed', ?, ?)",
  ).run("2026-07-01T12:00:00.000Z", "2026-07-01T12:00:00.000Z");
  const resendBeforeReview = resendCalls;
  await seq.runDueSequences(NOW);
  assert.equal(draftsFor("project-rev"), 1, "review request drafts (never auto-sends, autoSendEligible false)");
  assert.equal(resendCalls - resendBeforeReview, 0, "review sends nothing even with autosend flags on elsewhere");
  assert.ok(/feedback/i.test((database.prepare("SELECT subject FROM project_communications WHERE project_id = 'project-rev'").get() as { subject: string }).subject), "review template rendered");
  assert.equal(enrollmentStatus("post_delivery_review", "ws-1"), "completed", "single-step review completes after firing");

  // =========================================================================
  // H. CLAIMED IS TERMINAL — a throw-after-dispatch leaves the row claimed and
  //    is NEVER auto-retried; only provably-not-sent rows retry.
  // =========================================================================
  addProject("project-stuck");
  addClient("client-stuck", "stuck@example.com");
  link("project-stuck", "client-stuck");
  addOverdueInvoice("invoice-stuck", "project-stuck", "2026-06-16");
  resendMode = "throw";
  const resendBeforeStuck = resendCalls;
  await seq.runDueSequences(NOW); // claim → send throws → stays claimed
  assert.equal(resendCalls - resendBeforeStuck, 1, "one send ATTEMPT for the stuck step");
  assert.equal(sentFor("project-stuck"), 0, "throw-after-dispatch produces NO sent comm");
  assert.equal(ledger("project-stuck").find((r) => r.stepKey === "dunning-day-14")?.status, "claimed", "row is claimed (terminal-unknown)");
  const resendBeforeRerun = resendCalls;
  await seq.runDueSequences(NOW); // re-run must NOT re-send the claimed row
  assert.equal(resendCalls - resendBeforeRerun, 0, "claimed row is NEVER auto-retried (no second send)");

  // send_stuck surfacing for a claimed row older than one run interval.
  database.prepare(
    "INSERT INTO sequence_sends (id, project_id, client_id, sequence_key, step_key, dedupe_key, channel, mode, status, attempts, fired_at, note) VALUES ('old-claim', 'project-stuck', 'client-stuck', 'dunning', 'dunning-day-1', 'old-claim-key', 'email', 'auto_send', 'claimed', 1, '2026-07-01T12:00:00.000Z', NULL)",
  ).run();
  const stuckBefore = activityCount("sequence.send_stuck");
  await seq.runDueSequences(NOW);
  assert.ok(activityCount("sequence.send_stuck") > stuckBefore, "old claimed row surfaced via sequence.send_stuck");
  assert.equal(
    (database.prepare("SELECT note FROM sequence_sends WHERE id = 'old-claim'").get() as { note: string }).note,
    "stuck_surfaced",
    "surfaced row is marked so it is not re-logged every run",
  );

  // failed (provably-not-sent) row IS retryable, unlike claimed.
  resendMode = "reject"; // 4xx → provably not sent → failed
  addProject("project-fail");
  addClient("client-fail", "fail@example.com");
  link("project-fail", "client-fail");
  addOverdueInvoice("invoice-fail", "project-fail", "2026-06-16");
  await seq.runDueSequences(NOW);
  assert.equal(ledger("project-fail").find((r) => r.stepKey === "dunning-day-14")?.status, "failed", "pre-acceptance 4xx → failed (retryable)");

  // =========================================================================
  // K. B1 — a retry renders from its OWN enrollment (no cross-client leak).
  //    Two dunning enrollments (different clients/invoices) both fail, then each
  //    retry must render its OWN invoice number — never the other client's.
  // =========================================================================
  const NOWRETRY = new Date("2026-07-07T16:00:00.000Z"); // +25h: past 24h backoff, business hours
  resendMode = "reject";
  addProject("project-b1x");
  addClient("client-b1x", "b1x@example.com");
  link("project-b1x", "client-b1x");
  addOverdueInvoice("invoice-b1x", "project-b1x", "2026-06-16");
  addProject("project-b1y");
  addClient("client-b1y", "b1y@example.com");
  link("project-b1y", "client-b1y");
  addOverdueInvoice("invoice-b1y", "project-b1y", "2026-06-16");
  await seq.runDueSequences(NOW); // both auto-send → reject → failed
  assert.equal(ledger("project-b1x").find((r) => r.stepKey === "dunning-day-14")?.status, "failed", "b1x failed on first attempt");
  assert.equal(ledger("project-b1y").find((r) => r.stepKey === "dunning-day-14")?.status, "failed", "b1y failed on first attempt");

  resendMode = "ok";
  await seq.runDueSequences(NOWRETRY); // retry both
  const b1xSubject = (database.prepare("SELECT subject FROM project_communications WHERE project_id = 'project-b1x' AND status = 'sent'").get() as { subject: string } | undefined)?.subject ?? "";
  const b1ySubject = (database.prepare("SELECT subject FROM project_communications WHERE project_id = 'project-b1y' AND status = 'sent'").get() as { subject: string } | undefined)?.subject ?? "";
  assert.equal(sentFor("project-b1x"), 1, "b1x retry sends exactly once");
  assert.equal(sentFor("project-b1y"), 1, "b1y retry sends exactly once");
  assert.ok(b1xSubject.includes("INV-invoice-b1x"), "b1x retry renders b1x's OWN invoice");
  assert.ok(b1ySubject.includes("INV-invoice-b1y"), "b1y retry renders b1y's OWN invoice");
  assert.equal(b1xSubject.includes("INV-invoice-b1y"), false, "b1x retry does NOT leak b1y's invoice (cross-client leak closed)");

  // =========================================================================
  // L. B2 — CAS: two interleaved retry passes over one failed row → ONE send.
  // =========================================================================
  const NOWRETRY2 = new Date("2026-07-07T16:30:00.000Z");
  resendMode = "reject";
  addProject("project-b2");
  addClient("client-b2", "b2@example.com");
  link("project-b2", "client-b2");
  addOverdueInvoice("invoice-b2", "project-b2", "2026-06-16");
  await seq.runDueSequences(NOW); // → failed
  assert.equal(ledger("project-b2").find((r) => r.stepKey === "dunning-day-14")?.status, "failed", "b2 failed on first attempt");

  resendMode = "ok";
  await Promise.all([seq.runDueSequences(NOWRETRY2), seq.runDueSequences(NOWRETRY2)]);
  assert.equal(sentFor("project-b2"), 1, "two interleaved retry passes over one failed row produce EXACTLY one send (CAS)");
  assert.equal(ledger("project-b2").find((r) => r.stepKey === "dunning-day-14")?.status, "done", "b2 retry row ends done (single send)");

  // =========================================================================
  // M. DAILY SEND CAP (Phase 25 §3.4) — SEQUENCES_DAILY_SEND_CAP_ENABLED /
  //    SEQUENCES_DAILY_SEND_CAP: a global, dark-by-default backstop independent
  //    of the per-client weekly cap above. Filler ledger rows use a clientId/
  //    projectId NOT tied to any real fixture so they never trip the per-client
  //    cap for the enrollment actually under test in each sub-case. Start from a
  //    clean slate: freeze every pre-existing 'active' enrollment (so none of
  //    them get reconsidered by the main enrollment loop below — several have
  //    an un-fired/blocked step from earlier sections) and clear stray
  //    done/claimed auto_send ledger rows (e.g. project-stuck's 'old-claim')
  //    that would otherwise contaminate the global daily-cap count query,
  //    which scans the WHOLE table regardless of enrollment status.
  // =========================================================================
  // Full reset between sub-cases below: stop EVERY 'active' enrollment (so nothing —
  // not even this section's own prior fixtures — gets reconsidered by the main
  // enrollment loop) and wipe the auto_send ledger (the global daily-cap count query
  // scans the WHOLE table regardless of project/enrollment status, so a prior
  // sub-case's own successful send would otherwise silently contaminate the next
  // sub-case's "clean baseline" assumption).
  function resetDailyCapState() {
    database.prepare("UPDATE sequence_enrollments SET status = 'stopped' WHERE status = 'active'").run();
    database.prepare("DELETE FROM sequence_sends WHERE mode = 'auto_send'").run();
  }

  function seedAutoSendRow(id: string, firedAt: string, status: "done" | "claimed" = "done") {
    database.prepare(
      "INSERT INTO sequence_sends (id, project_id, client_id, sequence_key, step_key, dedupe_key, channel, mode, status, attempts, fired_at) VALUES (?, 'filler-daily-cap-project', 'filler-daily-cap-client', 'dunning', ?, ?, 'email', 'auto_send', ?, 0, ?)",
    ).run(id, id, id, status, firedAt);
  }

  resetDailyCapState();
  delete process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED;
  delete process.env.SEQUENCES_DAILY_SEND_CAP;

  // ---- M1 (test 12): flag OFF is a hard no-op — the cap is never consulted, even
  //      when the trailing-24h count already sits well over the (unread) cap. ----
  for (let i = 0; i < 60; i += 1) seedAutoSendRow(`cap-off-${i}`, NOW.toISOString());
  addProject("project-cap-off");
  addClient("client-cap-off", "capoff@example.com");
  link("project-cap-off", "client-cap-off");
  addOverdueInvoice("invoice-cap-off", "project-cap-off", "2026-06-16");
  resendMode = "ok";
  const resendBeforeCapOff = resendCalls;
  await seq.runDueSequences(NOW);
  assert.equal(resendCalls - resendBeforeCapOff, 1, "flag OFF: cap not consulted, auto-send proceeds normally despite 60 seeded auto-sends");
  assert.equal(ledger("project-cap-off").find((r) => r.stepKey === "dunning-day-14")?.status, "done", "flag off auto-send completes normally");

  // ---- M2 (test 13): flag ON + cap=2, with 2 'done' rows already in the trailing
  //      24h -> the 3rd eligible step is BLOCKED (zero Resend calls, no ledger row
  //      claimed, step remains due / re-evaluates on a simulated next run). ----
  resetDailyCapState();
  process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED = "1";
  process.env.SEQUENCES_DAILY_SEND_CAP = "2";
  seedAutoSendRow("cap-trip-1", NOW.toISOString());
  seedAutoSendRow("cap-trip-2", NOW.toISOString());
  addProject("project-cap-trip");
  addClient("client-cap-trip", "captrip@example.com");
  link("project-cap-trip", "client-cap-trip");
  addOverdueInvoice("invoice-cap-trip", "project-cap-trip", "2026-06-16");
  const resendBeforeCapTrip = resendCalls;
  await seq.runDueSequences(NOW);
  assert.equal(resendCalls - resendBeforeCapTrip, 0, "tripped cap: zero Resend calls");
  assert.equal(ledger("project-cap-trip").filter((r) => r.stepKey === "dunning-day-14").length, 0, "tripped cap: NO ledger row claimed for the blocked step");
  await seq.runDueSequences(NOW); // simulated next run, same seeded volume still trips
  assert.equal(ledger("project-cap-trip").filter((r) => r.stepKey === "dunning-day-14").length, 0, "capped step stays re-evaluable across runs (never claimed, so never 'used up')");

  // ---- M3 (test 14): trailing-24h window, NOT a calendar day — a row fired 25h
  //      ago does not count toward the cap; one fired 23h ago does. ----
  resetDailyCapState();
  process.env.SEQUENCES_DAILY_SEND_CAP = "1";
  const twentyFiveHoursAgo = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
  seedAutoSendRow("cap-window-25h", twentyFiveHoursAgo);
  addProject("project-cap-window-old");
  addClient("client-cap-window-old", "capwindowold@example.com");
  link("project-cap-window-old", "client-cap-window-old");
  addOverdueInvoice("invoice-cap-window-old", "project-cap-window-old", "2026-06-16");
  const resendBeforeWindowOld = resendCalls;
  await seq.runDueSequences(NOW);
  assert.equal(resendCalls - resendBeforeWindowOld, 1, "a row fired 25h ago is OUTSIDE the 24h window -> does not count -> send proceeds");

  resetDailyCapState();
  const twentyThreeHoursAgo = new Date(NOW.getTime() - 23 * 60 * 60 * 1000).toISOString();
  seedAutoSendRow("cap-window-23h", twentyThreeHoursAgo);
  addProject("project-cap-window-new");
  addClient("client-cap-window-new", "capwindownew@example.com");
  link("project-cap-window-new", "client-cap-window-new");
  addOverdueInvoice("invoice-cap-window-new", "project-cap-window-new", "2026-06-16");
  const resendBeforeWindowNew = resendCalls;
  await seq.runDueSequences(NOW);
  assert.equal(resendCalls - resendBeforeWindowNew, 0, "a row fired 23h ago IS inside the 24h window -> counts -> cap=1 blocks the send");

  // ---- M4 (test 15): the retry path also respects the daily cap, and a
  //      successful retry dispatch REFRESHES firedAt (rev 2 MAJOR 1) so it lands
  //      inside the NEXT run's trailing-24h count. ----
  resetDailyCapState();
  delete process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED;
  resendMode = "reject";
  addProject("project-cap-retry");
  addClient("client-cap-retry", "capretry@example.com");
  link("project-cap-retry", "client-cap-retry");
  addOverdueInvoice("invoice-cap-retry", "project-cap-retry", "2026-06-16");
  await seq.runDueSequences(NOW); // auto-send attempt rejects -> "failed"
  assert.equal(ledger("project-cap-retry").find((r) => r.stepKey === "dunning-day-14")?.status, "failed", "cap-retry fixture failed on first attempt");
  const originalFiredAt = (
    database.prepare("SELECT fired_at AS firedAt FROM sequence_sends WHERE project_id = 'project-cap-retry' AND step_key = 'dunning-day-14'").get() as { firedAt: string }
  ).firedAt;

  const NOWRETRY_CAP = new Date(NOW.getTime() + 25 * 60 * 60 * 1000); // past the 24h retry backoff, business hours

  // (a) cap ENABLED and already tripped -> the retry must NOT claim/send; the row stays 'failed'.
  process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED = "1";
  process.env.SEQUENCES_DAILY_SEND_CAP = "1";
  seedAutoSendRow("cap-retry-filler", NOWRETRY_CAP.toISOString());
  resendMode = "ok";
  const resendBeforeCappedRetry = resendCalls;
  await seq.runDueSequences(NOWRETRY_CAP);
  assert.equal(resendCalls - resendBeforeCappedRetry, 0, "tripped cap blocks the retry dispatch too");
  assert.equal(
    ledger("project-cap-retry").find((r) => r.stepKey === "dunning-day-14")?.status,
    "failed",
    "blocked retry row stays failed (retryable next run), never claimed while capped",
  );

  // (b) cap NOT tripped -> the retry proceeds, and firedAt is refreshed to ~now (not left at the
  //     original failed-send timestamp). NOTE: deliberately NOT resetDailyCapState() here — that
  //     would stop project-cap-retry's still-active enrollment, and retryFailedSends REQUIRES an
  //     active enrollment to dispatch a retry. Only clear the filler row from (a).
  database.prepare("DELETE FROM sequence_sends WHERE id = 'cap-retry-filler'").run();
  process.env.SEQUENCES_DAILY_SEND_CAP = "50";
  const resendBeforeCleanRetry = resendCalls;
  await seq.runDueSequences(NOWRETRY_CAP);
  assert.equal(resendCalls - resendBeforeCleanRetry, 1, "un-capped retry dispatches exactly once");
  const retriedRow = database
    .prepare("SELECT status, fired_at AS firedAt FROM sequence_sends WHERE project_id = 'project-cap-retry' AND step_key = 'dunning-day-14'")
    .get() as { status: string; firedAt: string };
  assert.equal(retriedRow.status, "done", "un-capped retry succeeds (resendMode=ok)");
  assert.notEqual(retriedRow.firedAt, originalFiredAt, "retry CAS refreshes firedAt (rev 2 MAJOR 1) — no longer the original failed-send timestamp");
  assert.ok(
    new Date(retriedRow.firedAt).getTime() > new Date(originalFiredAt).getTime(),
    "refreshed firedAt is later than the original failed-send timestamp",
  );

  // ---- M5 (test 16): the count filters done OR claimed — a direct regression guard
  //      against rev 1's bug (which excluded 'claimed' and would have under-counted
  //      by exactly one, letting this seed's send through). ----
  resetDailyCapState();
  process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED = "1";
  process.env.SEQUENCES_DAILY_SEND_CAP = "3";
  seedAutoSendRow("cap-doneclaimed-1", NOW.toISOString(), "done");
  seedAutoSendRow("cap-doneclaimed-2", NOW.toISOString(), "done");
  seedAutoSendRow("cap-doneclaimed-3", NOW.toISOString(), "claimed"); // the ambiguous, TERMINAL-UNKNOWN row
  addProject("project-cap-doneclaimed");
  addClient("client-cap-doneclaimed", "capdoneclaimed@example.com");
  link("project-cap-doneclaimed", "client-cap-doneclaimed");
  addOverdueInvoice("invoice-cap-doneclaimed", "project-cap-doneclaimed", "2026-06-16");
  resendMode = "ok";
  const resendBeforeDoneClaimed = resendCalls;
  await seq.runDueSequences(NOW);
  assert.equal(resendCalls - resendBeforeDoneClaimed, 0, "2 done + 1 claimed (cap=3) reads AT-cap -> blocked ('claimed' must count, rev-1 regression)");

  // ---- M6 (test 17): a burst of eligible retries cannot exceed the cap by riding
  //      outside the count window — the classic rev-1 burst bug this cap exists to
  //      close (cap=50 + 100 stale-failed retries could produce up to 140 dispatches
  //      before rev 2's fix; here cap=5 against 20 eligible failed rows). ----
  resetDailyCapState();
  delete process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED;
  resendMode = "reject";
  const BURST_N = 20;
  for (let i = 0; i < BURST_N; i += 1) {
    const pid = `project-cap-burst-${i}`;
    const cid = `client-cap-burst-${i}`;
    addProject(pid);
    addClient(cid, `capburst${i}@example.com`);
    link(pid, cid);
    addOverdueInvoice(`invoice-cap-burst-${i}`, pid, "2026-06-16");
  }
  await seq.runDueSequences(NOW); // all 20 auto-send attempts reject -> "failed"
  for (let i = 0; i < BURST_N; i += 1) {
    assert.equal(ledger(`project-cap-burst-${i}`).find((r) => r.stepKey === "dunning-day-14")?.status, "failed", `burst fixture ${i} failed on first attempt`);
  }

  process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED = "1";
  process.env.SEQUENCES_DAILY_SEND_CAP = "5";
  resendMode = "ok";
  const NOWBURSTRETRY = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
  const resendBeforeBurst = resendCalls;
  await seq.runDueSequences(NOWBURSTRETRY);
  assert.ok(resendCalls - resendBeforeBurst <= 5, `no more than 5 dispatches across the burst retry run (got ${resendCalls - resendBeforeBurst})`);
  const burstDoneCount = Array.from({ length: BURST_N }).filter(
    (_, i) => ledger(`project-cap-burst-${i}`).find((r) => r.stepKey === "dunning-day-14")?.status === "done",
  ).length;
  assert.ok(burstDoneCount <= 5, `no more than 5 burst rows end up done (got ${burstDoneCount})`);
  assert.ok(burstDoneCount >= 1, "at least one retry should succeed before the cap trips");

  // ---- M7 (test 18): heartbeat recorded on trip vs. no-trip, GATED by the flag
  //      (I4/I6, rev 2 MINOR 8) — with the flag OFF, no row of this JobName is
  //      EVER written, in either direction. ----
  const heartbeatRow = () =>
    database
      .prepare("SELECT last_status AS lastStatus, last_error AS lastError FROM job_runs WHERE job_name = 'sequences-daily-cap-tripped'")
      .get() as { lastStatus: string; lastError: string | null } | undefined;

  database.prepare("DELETE FROM job_runs WHERE job_name = 'sequences-daily-cap-tripped'").run();
  database.prepare("DELETE FROM sequence_sends WHERE mode = 'auto_send'").run();

  // (a) flag OFF: even a run whose seeded volume would trivially trip any real-world cap never
  //     writes ANY heartbeat row for this JobName.
  delete process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED;
  for (let i = 0; i < 60; i += 1) seedAutoSendRow(`heartbeat-off-${i}`, NOW.toISOString());
  await seq.runDueSequences(NOW);
  assert.equal(heartbeatRow(), undefined, "flag OFF: no heartbeat row of this JobName ever exists (I4/I6 byte-for-byte no-op)");

  // (b) flag ON + cap tripped -> ok:false, detail names the count/cap.
  process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED = "1";
  process.env.SEQUENCES_DAILY_SEND_CAP = "5";
  addProject("project-heartbeat-trip");
  addClient("client-heartbeat-trip", "heartbeattrip@example.com");
  link("project-heartbeat-trip", "client-heartbeat-trip");
  addOverdueInvoice("invoice-heartbeat-trip", "project-heartbeat-trip", "2026-06-16");
  await seq.runDueSequences(NOW);
  const trippedRow = heartbeatRow();
  assert.ok(trippedRow, "flag ON + tripped cap -> a heartbeat row IS recorded");
  assert.equal(trippedRow!.lastStatus, "error", "tripped cap heartbeat recorded as a failure (ok:false)");
  assert.match(trippedRow!.lastError ?? "", /reached the SEQUENCES_DAILY_SEND_CAP of 5/, "heartbeat detail names the count/cap");

  // (c) flag ON + NOT tripped -> ok:true (self-resets to healthy the next clean day).
  database.prepare("DELETE FROM sequence_sends WHERE mode = 'auto_send'").run();
  process.env.SEQUENCES_DAILY_SEND_CAP = "50";
  addProject("project-heartbeat-clean");
  addClient("client-heartbeat-clean", "heartbeatclean@example.com");
  link("project-heartbeat-clean", "client-heartbeat-clean");
  addOverdueInvoice("invoice-heartbeat-clean", "project-heartbeat-clean", "2026-06-16");
  await seq.runDueSequences(NOW);
  const cleanRow = heartbeatRow();
  assert.ok(cleanRow, "a heartbeat row exists after a clean (non-tripped) run");
  assert.equal(cleanRow!.lastStatus, "ok", "no trip -> heartbeat self-resets to ok");

  delete process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED;
  delete process.env.SEQUENCES_DAILY_SEND_CAP;

  // =========================================================================
  // I. NO AGENT PATH — the MCP surface never imports the runner or the sender.
  // =========================================================================
  const mcpSource = fs.readFileSync(path.join(process.cwd(), "src", "lib", "studio-mcp.ts"), "utf8");
  assert.equal(/runDueSequences|sendSequenceEmail|from ["']\.\/sequences["']/.test(mcpSource), false, "studio-mcp does NOT import runDueSequences/sendSequenceEmail/sequences");
  const { handleStudioMcpMessage } = await import("./studio-mcp");
  const toolList = await handleStudioMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const toolNames = JSON.stringify(toolList).toLowerCase();
  assert.equal(/sequence/.test(toolNames), false, "no MCP tool exposes a sequence enroll/draft/send surface");

  // =========================================================================
  // J. ADMIN SEND GUARD — the admin send of a sequence draft REFUSES a
  //    suppressed recipient (defence-in-depth), no Resend call.
  // =========================================================================
  database.prepare(
    "INSERT INTO project_communications (id, project_id, direction, channel, status, subject, body, recipient_email, source_type, source_id, created_by, created_at, updated_at) VALUES ('seq-draft-suppressed', 'project-dun', 'outbound', 'email', 'draft', 'Reminder', 'body', 'suppressed-admin@example.com', 'sequence_step', 'dunning:dunning-day-7', 'system', ?, ?)",
  ).run(iso, iso);
  database.prepare("INSERT INTO email_suppressions (email, suppressed_at, source) VALUES ('suppressed-admin@example.com', ?, 'unsubscribe_link')").run(iso);
  const resendBeforeAdmin = resendCalls;
  const refused = await seq.sendSequenceEmailDraft({ projectId: "project-dun", communicationId: "seq-draft-suppressed" });
  assert.equal(refused.ok, false, "admin send of a suppressed-recipient sequence draft REFUSES");
  if (!refused.ok) assert.equal(refused.reason, "suppressed");
  assert.equal(resendCalls - resendBeforeAdmin, 0, "refused admin send makes ZERO Resend calls");
  assert.equal(
    (database.prepare("SELECT status FROM project_communications WHERE id = 'seq-draft-suppressed'").get() as { status: string }).status,
    "draft",
    "refused draft is NOT marked sent",
  );

  // No SMS transport ever touched across the whole suite.
  assert.equal(twilioCalls, 0, "sequences never call Twilio (no SMS auto-send path)");

  globalThis.fetch = realFetch;
  console.log("sequences tests passed");
}

main().catch((error) => {
  globalThis.fetch = realFetch;
  console.error(error);
  process.exit(1);
});
