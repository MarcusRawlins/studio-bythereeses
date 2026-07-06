import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-send-sms-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

// Route tests run with the transport DARK/unconfigured except where a test
// explicitly flips SMS_ENABLED — any Twilio network call is an integrity
// failure for this suite (Active-Learning Log: no real network in tests).
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const realFetch = globalThis.fetch;
let twilioCalls = 0;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (String(url).includes("api.twilio.com")) twilioCalls += 1;
  return realFetch(url as string, init);
}) as unknown as typeof fetch;

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const { handleStudioMcpMessage } = await import("@/lib/studio-mcp");
  const database = rawDb();
  const now = "2026-06-15T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, sms_opt_in, created_at, updated_at)
    VALUES ('client-consented', 'Alex', 'Taylor', 'alex@example.com', '+15550001111', 1, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, sms_opt_in, created_at, updated_at)
    VALUES ('client-noconsent', 'Nora', 'Nolan', 'nora@example.com', '+15550002222', 0, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, sms_opt_in, created_at, updated_at)
    VALUES ('client-suppressed', 'Sam', 'Stone', 'sam@example.com', '+15550003333', 1, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-consented', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-2', 'project-1', 'client-noconsent', 'secondary', 0, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-3', 'project-1', 'client-suppressed', 'secondary', 0, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO sms_suppressions (phone_e164, stopped_at, note)
    VALUES ('+15550003333', ?, 'prior STOP')
  `).run(now);

  function insertDraft(id: string, clientId: string, body: string) {
    database.prepare(`
      INSERT INTO project_communications (
        id, project_id, client_id, direction, channel, status, body, created_by, created_at, updated_at
      ) VALUES (?, 'project-1', ?, 'outbound', 'sms', 'draft', ?, 'admin', ?, ?)
    `).run(id, clientId, body, now, now);
  }

  function postForm(communicationId: string, approvedBodyHash: string) {
    const formData = new FormData();
    formData.set("communicationId", communicationId);
    formData.set("approvedBodyHash", approvedBodyHash);
    return route.POST(
      new Request("https://studio.bythereeses.com/api/projects/project-1/communications/send-sms", {
        method: "POST",
        body: formData,
      }),
      { params: Promise.resolve({ id: "project-1" }) },
    );
  }

  // --- Test 1: flag off (SMS_ENABLED unset) blocks the send for a consented,
  // non-suppressed client. No silent success; the refusal reaches the redirect
  // as a visible ?smsError= query param. ---
  delete process.env.SMS_ENABLED;
  insertDraft("draft-flag-off", "client-consented", "Flag-off test message.");
  const flagOffResponse = await postForm("draft-flag-off", sha256Hex("Flag-off test message."));
  assert.equal(flagOffResponse.status, 303);
  assert.match(new URL(flagOffResponse.headers.get("location") ?? "").search, /smsError=flag_off/);
  assert.equal(
    (database.prepare("SELECT status FROM project_communications WHERE id = ?").get("draft-flag-off") as { status: string }).status,
    "draft",
    "flag-off draft stays a draft",
  );
  assert.equal(twilioCalls, 0, "flag-off never calls Twilio");

  // --- Test 2: non-consented client is blocked server-side even with the flag on. ---
  process.env.SMS_ENABLED = "1";
  insertDraft("draft-no-consent", "client-noconsent", "No consent test message.");
  const noConsentResponse = await postForm("draft-no-consent", sha256Hex("No consent test message."));
  assert.equal(noConsentResponse.status, 303);
  assert.match(new URL(noConsentResponse.headers.get("location") ?? "").search, /smsError=no_consent/);
  assert.equal(
    (database.prepare("SELECT status FROM project_communications WHERE id = ?").get("draft-no-consent") as { status: string }).status,
    "draft",
    "non-consented draft stays a draft",
  );
  assert.equal(twilioCalls, 0, "no-consent never calls Twilio");

  // --- Test 3: a suppressed (prior STOP) number is blocked even though the
  // client column says opted in — suppression wins. ---
  insertDraft("draft-suppressed", "client-suppressed", "Suppressed test message.");
  const suppressedResponse = await postForm("draft-suppressed", sha256Hex("Suppressed test message."));
  assert.equal(suppressedResponse.status, 303);
  assert.match(new URL(suppressedResponse.headers.get("location") ?? "").search, /smsError=suppressed/);
  assert.equal(twilioCalls, 0, "suppressed never calls Twilio");

  // --- Test 4: body length cap is enforced (Twilio segment ceiling). Attempting
  // to draft an SMS communication over the cap is rejected before any send is
  // even possible. ---
  const { createProjectCommunicationFromForm } = await import("@/lib/project-communications");
  const oversizedForm = new FormData();
  oversizedForm.set("clientId", "client-consented");
  oversizedForm.set("channel", "sms");
  oversizedForm.set("status", "draft");
  oversizedForm.set("body", "x".repeat(1601));
  await assert.rejects(
    () => createProjectCommunicationFromForm("project-1", oversizedForm),
    /character limit/,
    "oversized SMS body is rejected",
  );

  // --- Test 5: the route is not agent/MCP-reachable. No MCP tool posts to this
  // route or calls sendApprovedProjectSms; the only agent-facing SMS tool is the
  // draft-only studio_draft_sms, which never sends. ---
  const draftToolCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 99,
    method: "tools/call",
    params: {
      name: "studio_draft_sms",
      arguments: { projectId: "project-1", clientId: "client-consented", body: "Agent drafted this." },
    },
  });
  assert.equal(draftToolCall.result.isError, false);
  assert.equal(draftToolCall.result.structuredContent.communication.status, "draft", "agent tool only ever drafts");
  const toolsList = await handleStudioMcpMessage({ jsonrpc: "2.0", id: 100, method: "tools/list", params: {} });
  const toolNames: string[] = toolsList.result.tools.map((tool: { name: string }) => tool.name);
  assert.ok(!toolNames.includes("studio_send_sms"), "no send-capable SMS tool is exposed to the agent surface");
  assert.equal(twilioCalls, 0, "agent surface never triggers a Twilio call");

  // --- Test 6: a correctly signed/approved, consented, non-suppressed send
  // succeeds end-to-end (dev-simulated transport, since TWILIO_* stays unset). ---
  insertDraft("draft-happy-path", "client-consented", "Happy path test message.");
  const happyResponse = await postForm("draft-happy-path", sha256Hex("Happy path test message."));
  assert.equal(happyResponse.status, 303);
  assert.match(new URL(happyResponse.headers.get("location") ?? "").search, /saved=sms_sent/);
  const sentRow = database.prepare(
    "SELECT status, delivery_status AS deliveryStatus, provider_message_id AS providerMessageId FROM project_communications WHERE id = ?",
  ).get("draft-happy-path") as { status: string; deliveryStatus: string | null; providerMessageId: string | null };
  assert.equal(sentRow.status, "sent");
  assert.equal(sentRow.deliveryStatus, "simulated", "dev-simulated transport recorded (no real Twilio secrets configured)");
  assert.equal(sentRow.providerMessageId, null, "simulated sends never fabricate a Twilio SID");
  assert.equal(twilioCalls, 0, "dev-simulated happy path never calls the real Twilio API");

  delete process.env.SMS_ENABLED;
  globalThis.fetch = realFetch;
  console.log("send-sms route tests passed");
}

main().catch((error) => {
  globalThis.fetch = realFetch;
  console.error(error);
  process.exit(1);
});
