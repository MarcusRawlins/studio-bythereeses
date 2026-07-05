import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-sms-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

// Ensure a clean transport env at import time.
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.TWILIO_PUBLIC_WEBHOOK_URL_STATUS;
delete process.env.SMS_ENABLED;

const realFetch = globalThis.fetch;

async function main() {
  const { rawDb } = await import("@/db/client");
  const {
    toE164,
    appendOptOutLanguage,
    SMS_OPT_OUT_LANGUAGE,
    sendTwilioMessage,
    sendProjectSms,
    SmsConfigError,
    maskNumber,
  } = await import("./sms");
  const database = rawDb();
  const now = "2026-06-01T12:00:00.000Z";

  // --- toE164 normalization ---
  assert.equal(toE164("(555) 012-3456"), "+15550123456", "US 10-digit → +1");
  assert.equal(toE164("555.012.3456"), "+15550123456", "dots stripped");
  assert.equal(toE164("15550123456"), "+15550123456", "11-digit leading 1 → +");
  assert.equal(toE164("+1 555 012 3456"), "+15550123456", "already + normalized");
  assert.equal(toE164("+447911123456"), "+447911123456", "intl + kept");
  assert.equal(toE164("not a phone"), null, "garbage → null");
  assert.equal(toE164("12345"), null, "too short → null");
  assert.equal(toE164("+0123456789"), null, "leading +0 invalid → null");
  assert.equal(toE164(""), null, "empty → null");
  assert.equal(toE164(null), null, "null → null");
  assert.equal(maskNumber("+15550123456"), "+1555…3456", "number masked in logs");

  // --- opt-out language appended idempotently ---
  assert.equal(appendOptOutLanguage("Hello there").endsWith(SMS_OPT_OUT_LANGUAGE), true, "opt-out appended");
  assert.equal(appendOptOutLanguage("Text STOP anytime"), "Text STOP anytime", "existing uppercase STOP token → not double-tagged");
  // TCPA gap fix: an incidental LOWERCASE "stop" must NOT suppress the append.
  assert.equal(
    appendOptOutLanguage("happy to stop by").endsWith(SMS_OPT_OUT_LANGUAGE),
    true,
    "incidental lowercase 'stop' does NOT count as opt-out language — append still happens",
  );
  assert.equal(
    appendOptOutLanguage(`Your gallery is ready. ${SMS_OPT_OUT_LANGUAGE}`).match(/Reply STOP/g)?.length,
    1,
    "already-present opt-out language is not duplicated",
  );

  // --- sendTwilioMessage fail-closed matrix ---
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  let threw = false;
  try {
    await sendTwilioMessage({ to: "+15550123456", body: "Hi" });
  } catch (error) {
    threw = error instanceof SmsConfigError;
  }
  assert.equal(threw, true, "prod + unset TWILIO_* throws SmsConfigError (fail closed)");
  process.env.NODE_ENV = originalNodeEnv;

  // Outside prod, unset secrets → simulated, no network.
  let networkCalled = false;
  globalThis.fetch = (async () => {
    networkCalled = true;
    throw new Error("network should not be called in dev-simulate");
  }) as typeof fetch;
  const simulated = await sendTwilioMessage({ to: "+15550123456", body: "Hi" });
  assert.deepEqual(simulated, { simulated: true }, "dev + unset → simulated");
  assert.equal(networkCalled, false, "no network on dev-simulate");

  // --- Basic-auth header + form body shape (fetch spy) ---
  process.env.TWILIO_ACCOUNT_SID = "AC_sid_test";
  process.env.TWILIO_AUTH_TOKEN = "tok_test";
  process.env.TWILIO_FROM_NUMBER = "+15550000000";
  process.env.TWILIO_PUBLIC_WEBHOOK_URL_STATUS = "https://studio.bythereeses.com/api/twilio/status";
  let captured: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url: String(url), init };
    return { ok: true, json: async () => ({ sid: "SM00000000000000000000000000000001", status: "queued" }) } as Response;
  }) as unknown as typeof fetch;
  const sent = await sendTwilioMessage({ to: "+15550123456", body: "Hi there" });
  assert.deepEqual(sent, { sid: "SM00000000000000000000000000000001", status: "queued" });
  assert.ok(captured, "fetch called");
  const cap = captured as { url: string; init: RequestInit };
  assert.match(cap.url, /api\.twilio\.com\/2010-04-01\/Accounts\/AC_sid_test\/Messages\.json/);
  const headers = cap.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${btoa("AC_sid_test:tok_test")}`, "Basic btoa(SID:TOKEN)");
  assert.equal(headers["Content-Type"], "application/x-www-form-urlencoded");
  const bodyParams = new URLSearchParams(String(cap.init.body));
  assert.equal(bodyParams.get("To"), "+15550123456");
  assert.equal(bodyParams.get("From"), "+15550000000");
  assert.equal(bodyParams.get("Body"), "Hi there");
  assert.equal(
    bodyParams.get("StatusCallback"),
    "https://studio.bythereeses.com/api/twilio/status",
    "StatusCallback === TWILIO_PUBLIC_WEBHOOK_URL_STATUS",
  );

  // --- Happy-path sendProjectSms: consented client, flag on, mocked transport ---
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, sms_opt_in, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', '(555) 012-3456', 1, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_communications (id, project_id, client_id, direction, channel, status, body, created_by, created_at, updated_at)
    VALUES ('comm-1', 'project-1', 'client-1', 'outbound', 'sms', 'draft', 'Hi Alex, your gallery is ready.', 'admin', ?, ?)
  `).run(now, now);

  process.env.SMS_ENABLED = "1";
  const result = await sendProjectSms({
    projectId: "project-1",
    clientId: "client-1",
    body: "Hi Alex, your gallery is ready.",
    communicationId: "comm-1",
    actorName: "Tyler",
  });
  assert.equal(result.ok, true, "consented + flag on + configured → ok");
  if (result.ok) {
    assert.equal(result.to, "+15550123456");
    assert.equal(result.sid, "SM00000000000000000000000000000001");
  }
  const row = database.prepare(`
    SELECT status, provider_message_id, delivery_status, body FROM project_communications WHERE id = 'comm-1'
  `).get() as { status: string; provider_message_id: string; delivery_status: string; body: string };
  assert.equal(row.status, "sent", "draft patched to sent");
  assert.equal(row.provider_message_id, "SM00000000000000000000000000000001");
  assert.equal(row.delivery_status, "queued");
  assert.match(row.body, /Reply STOP to opt out\./, "opt-out language appended helper-side");
  const activity = database.prepare(`
    SELECT action, metadata FROM activity_logs WHERE action = 'project.communication.sms_sent'
  `).get() as { action: string; metadata: string };
  assert.ok(activity, "sms_sent activity logged");
  const meta = JSON.parse(activity.metadata);
  assert.equal(meta.to, "+1555…3456", "destination masked in activity metadata");
  assert.equal(String(activity.metadata).includes("tok_test"), false, "auth token never logged");

  globalThis.fetch = realFetch;
  console.log("sms tests passed");
}

main().catch((error) => {
  globalThis.fetch = realFetch;
  console.error(error);
  process.exit(1);
});
