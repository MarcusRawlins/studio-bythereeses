import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-sms-guard-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STRIPE_SECRET_KEY = "sk_test_sms_guard";

// Guard tests run with the transport DARK and unconfigured: SMS_ENABLED unset,
// TWILIO_* unset. Any Twilio call would be an integrity failure.
delete process.env.SMS_ENABLED;
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
  const { handleStudioMcpMessage } = await import("./studio-mcp");
  const {
    createProjectCommunicationFromAgent,
    updateProjectCommunicationFromAgent,
    sendApprovedProjectSmsFromForm,
  } = await import("./project-communications");
  const { sendProjectSms, SmsConsentError } = await import("./sms");
  const database = rawDb();
  const now = "2026-06-01T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, sms_opt_in, created_at, updated_at)
    VALUES ('client-consented', 'Alex', 'Taylor', 'alex@example.com', '+15550000001', 1, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, sms_opt_in, created_at, updated_at)
    VALUES ('client-suppressed', 'Sam', 'Stone', 'sam@example.com', '+15550000002', 1, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, sms_opt_in, created_at, updated_at)
    VALUES ('client-noconsent', 'Nora', 'Nolan', 'nora@example.com', '+15550000003', 0, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-consented', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO sms_suppressions (phone_e164, stopped_at, note)
    VALUES ('+15550000002', ?, 'prior STOP')
  `).run(now);

  const sentRowCount = () =>
    (database.prepare("SELECT COUNT(*) AS c FROM project_communications WHERE channel = 'sms' AND status = 'sent'").get() as { c: number }).c;
  assert.equal(sentRowCount(), 0, "no sent sms rows at start");

  // --- Test 1: studio_draft_sms forces draft/sms/agent regardless of args ---
  const draftCall = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "studio_draft_sms",
      arguments: {
        projectId: "project-1",
        body: "Hi Alex, quick text follow-up.",
        // Hostile fields that must be IGNORED:
        status: "sent",
        channel: "email",
        createdBy: "admin",
      },
    },
  });
  assert.equal(draftCall.result.isError, false);
  const draftComm = draftCall.result.structuredContent.communication;
  assert.equal(draftComm.channel, "sms", "draft tool forces channel sms");
  assert.equal(draftComm.status, "draft", "draft tool forces status draft");
  assert.equal(draftComm.createdBy, "agent", "draft tool forces createdBy agent");
  assert.equal(twilioCalls, 0, "draft tool never calls Twilio");

  // --- Test 2 (B1b): generic *FromAgent path cannot mint/flip an sms send-state ---
  const agentSmsSent = await createProjectCommunicationFromAgent("project-1", {
    channel: "sms",
    status: "sent",
    body: "Forged sent SMS attempt.",
  });
  assert.equal(agentSmsSent.channel, "sms");
  assert.equal(agentSmsSent.status, "draft", "agent sms status:sent is clamped to draft");

  const agentSmsQueued = await createProjectCommunicationFromAgent("project-1", {
    channel: "sms",
    status: "queued",
    body: "Forged queued SMS attempt.",
  });
  assert.equal(agentSmsQueued.status, "draft", "agent sms status:queued is clamped to draft");

  const flipAttempt = await updateProjectCommunicationFromAgent("project-1", agentSmsSent.id, { status: "sent" });
  assert.equal(flipAttempt.status, "draft", "agent cannot flip an existing sms row to sent");
  const flipQueued = await updateProjectCommunicationFromAgent("project-1", agentSmsSent.id, { status: "queued" });
  assert.equal(flipQueued.status, "draft", "agent cannot flip an existing sms row to queued");

  // Phase 14 §8: the agent send-clamp now covers EMAIL too. An agent-authored
  // email row can only ever land "draft" — a prompt-injected agent can never mint
  // a "we emailed them" record. (Non-agent actors are unaffected; see the direct
  // db.insert in approveInquiryReply / the sequence runner's systemActor.)
  const agentEmailSent = await createProjectCommunicationFromAgent("project-1", {
    channel: "email",
    status: "sent",
    body: "Legit sent email log.",
  });
  assert.equal(agentEmailSent.status, "draft", "agent email status:sent is clamped to draft (§8)");

  // Same via the generic MCP tool surface (studio_create_communication).
  const genericSmsSent = await handleStudioMcpMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "studio_create_communication",
      arguments: { projectId: "project-1", channel: "sms", status: "sent", body: "Generic-tool forged sent." },
    },
  });
  assert.equal(genericSmsSent.result.structuredContent.communication.status, "draft", "generic tool sms status:sent → draft");
  assert.equal(twilioCalls, 0, "B1b path never calls Twilio");
  assert.equal(sentRowCount(), 0, "no sms row ever reached status sent via agent");

  // --- Test 3 (B1a): post-review body swap makes the send REFUSE ---
  const approvedDraft = await createProjectCommunicationFromAgent("project-1", {
    clientId: "client-consented",
    channel: "sms",
    status: "draft",
    body: "Reviewed body Tyler approved.",
  });
  const approvedHash = sha256Hex("Reviewed body Tyler approved.");
  // A prompt-injected agent rewrites the stored draft AFTER review.
  database.prepare("UPDATE project_communications SET body = ? WHERE id = ?").run("Malicious swapped body.", approvedDraft.id);
  const swapForm = new FormData();
  swapForm.set("projectId", "project-1");
  swapForm.set("communicationId", approvedDraft.id);
  swapForm.set("approvedBodyHash", approvedHash);
  const refused = await sendApprovedProjectSmsFromForm(swapForm);
  assert.equal(refused.ok, false, "body-hash mismatch refuses");
  if (!refused.ok) assert.equal(refused.reason, "hash_mismatch");
  assert.equal(
    (database.prepare("SELECT status FROM project_communications WHERE id = ?").get(approvedDraft.id) as { status: string }).status,
    "draft",
    "refused draft is NOT marked sent",
  );
  assert.equal(twilioCalls, 0, "body-hash refuse never calls Twilio");

  // --- Test 3b: already-"sent" row → refused (no double-send on form re-submit) ---
  const alreadySent = await createProjectCommunicationFromAgent("project-1", {
    clientId: "client-consented",
    channel: "sms",
    status: "draft",
    body: "Already delivered body.",
  });
  database.prepare("UPDATE project_communications SET status = 'sent', provider_message_id = 'SMkeepthis0000000000000000000001' WHERE id = ?").run(alreadySent.id);
  const resubmit = new FormData();
  resubmit.set("projectId", "project-1");
  resubmit.set("communicationId", alreadySent.id);
  resubmit.set("approvedBodyHash", sha256Hex("Already delivered body.")); // matching hash — must STILL refuse on status
  const resubmitResult = await sendApprovedProjectSmsFromForm(resubmit);
  assert.equal(resubmitResult.ok, false, "already-sent row refuses re-send");
  if (!resubmitResult.ok) assert.equal(resubmitResult.reason, "not_draft", "reason is not_draft");
  assert.equal(
    (database.prepare("SELECT provider_message_id AS v FROM project_communications WHERE id = ?").get(alreadySent.id) as { v: string }).v,
    "SMkeepthis0000000000000000000001",
    "already-sent providerMessageId is not overwritten",
  );
  assert.equal(twilioCalls, 0, "already-sent refuse never calls Twilio");

  // --- Test 3c: an INBOUND sms row (client's STOP/reply) → refused, not "sent" back ---
  database.prepare(`
    INSERT INTO project_communications (id, project_id, client_id, direction, channel, status, body, provider_message_id, delivery_status, created_by, created_at, updated_at)
    VALUES ('inbound-reply', 'project-1', 'client-consented', 'inbound', 'sms', 'archived', 'STOP', 'SMinbound00000000000000000000001', 'received', 'system', ?, ?)
  `).run(now, now);
  const inboundForm = new FormData();
  inboundForm.set("projectId", "project-1");
  inboundForm.set("communicationId", "inbound-reply");
  inboundForm.set("approvedBodyHash", sha256Hex("STOP"));
  const inboundResult = await sendApprovedProjectSmsFromForm(inboundForm);
  assert.equal(inboundResult.ok, false, "inbound sms row refuses being sent");
  if (!inboundResult.ok) assert.equal(inboundResult.reason, "not_draft", "reason is not_draft for inbound row");
  assert.deepEqual(
    database.prepare("SELECT direction, status, provider_message_id AS pmi FROM project_communications WHERE id = 'inbound-reply'").get(),
    { direction: "inbound", status: "archived", pmi: "SMinbound00000000000000000000001" },
    "inbound row untouched (direction/status/providerMessageId preserved)",
  );
  assert.equal(twilioCalls, 0, "inbound refuse never calls Twilio");

  // --- Test 4: no consent throws SmsConsentError, no NEW sent row, zero Twilio ---
  // (a sent row already exists from the already-sent fixture in Test 3b, so assert
  // the consent refusal adds NO new sent row rather than an absolute count.)
  const sentBeforeConsent = sentRowCount();
  await assert.rejects(
    () => sendProjectSms({ projectId: "project-1", clientId: "client-noconsent", body: "Should not send." }),
    (error: unknown) => error instanceof SmsConsentError,
    "non-consented client throws SmsConsentError",
  );
  assert.equal(sentRowCount(), sentBeforeConsent, "no new sent row after consent refusal");
  assert.equal(twilioCalls, 0, "no consent never calls Twilio");

  // --- Test 5: flag-off tested with a CONSENTED, non-suppressed client ---
  // (consent gate is ordered BEFORE the flag, so a non-consented client would
  // short-circuit on consent and never exercise the flag branch.)
  const flagOff = await sendProjectSms({ projectId: "project-1", clientId: "client-consented", body: "Dark." });
  assert.equal(flagOff.ok, false);
  if (!flagOff.ok) assert.equal(flagOff.reason, "flag_off", "SMS_ENABLED unset → flag_off for consented client");
  assert.equal(twilioCalls, 0, "flag off never calls Twilio");

  // --- Test 6: suppression WINS — consented client whose number is suppressed ---
  process.env.SMS_ENABLED = "1"; // even with the flag ON, suppression is checked first
  const suppressed = await sendProjectSms({ projectId: "project-1", clientId: "client-suppressed", body: "Blocked." });
  assert.equal(suppressed.ok, false);
  if (!suppressed.ok) assert.equal(suppressed.reason, "suppressed", "suppressed number refused even with flag on");
  assert.equal(twilioCalls, 0, "suppressed never calls Twilio");
  delete process.env.SMS_ENABLED;

  // --- Test 7: fail-closed prod transport throw; dev simulate outside prod ---
  const { sendTwilioMessage, SmsConfigError } = await import("./sms");
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  await assert.rejects(
    () => sendTwilioMessage({ to: "+15550000001", body: "x" }),
    (error: unknown) => error instanceof SmsConfigError,
    "prod + unset TWILIO_* throws SmsConfigError",
  );
  process.env.NODE_ENV = originalNodeEnv;
  const sim = await sendTwilioMessage({ to: "+15550000001", body: "x" });
  assert.deepEqual(sim, { simulated: true }, "dev simulate outside prod");
  assert.equal(twilioCalls, 0, "no real Twilio network across the whole guard suite");

  globalThis.fetch = realFetch;
  console.log("sms guard tests passed");
}

main().catch((error) => {
  globalThis.fetch = realFetch;
  console.error(error);
  process.exit(1);
});
