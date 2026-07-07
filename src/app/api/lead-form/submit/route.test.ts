// Phase 19 — submit route POST outcomes (§9 tests 3/4/5/6/9/12). Every user-visible outcome is a
// 303 (BLOCKER-2); the ONLY non-redirect is the 403 bad-token. DB temp-db pattern.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-lead-submit-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.SCHEDULER_LINK_SECRET = "test-lead-submit-secret";
process.env.LEAD_FORM_ENABLED = "true";
delete process.env.ORIGIN_PROXY_SECRET; // guardDirectWorkerApiRequest inactive on the schedule host anyway

const ENDPOINT = "https://schedule.bythereeses.com/api/lead-form/submit";

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const { createLeadFormEmbedToken, mintFormNonce, MIN_FILL_MS, MAX_AGE_MS } = await import("@/lib/lead-form-links");
  const database = rawDb();

  const inquiryCount = () => database.prepare("SELECT COUNT(*) AS c FROM inbound_inquiries").get().c;

  const validToken = createLeadFormEmbedToken(0); // default config rev = 0

  function freshNonce() {
    // age ~5s: > MIN_FILL_MS, < MAX_AGE_MS → "ok".
    return mintFormNonce(Date.now() - (MIN_FILL_MS + 2_000)).token;
  }

  function form(fields: Record<string, string>) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return new Request(ENDPOINT, { method: "POST", body: fd });
  }

  function baseFields(overrides: Record<string, string> = {}) {
    return {
      t: validToken,
      formNonce: freshNonce(),
      name: "Jane Doe",
      email: "jane@example.com",
      message: "We would love to book you.",
      ...overrides,
    };
  }

  // ================= Test 9: flag off = 404 =================
  process.env.LEAD_FORM_ENABLED = "";
  assert.equal((await POST(form(baseFields()) as never)).status, 404, "flag off → 404");
  process.env.LEAD_FORM_ENABLED = "true";

  // ================= Test 5: embed token gate =================
  const noToken = await POST(form({ ...baseFields(), t: "" }) as never);
  assert.equal(noToken.status, 403, "missing token → 403 (the ONLY non-redirect)");
  const badToken = await POST(form({ ...baseFields(), t: "garbage" }) as never);
  assert.equal(badToken.status, 403, "tampered token → 403");
  // Token whose rev != config.rev (revoked) → 403.
  const revokedToken = createLeadFormEmbedToken(9);
  const revoked = await POST(form({ ...baseFields(), t: revokedToken }) as never);
  assert.equal(revoked.status, 403, "rev-mismatch (revoked) token → 403");
  assert.equal(inquiryCount(), 0, "no row written on any bad-token path");

  // ================= Test 3: honeypot drop =================
  const honeypot = await POST(form(baseFields({ company_website: "http://spam.example" })) as never);
  assert.equal(honeypot.status, 303, "honeypot → 303 (not a 200 body)");
  assert.match(honeypot.headers.get("location") ?? "", /\/embed\/lead\/thanks/, "honeypot → thanks (indistinguishable from success)");
  assert.equal(inquiryCount(), 0, "honeypot writes ZERO rows");

  // ================= Test 4: timing nonce =================
  // too fast → bot signal → 303 thanks, no row.
  const tooFast = await POST(form({ ...baseFields(), formNonce: mintFormNonce(Date.now()).token }) as never);
  assert.equal(tooFast.status, 303, "sub-MIN_FILL_MS → 303");
  assert.match(tooFast.headers.get("location") ?? "", /\/embed\/lead\/thanks/, "too_fast → thanks");
  assert.equal(inquiryCount(), 0, "too_fast writes no row");

  // stale → NOT dropped → 303 back to the form (never a silent loss).
  const stale = await POST(form({ ...baseFields(), formNonce: mintFormNonce(Date.now() - (MAX_AGE_MS + 10_000)).token }) as never);
  assert.equal(stale.status, 303, "stale → 303");
  const staleLoc = stale.headers.get("location") ?? "";
  assert.match(staleLoc, /\/embed\/lead\?/, "stale → back to the form");
  assert.match(staleLoc, /error=expired/, "stale carries error=expired");
  assert.doesNotMatch(staleLoc, /jane|example\.com|book you/i, "redirect carries NO submitted PII");
  assert.equal(inquiryCount(), 0, "stale writes no row");

  // within window → row created + 303 thanks.
  const okSubmit = await POST(form(baseFields()) as never);
  assert.equal(okSubmit.status, 303, "valid → 303");
  assert.match(okSubmit.headers.get("location") ?? "", /\/embed\/lead\/thanks/, "valid → thanks");
  assert.equal(inquiryCount(), 1, "valid submit creates exactly one row");

  // ================= Test 6: validation re-render (not a silent drop / null-email row) =====
  const noName = await POST(form({ t: validToken, formNonce: freshNonce(), name: "", email: "x@y.com", message: "hi there" }) as never);
  assert.equal(noName.status, 303, "missing name → 303");
  assert.match(noName.headers.get("location") ?? "", /error=name/, "missing name → error=name re-render");

  const badEmail = await POST(form(baseFields({ email: "not-an-email" })) as never);
  assert.equal(badEmail.status, 303, "invalid email → 303");
  assert.match(badEmail.headers.get("location") ?? "", /error=email/, "invalid email → error=email (never a null-email row)");
  assert.equal(inquiryCount(), 1, "no new row from validation failures");

  // ================= Test 12: disabled field ignored, missing required identity → re-render ==
  // referralSource is default-disabled: posting it must be IGNORED (row still created).
  const withDisabled = await POST(form(baseFields({ referralSource: "should be ignored" })) as never);
  assert.equal(withDisabled.status, 303, "disabled-field value does not error");
  assert.match(withDisabled.headers.get("location") ?? "", /\/embed\/lead\/thanks/, "→ thanks");
  const latest = database.prepare("SELECT body_text FROM inbound_inquiries ORDER BY created_at DESC LIMIT 1").get();
  assert.doesNotMatch(latest.body_text ?? "", /should be ignored/, "disabled field value NOT stored");

  const missingMessage = await POST(form({ t: validToken, formNonce: freshNonce(), name: "A", email: "a@b.com", message: "" }) as never);
  assert.equal(missingMessage.status, 303, "missing required message → 303 (never a 400/blank frame)");
  assert.match(missingMessage.headers.get("location") ?? "", /error=message/, "→ error=message re-render");

  console.log("lead-form submit route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
