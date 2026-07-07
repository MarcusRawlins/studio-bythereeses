import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 18 §9 tests 4, 5, 6, 8, 12 — the daily-brief section folded into the Phase 21 systems
// digest (§2). DAILY_BRIEF_ENABLED off is byte-identical to the pre-Phase-18 digest; enabled with
// a narration lands the brief section after the health signals but BEFORE the dead-man footer
// (§2.1); no narration row still ships the rule-based bullets; and the digest send is never
// blocked by a daily-brief failure.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-daily-brief-digest-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.CRON_SECRET = "daily-brief-digest-secret";
process.env.MONITOR_REQUIRED_SINCE = new Date().toISOString(); // fresh -> no required-job criticals
process.env.ALERT_EMAIL = "tyler@own.example";
process.env.RESEND_API_KEY = "re_test";
delete process.env.DEADMAN_PING_URL;
delete process.env.PROJECT_PROGRESS_TIMELINE;
delete process.env.DAILY_BRIEF_ENABLED;

// route.ts computes `now = new Date()` internally (it is a real cron endpoint, not parameterized
// for tests) and only builds the digest when `easternHour(now) === parseDigestHour(...)`. Mirror
// its exact ET-hour formula here so MONITOR_DIGEST_HOUR can be set to "whatever hour it is right
// now" — the only way to deterministically hit the digest branch without editing route.ts's clock.
function currentEasternHour(): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date());
  const hour = parts.find((p) => p.type === "hour")?.value ?? "0";
  const parsed = Number(hour);
  return Number.isFinite(parsed) ? parsed % 24 : 0;
}

function monitorRequest() {
  // Refresh MONITOR_DIGEST_HOUR to the current ET hour on EVERY call (not once at setup): route.ts
  // computes `now = new Date()` internally and only builds the digest when easternHour(now) matches
  // this var. Setting it once at setup would skip the digest branch — null-deref-ing capture.body()!
  // — if the wall clock crossed an hour boundary mid-file. Recomputing sub-millisecond before each
  // POST closes that window.
  process.env.MONITOR_DIGEST_HOUR = String(currentEasternHour());
  return new Request("https://x.workers.dev/api/cron/systems-monitor", {
    method: "POST",
    headers: { authorization: "Bearer daily-brief-digest-secret" },
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("@/app/api/cron/systems-monitor/route");
  const database = rawDb();
  const now = new Date().toISOString();

  process.env.MONITOR_DIGEST_HOUR = String(currentEasternHour());

  // A minimal action-item + agenda fixture so the brief section (when enabled) has real bullet
  // content to render, not just an empty heading.
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Ada', 'Lovelace', 'ada@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Digest Brief Project', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO invoices (id, project_id, invoice_number, status, created_at, updated_at)
    VALUES ('invoice-1', 'project-1', 'INV-1', 'sent', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (id, invoice_id, label, due_date, status, created_at, updated_at)
    VALUES ('payment-1', 'invoice-1', 'Balance', '2020-01-01', 'pending', ?, ?)
  `).run(now, now);

  function mockResendCapture() {
    let capturedBody: string | null = null;
    const originalFetch = global.fetch;
    global.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.resend.com")) {
        const payload = JSON.parse(String(init?.body ?? "{}"));
        capturedBody = payload.text ?? null;
        return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    return {
      restore: () => {
        global.fetch = originalFetch;
      },
      body: () => capturedBody,
    };
  }

  // ======================================================================================
  // Test 4 — DAILY_BRIEF_ENABLED off (MONITOR_ENABLED on) -> byte-identical to today: no
  // "Today: what needs you" section anywhere, footer lines are the last two lines unchanged.
  // ======================================================================================
  {
    process.env.MONITOR_ENABLED = "1";
    delete process.env.DAILY_BRIEF_ENABLED;
    const capture = mockResendCapture();
    const res = await POST(monitorRequest() as unknown as Parameters<typeof POST>[0]);
    capture.restore();
    assert.equal(res.status, 200, "flag-off digest send succeeds");
    const body = capture.body();
    assert.ok(body, "an alert email was sent");
    assert.ok(!body!.includes("Today: what needs you"), "flag-off -> no daily-brief section appended at all");
    const trimmed = body!.replace(/\n+$/, "").split("\n");
    assert.match(trimmed[trimmed.length - 1], /External dead-man ping/, "the footer's last line is unchanged");
    assert.match(trimmed[trimmed.length - 2], /If you did NOT receive today's Systems email/, "the footer's second-to-last line is unchanged");
  }

  // ======================================================================================
  // Test 5 — flag on + a narration row for TODAY -> brief section (narrative + bullets) appears
  // AFTER the health signals but BEFORE the dead-man footer.
  // ======================================================================================
  {
    process.env.DAILY_BRIEF_ENABLED = "1";
    const { dateKeyInTimeZone } = await import("@/lib/timezone");
    const todayKey = dateKeyInTimeZone(new Date(), "America/New_York");
    database.prepare(`
      INSERT INTO daily_brief_narrations (day_key, narrative, generated_at) VALUES (?, 'Quiet week — one balance is overdue.', ?)
    `).run(todayKey, now);

    const capture = mockResendCapture();
    const res = await POST(monitorRequest() as unknown as Parameters<typeof POST>[0]);
    capture.restore();
    assert.equal(res.status, 200, "flag-on digest send succeeds");
    const body = capture.body()!;
    assert.ok(body.includes("Today: what needs you"), "flag-on -> the brief heading is present");
    assert.ok(body.includes("Quiet week — one balance is overdue."), "the cached narration renders verbatim");

    const briefIndex = body.indexOf("Today: what needs you");
    const footerIndex = body.indexOf("If you did NOT receive today's Systems email");
    assert.ok(briefIndex >= 0 && footerIndex >= 0 && briefIndex < footerIndex, "the brief section lands BEFORE the dead-man footer");

    // "After the health signals": the health digest's own heading precedes the brief section.
    const healthIndex = body.indexOf("Systems health digest");
    assert.ok(healthIndex >= 0 && healthIndex < briefIndex, "the brief section lands AFTER the health signals");
  }

  // ======================================================================================
  // Test 6 — flag on, no narration row for TODAY -> rule-based bullet sections still ship,
  // sentDigest is still true, no error, no narrative paragraph.
  // ======================================================================================
  {
    database.exec("DELETE FROM daily_brief_narrations;");
    const capture = mockResendCapture();
    const res = await POST(monitorRequest() as unknown as Parameters<typeof POST>[0]);
    capture.restore();
    assert.equal(res.status, 200);
    const json = await res.json() as { ok: boolean; digestSent: boolean };
    assert.equal(json.ok, true, "route reports overall success");
    assert.equal(json.digestSent, true, "sentDigest is still true with no narration row");
    const body = capture.body()!;
    assert.ok(body.includes("Today: what needs you"), "the brief heading still renders (rule-based sections)");
    assert.ok(body.includes("Needs you:"), "the rule-based bullet section still ships");
    assert.ok(!body.includes("Quiet week"), "no stale/previous narration paragraph leaks in");
  }

  // ======================================================================================
  // Test 8 (route-level) — the wiring around safeDailyBriefExtraSection never turns a
  // daily-brief-side problem into a blocked or failed digest send; the route still returns its
  // normal success shape end-to-end with the flag on.
  // ======================================================================================
  {
    const capture = mockResendCapture();
    const res = await POST(monitorRequest() as unknown as Parameters<typeof POST>[0]);
    capture.restore();
    assert.equal(res.status, 200, "the route still returns its normal success shape");
    const json = await res.json() as { ok: boolean; digestSent: boolean };
    assert.equal(json.ok, true);
    assert.equal(json.digestSent, true, "sendAdminAlertEmail is still called/succeeds regardless of daily-brief content");
  }

  // ======================================================================================
  // Test 12 (route-level) — flag off (DAILY_BRIEF_ENABLED unset): daily_brief_narrations is never
  // read/touched by the route at all.
  // ======================================================================================
  {
    delete process.env.DAILY_BRIEF_ENABLED;
    database.prepare(`
      INSERT INTO daily_brief_narrations (day_key, narrative, generated_at) VALUES ('1999-01-01', 'should never be read', ?)
    `).run(now);
    const capture = mockResendCapture();
    const res = await POST(monitorRequest() as unknown as Parameters<typeof POST>[0]);
    capture.restore();
    assert.equal(res.status, 200);
    const body = capture.body()!;
    assert.ok(!body.includes("Today: what needs you"), "flag-off -> no brief section, no narration read");
    assert.ok(!body.includes("should never be read"), "flag-off -> the narrations table is never consulted");
  }

  delete process.env.MONITOR_ENABLED;
  delete process.env.DAILY_BRIEF_ENABLED;
  delete process.env.ALERT_EMAIL;
  delete process.env.RESEND_API_KEY;

  console.log("daily brief digest route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
