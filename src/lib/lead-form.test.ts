// Phase 19 — ingestWebFormInquiry (I2/I3 core) + config normalization + token/nonce tests.
// DB tests set DATABASE_PATH to a temp db and import the real functions (pattern:
// src/app/api/inbound/inquiry-email/route.test.ts).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-lead-form-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.SCHEDULER_LINK_SECRET = "test-lead-form-secret";

async function main() {
  const { rawDb } = await import("@/db/client");
  const {
    ingestWebFormInquiry,
    approveInquiryProjectCreation,
    isLeadFormEnabled,
    GLOBAL_HOURLY_INSERT_CAP,
    DOMAIN_HOURLY_INSERT_CAP,
    MAX_PARSED_NAME_LENGTH,
  } = await import("@/lib/inbound-inquiry");
  const {
    normalizeLeadFormConfig,
    defaultLeadFormConfig,
    getLeadFormConfig,
    updateLeadFormConfigFromForm,
  } = await import("@/lib/lead-form");
  const database = rawDb();

  function counts() {
    return {
      inquiries: database.prepare("SELECT COUNT(*) AS c FROM inbound_inquiries").get().c,
      tasks: database.prepare("SELECT COUNT(*) AS c FROM agent_tasks").get().c,
      projects: database.prepare("SELECT COUNT(*) AS c FROM projects").get().c,
      clients: database.prepare("SELECT COUNT(*) AS c FROM clients").get().c,
      sources: database.prepare("SELECT COUNT(*) AS c FROM project_sources").get().c,
      comms: database.prepare("SELECT COUNT(*) AS c FROM project_communications").get().c,
    };
  }

  function primeInquiryRow(email: string, receivedAtMs: number) {
    const now = new Date(receivedAtMs).toISOString();
    database
      .prepare(
        "INSERT INTO inbound_inquiries (id, status, envelope_from, header_from, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(crypto.randomUUID(), "new", email, email, now, now, now);
  }

  // ================= Flag helper (I1) =================
  delete process.env.LEAD_FORM_ENABLED;
  assert.equal(isLeadFormEnabled(), false, "flag unset → disabled");
  process.env.LEAD_FORM_ENABLED = "1";
  assert.equal(isLeadFormEnabled(), false, "flag '1' → disabled (intake-family reads 'true', not '1')");
  process.env.LEAD_FORM_ENABLED = "true";
  assert.equal(isLeadFormEnabled(), true, "flag 'true' → enabled");

  // ================= Test 1: no-canonical-write guard (I2 headline pin) =================
  const before = counts();
  const result = await ingestWebFormInquiry({
    name: "Jane Doe",
    email: "jane@example.com",
    phone: "555-1234",
    eventDate: "2027-06-12",
    eventType: "Wedding",
    message: "We'd love to book you for our wedding!",
    referralSource: "Instagram",
    nonceId: crypto.randomUUID(),
  });
  assert.equal(result.status, "proposed", "valid web-form lead → proposed");
  const after = counts();
  assert.equal(after.inquiries, before.inquiries + 1, "exactly one inbound_inquiries row");
  assert.equal(after.tasks, before.tasks + 1, "exactly one agent_tasks review row");
  assert.equal(after.projects, before.projects, "NO canonical project written");
  assert.equal(after.clients, before.clients, "NO canonical client written");
  assert.equal(after.sources, before.sources, "NO project_sources written");
  assert.equal(after.comms, before.comms, "NO project_communications written");
  const row = database.prepare("SELECT * FROM inbound_inquiries WHERE id = ?").get(result.id);
  assert.equal(row.status, "proposed");
  assert.equal(JSON.parse(row.parsed_json).source, "web_form", "parsed_json.source === web_form (D4)");
  assert.equal(row.message_id, `webform:` + row.message_id.split(":")[1], "message_id is webform:<nonceId>");
  assert.ok(row.body_text.includes("Instagram"), "structured fields folded into body_text");

  // ================= Test 2: approval is the sole canonical path (I3) =================
  const approval = await approveInquiryProjectCreation(result.id, { actorName: "Tyler" });
  assert.ok(approval.projectId, "approveInquiryProjectCreation created a canonical project");
  assert.equal(counts().projects, before.projects + 1, "one canonical project after admin approval");
  const activity = database
    .prepare("SELECT actor_type FROM activity_logs WHERE action = 'inquiry.project_created_from_intake' ORDER BY created_at DESC")
    .get();
  assert.equal(activity.actor_type, "admin", "approval activity actorType is admin");

  // ================= Test 6: length caps (I5) =================
  const longPhone = "9".repeat(400);
  const longMessage = "m".repeat(60_000);
  const capped = await ingestWebFormInquiry({
    name: "Cap Test",
    email: "cap@example.com",
    phone: longPhone,
    message: longMessage,
    nonceId: crypto.randomUUID(),
  });
  const cappedRow = database.prepare("SELECT * FROM inbound_inquiries WHERE id = ?").get(capped.id);
  assert.ok(cappedRow.body_text.length <= 50_000, "message capped to MAX_BODY_TEXT_LENGTH");
  // normalizeEmail rejects over-cap emails (returns null) rather than truncating — the ROUTE 303s
  // that back to the form. ingestWebFormInquiry is only ever reached with a normalized email.
  assert.equal(MAX_PARSED_NAME_LENGTH, 200);

  // ================= Test 7: idempotent double-submit (B2 reuse) =================
  const sharedNonce = crypto.randomUUID();
  const first = await ingestWebFormInquiry({ name: "Dup", email: "dup@example.com", message: "hello there", nonceId: sharedNonce });
  const inquiriesAfterFirst = counts().inquiries;
  const tasksAfterFirst = counts().tasks;
  const second = await ingestWebFormInquiry({ name: "Dup", email: "dup@example.com", message: "hello there", nonceId: sharedNonce });
  assert.equal(second.deduped, true, "same nonce → deduped");
  assert.equal(second.id, first.id, "same nonce → same row id");
  assert.equal(counts().inquiries, inquiriesAfterFirst, "no second inbound row");
  assert.equal(counts().tasks, tasksAfterFirst, "no second agent task");

  // ================= Test 8: CRM flood guard reuse + domain cap =================
  const floodDomain = "flooders.test";
  const nowMs = Date.now();
  for (let i = 0; i < DOMAIN_HOURLY_INSERT_CAP; i += 1) {
    primeInquiryRow(`bot${i}@${floodDomain}`, nowMs - 60_000);
  }
  const floodTasksBefore = counts().tasks;
  const flooded = await ingestWebFormInquiry({ name: "Bot", email: `late@${floodDomain}`, message: "spam spam", nonceId: crypto.randomUUID() });
  assert.equal(flooded.status, "spam", "over domain cap → status spam");
  assert.equal(counts().tasks, floodTasksBefore, "spam row raises NO agent task");
  const globalFloodBefore = database.prepare("SELECT COUNT(*) AS c FROM job_runs WHERE job_name = 'lead-form-global-flood'").get().c;
  assert.equal(globalFloodBefore, 0, "domain-cap trip does NOT emit the GLOBAL-cap counter");

  // Global cap → visibility counter (MEDIUM-5).
  for (let i = 0; i < GLOBAL_HOURLY_INSERT_CAP; i += 1) {
    primeInquiryRow(`g${i}@spread-${i % 40}.test`, nowMs - 30_000);
  }
  const globallyFlooded = await ingestWebFormInquiry({ name: "GBot", email: "g@another.test", message: "flooding now", nonceId: crypto.randomUUID() });
  assert.equal(globallyFlooded.status, "spam", "over global cap → status spam");
  const globalFloodAfter = database.prepare("SELECT * FROM job_runs WHERE job_name = 'lead-form-global-flood'").get();
  assert.ok(globalFloodAfter, "GLOBAL cap trip emits a health-alert/count row (MEDIUM-5)");
  assert.ok(globalFloodAfter.consecutive_failures >= 1, "the counter increments");

  // ================= Config normalization (§5, MEDIUM-3) =================
  // name/email/message forced on+required regardless of stored input.
  const forced = normalizeLeadFormConfig({
    version: 1,
    rev: 3,
    introText: "hi",
    submitButtonText: "Go",
    confirmationMessage: "thanks",
    fields: {
      name: { enabled: false, required: false },
      email: { enabled: false, required: false },
      message: { enabled: false, required: false },
      phone: { enabled: true, required: true },
      eventDate: { enabled: false, required: true },
      eventType: { enabled: true, required: false },
      referralSource: { enabled: true, required: true },
    },
  } as never);
  assert.deepEqual(forced.fields.name, { enabled: true, required: true }, "name forced on+required");
  assert.deepEqual(forced.fields.email, { enabled: true, required: true }, "email forced on+required");
  assert.deepEqual(forced.fields.message, { enabled: true, required: true }, "message forced on+required");
  assert.deepEqual(forced.fields.eventDate, { enabled: false, required: false }, "disabled field cannot be required");
  assert.equal(forced.rev, 3, "rev preserved");

  // NULL config → code defaults.
  const defaults = normalizeLeadFormConfig(null);
  assert.deepEqual(defaults.fields.referralSource, defaultLeadFormConfig.fields.referralSource, "NULL → code defaults");
  assert.equal(defaults.rev, 0, "default rev 0");

  // Stored-XSS: sanitize on store keeps the config bounded (render escapes separately, see
  // lead-form-render.test.tsx). sanitizeBody caps + strips control chars.
  const xss = normalizeLeadFormConfig({ introText: "<script>alert(1)</script>", submitButtonText: "x".repeat(500) } as never);
  assert.ok(xss.submitButtonText.length <= 60, "submitButtonText capped to 60");
  assert.ok(typeof xss.introText === "string", "introText stored as text (escaped at render)");

  // ================= updateLeadFormConfigFromForm: rev bump + business preserved (MINOR-9) =====
  // Seed business settings via the shared action first.
  const { updateAppSettingsFromForm } = await import("@/lib/settings");
  const bizForm = new FormData();
  bizForm.set("businessName", "Reese Test Studio");
  bizForm.set("publicBrandName", "Reese Test");
  bizForm.set("contactEmail", "hello@reese.test");
  bizForm.set("timezone", "America/New_York");
  bizForm.set("zelleEnabled", "on");
  await updateAppSettingsFromForm(bizForm);

  const leadForm = new FormData();
  leadForm.set("introText", "Custom intro");
  leadForm.set("submitButtonText", "Inquire");
  leadForm.set("confirmationMessage", "Got it!");
  leadForm.set("phoneEnabled", "on");
  leadForm.set("bumpRev", "on");
  const updated = await updateLeadFormConfigFromForm(leadForm);
  assert.equal(updated.config.introText, "Custom intro");
  assert.equal(updated.config.rev, 1, "bumpRev incremented rev 0 → 1");
  const reread = await getLeadFormConfig();
  assert.equal(reread.rev, 1, "rev persisted");
  assert.equal(reread.introText, "Custom intro", "config persisted");
  const bizRow = database.prepare("SELECT business_name FROM app_settings WHERE id = 'business'").get();
  assert.equal(bizRow.business_name, "Reese Test Studio", "MINOR-9: business settings NOT reset by the lead-form action");

  // A save without bumpRev keeps the rev.
  const noBump = new FormData();
  noBump.set("introText", "Edited again");
  const updated2 = await updateLeadFormConfigFromForm(noBump);
  assert.equal(updated2.config.rev, 1, "no bump → rev unchanged");

  console.log("lead-form ingest/config tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
