import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 14 outbound (§7) — the enforcement contract for the admin-only email
// send. Every refusal path must make ZERO Resend calls; the recipient-bound
// approval hash must reject a post-review recipient swap; the agent send-clamp
// must keep every agent-authored email a draft (create, update, re-channel,
// studio_draft_email). Runs with the transport DARK/unset by default.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-email-send-guard-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_SENDING_ENABLED;
delete process.env.REPLY_TOKEN_SECRET;

const realFetch = globalThis.fetch;
let resendCalls: Array<{ body: Record<string, unknown> }> = [];
let resendResponder: () => Response = () =>
  new Response(JSON.stringify({ id: "resend-msg-1" }), { status: 200 });
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (String(url).includes("api.resend.com")) {
    let body: Record<string, unknown> = {};
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    resendCalls.push({ body });
    return resendResponder();
  }
  return realFetch(url as string, init);
}) as unknown as typeof fetch;

async function main() {
  const { rawDb } = await import("@/db/client");
  const { handleStudioMcpMessage } = await import("./studio-mcp");
  const {
    createProjectCommunicationFromAgent,
    sendApprovedProjectEmail,
    sendApprovedProjectEmailFromForm,
    emailApprovalHash,
  } = await import("./project-communications");
  const database = rawDb();
  const now = "2026-06-01T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);

  const sentRowCount = () =>
    (database.prepare("SELECT COUNT(*) AS c FROM project_communications WHERE channel = 'email' AND status = 'sent'").get() as { c: number }).c;
  const statusOf = (id: string) =>
    (database.prepare("SELECT status FROM project_communications WHERE id = ?").get(id) as { status: string }).status;

  const insertDraft = (id: string, opts: { subject?: string | null; body: string; recipientEmail?: string | null; direction?: string; status?: string }) => {
    database.prepare(`
      INSERT INTO project_communications (id, project_id, client_id, direction, channel, status, subject, body, recipient_email, created_by, created_at, updated_at)
      VALUES (?, 'project-1', 'client-1', ?, 'email', ?, ?, ?, ?, 'admin', ?, ?)
    `).run(id, opts.direction ?? "outbound", opts.status ?? "draft", opts.subject ?? null, opts.body, opts.recipientEmail ?? null, now, now);
  };

  // === Test 1: content-hash refuse (body swapped after review) ===
  insertDraft("c-hash", { subject: "Your proposal", body: "Reviewed body Tyler approved.", recipientEmail: "alex@example.com" });
  const approvedHash1 = emailApprovalHash("Your proposal", "Reviewed body Tyler approved.", "alex@example.com");
  database.prepare("UPDATE project_communications SET body = ? WHERE id = 'c-hash'").run("Malicious swapped body.");
  const r1 = await sendApprovedProjectEmail({ projectId: "project-1", communicationId: "c-hash", approvedBodyHash: approvedHash1 });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.reason, "hash_mismatch", "body swap → hash_mismatch");
  assert.equal(statusOf("c-hash"), "draft", "refused draft not marked sent");
  assert.equal(resendCalls.length, 0, "hash mismatch → zero Resend calls");

  // === Test 2: recipient-redirect refuse (Finding MEDIUM 1) ===
  insertDraft("c-swap", { subject: "Links inside", body: "Here are your proposal links.", recipientEmail: "alex@example.com" });
  const approvedHash2 = emailApprovalHash("Links inside", "Here are your proposal links.", "alex@example.com");
  // Post-review, an agent sets ONLY recipientEmail (status stays draft, subject/body unchanged).
  database.prepare("UPDATE project_communications SET recipient_email = ? WHERE id = 'c-swap'").run("attacker@evil.example");
  process.env.EMAIL_SENDING_ENABLED = "1";
  process.env.RESEND_API_KEY = "re_test_key"; // even fully configured, it must refuse
  const r2 = await sendApprovedProjectEmail({ projectId: "project-1", communicationId: "c-swap", approvedBodyHash: approvedHash2 });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, "hash_mismatch", "recipient swap → hash_mismatch");
  assert.equal(statusOf("c-swap"), "draft", "swapped draft not marked sent");
  assert.equal(resendCalls.length, 0, "recipient swap → zero Resend calls (never delivered to attacker)");
  assert.ok(
    !resendCalls.some((c) => JSON.stringify(c.body).includes("attacker@evil.example")),
    "the approved email was never delivered to the swapped address",
  );
  delete process.env.EMAIL_SENDING_ENABLED;
  delete process.env.RESEND_API_KEY;

  // === Test 3: suppression honored (checked before the flag) ===
  database.prepare("INSERT INTO email_suppressions (email, suppressed_at, source) VALUES ('sam@example.com', ?, 'test')").run(now);
  insertDraft("c-supp", { subject: "Hi", body: "Suppressed recipient body.", recipientEmail: "sam@example.com" });
  const approvedHash3 = emailApprovalHash("Hi", "Suppressed recipient body.", "sam@example.com");
  const r3 = await sendApprovedProjectEmail({ projectId: "project-1", communicationId: "c-supp", approvedBodyHash: approvedHash3 });
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.equal(r3.reason, "suppressed", "suppressed recipient → suppressed");
  assert.equal(statusOf("c-supp"), "draft", "suppressed draft intact");
  assert.equal(resendCalls.length, 0, "suppressed → zero Resend calls");

  // === Test 4: flag off → flag_off, draft intact ===
  insertDraft("c-flag", { subject: "Hi", body: "Flag-off body.", recipientEmail: "alex@example.com" });
  const approvedHash4 = emailApprovalHash("Hi", "Flag-off body.", "alex@example.com");
  delete process.env.EMAIL_SENDING_ENABLED;
  const r4 = await sendApprovedProjectEmail({ projectId: "project-1", communicationId: "c-flag", approvedBodyHash: approvedHash4 });
  assert.equal(r4.ok, false);
  if (!r4.ok) assert.equal(r4.reason, "flag_off", "flag unset → flag_off");
  assert.equal(statusOf("c-flag"), "draft", "flag-off draft intact");
  assert.equal(resendCalls.length, 0, "flag off → zero Resend calls");

  // === Test 5: fail-closed key → not_configured, never marked sent ===
  insertDraft("c-nokey", { subject: "Hi", body: "No-key body.", recipientEmail: "alex@example.com" });
  const approvedHash5 = emailApprovalHash("Hi", "No-key body.", "alex@example.com");
  process.env.EMAIL_SENDING_ENABLED = "1";
  delete process.env.RESEND_API_KEY;
  const r5 = await sendApprovedProjectEmail({ projectId: "project-1", communicationId: "c-nokey", approvedBodyHash: approvedHash5 });
  assert.equal(r5.ok, false);
  if (!r5.ok) assert.equal(r5.reason, "not_configured", "no key → not_configured");
  assert.equal(statusOf("c-nokey"), "draft", "no-key draft intact (never sent)");
  assert.equal(resendCalls.length, 0, "no key → resendRequest short-circuits, no network");

  // === Test 6: length cap at create AND at send ===
  const oversize = "x".repeat(50_001);
  await assert.rejects(
    () => createProjectCommunicationFromAgent("project-1", { channel: "email", body: oversize }),
    /exceeds/,
    "over-cap email body rejected at create",
  );
  insertDraft("c-long", { subject: "Hi", body: oversize, recipientEmail: "alex@example.com" });
  const r6 = await sendApprovedProjectEmail({ projectId: "project-1", communicationId: "c-long", approvedBodyHash: emailApprovalHash("Hi", oversize, "alex@example.com") });
  assert.equal(r6.ok, false);
  if (!r6.ok) assert.equal(r6.reason, "too_long", "over-cap legacy draft refused at send");
  assert.equal(resendCalls.length, 0, "too_long → zero Resend calls");

  // === Test 7: subject header-injection folded at create ===
  const injected = await createProjectCommunicationFromAgent("project-1", {
    channel: "email",
    subject: "Hello\r\nBcc: leak@evil.example",
    body: "Body.",
  });
  assert.ok(injected.subject && !/[\r\n]/.test(injected.subject), "email subject is folded single-line at create");

  // === Test 8: not-draft (inbound row + already-sent) → not_draft ===
  insertDraft("c-inbound", { subject: "Re: hi", body: "Client reply.", recipientEmail: "alex@example.com", direction: "inbound", status: "archived" });
  const r8a = await sendApprovedProjectEmail({ projectId: "project-1", communicationId: "c-inbound", approvedBodyHash: emailApprovalHash("Re: hi", "Client reply.", "alex@example.com") });
  assert.equal(r8a.ok, false);
  if (!r8a.ok) assert.equal(r8a.reason, "not_draft", "inbound row can never be sent back");
  insertDraft("c-sent", { subject: "Hi", body: "Already sent.", recipientEmail: "alex@example.com", status: "sent" });
  const r8b = await sendApprovedProjectEmail({ projectId: "project-1", communicationId: "c-sent", approvedBodyHash: emailApprovalHash("Hi", "Already sent.", "alex@example.com") });
  assert.equal(r8b.ok, false);
  if (!r8b.ok) assert.equal(r8b.reason, "not_draft", "already-sent row refuses re-send");
  assert.equal(resendCalls.length, 0, "not_draft paths → zero Resend calls");

  // === Test 9: delivered path (flag on + key set + valid hash) → sent, id, reply_to OMITTED (secret unset) ===
  insertDraft("c-ok", { subject: "Your\r\nproposal", body: "Deliver me.", recipientEmail: "alex@example.com" });
  // Stored subject carries a CRLF (inserted directly, bypassing create fold) — the
  // hash binds the RAW stored subject; send-time stripReplySubjectForSend folds it.
  const storedSubject = (database.prepare("SELECT subject AS s FROM project_communications WHERE id = 'c-ok'").get() as { s: string }).s;
  const approvedHash9 = emailApprovalHash(storedSubject, "Deliver me.", "alex@example.com");
  process.env.EMAIL_SENDING_ENABLED = "1";
  process.env.RESEND_API_KEY = "re_test_key";
  resendResponder = () => new Response(JSON.stringify({ id: "resend-delivered-1" }), { status: 200 });
  const r9 = await sendApprovedProjectEmail({ projectId: "project-1", communicationId: "c-ok", approvedBodyHash: approvedHash9 });
  assert.equal(r9.ok, true, "valid hash + flag + key → delivered");
  if (r9.ok) assert.equal(r9.providerMessageId, "resend-delivered-1", "Resend id captured");
  assert.equal(resendCalls.length, 1, "delivered → exactly one Resend call");
  const deliveredSubject = String(resendCalls[0].body.subject ?? "");
  assert.ok(!/[\r\n]/.test(deliveredSubject), "delivered subject folded (header-injection defense at send)");
  assert.equal(resendCalls[0].body.reply_to, undefined, "REPLY_TOKEN_SECRET unset → reply_to OMITTED (no empty-tag address)");
  const okRow = database.prepare("SELECT status, provider_message_id AS pmi, delivery_status AS ds FROM project_communications WHERE id = 'c-ok'").get() as { status: string; pmi: string; ds: string };
  assert.deepEqual(okRow, { status: "sent", pmi: "resend-delivered-1", ds: "sent" }, "row marked sent with provider id + delivery status");

  // === Test 9b: with REPLY_TOKEN_SECRET set → reply_to present + shaped ===
  // Uses a real UUID project id (prod project ids are crypto.randomUUID()), since
  // the reply token derives from the 16 UUID bytes.
  const uuidProject = randomUUID();
  database.prepare("INSERT INTO projects (id, name, type, stage, status, created_at, updated_at) VALUES (?, 'UUID Wedding', 'wedding', 'inquiry', 'active', ?, ?)").run(uuidProject, now, now);
  database.prepare("INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at) VALUES ('pp-uuid', ?, 'client-1', 'primary', 1, ?)").run(uuidProject, now);
  database.prepare(`
    INSERT INTO project_communications (id, project_id, client_id, direction, channel, status, subject, body, recipient_email, created_by, created_at, updated_at)
    VALUES ('c-reply', ?, 'client-1', 'outbound', 'email', 'draft', 'Hi', 'Two-way body.', 'alex@example.com', 'admin', ?, ?)
  `).run(uuidProject, now, now);
  process.env.REPLY_TOKEN_SECRET = "guard-reply-secret";
  process.env.REPLY_INBOX_DOMAIN = "inbox.bythereeses.com";
  resendCalls = [];
  const r9b = await sendApprovedProjectEmail({ projectId: uuidProject, communicationId: "c-reply", approvedBodyHash: emailApprovalHash("Hi", "Two-way body.", "alex@example.com") });
  assert.equal(r9b.ok, true);
  assert.equal(resendCalls.length, 1);
  assert.match(String(resendCalls[0].body.reply_to ?? ""), /^reply\+[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}@inbox\.bythereeses\.com$/, "reply_to carries the project token when the secret is set");
  delete process.env.REPLY_TOKEN_SECRET;

  // === Test 10: ambiguous 5xx → send_failed, draft stays ===
  resendCalls = [];
  insertDraft("c-5xx", { subject: "Hi", body: "Ambiguous.", recipientEmail: "alex@example.com" });
  resendResponder = () => new Response("upstream", { status: 502 });
  const r10 = await sendApprovedProjectEmail({ projectId: "project-1", communicationId: "c-5xx", approvedBodyHash: emailApprovalHash("Hi", "Ambiguous.", "alex@example.com") });
  assert.equal(r10.ok, false);
  if (!r10.ok) assert.equal(r10.reason, "send_failed", "5xx → send_failed (never a false sent)");
  assert.equal(statusOf("c-5xx"), "draft", "ambiguous outcome keeps the draft");
  resendResponder = () => new Response(JSON.stringify({ id: "resend-msg-1" }), { status: 200 });

  // === Test 11: agent cannot send (create + update re-channel + draft tool) ===
  const sentBefore = sentRowCount();
  const resendBefore = resendCalls.length;
  // 11a: generic create email+sent → draft.
  const c11a = await handleStudioMcpMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "studio_create_communication", arguments: { projectId: "project-1", channel: "email", status: "sent", body: "Agent forged sent email." } },
  });
  assert.equal((c11a as { result: { structuredContent: { communication: { status: string } } } }).result.structuredContent.communication.status, "draft", "agent create email+sent → draft");
  // 11b: re-channel note → email + sent in one patch → draft.
  const note = await createProjectCommunicationFromAgent("project-1", { channel: "note", status: "draft", body: "A note." });
  const c11b = await handleStudioMcpMessage({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "studio_update_communication", arguments: { projectId: "project-1", communicationId: note.id, channel: "email", status: "sent" } },
  });
  assert.equal((c11b as { result: { structuredContent: { communication: { status: string; channel: string } } } }).result.structuredContent.communication.status, "draft", "agent re-channel note→email+sent → draft");
  // 11c: re-channel sms → email + sent → draft.
  const sms = await createProjectCommunicationFromAgent("project-1", { channel: "sms", status: "draft", body: "An sms draft." });
  const c11c = await handleStudioMcpMessage({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "studio_update_communication", arguments: { projectId: "project-1", communicationId: sms.id, channel: "email", status: "sent" } },
  });
  assert.equal((c11c as { result: { structuredContent: { communication: { status: string } } } }).result.structuredContent.communication.status, "draft", "agent re-channel sms→email+sent → draft");
  // 11d: studio_draft_email hard-forces channel:email/status:draft even with hostile args.
  const c11d = await handleStudioMcpMessage({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "studio_draft_email", arguments: { projectId: "project-1", body: "Draft email.", status: "sent", channel: "sms", createdBy: "admin" } },
  });
  const draftEmail = (c11d as { result: { structuredContent: { communication: { status: string; channel: string; createdBy: string } } } }).result.structuredContent.communication;
  assert.equal(draftEmail.channel, "email", "studio_draft_email forces channel email");
  assert.equal(draftEmail.status, "draft", "studio_draft_email forces status draft");
  assert.equal(draftEmail.createdBy, "agent", "studio_draft_email forces createdBy agent");
  assert.equal(sentRowCount(), sentBefore, "no NEW email row reached status sent via the agent");
  assert.equal(resendCalls.length, resendBefore, "agent-cannot-send paths → zero Resend calls");

  // === Test 12: form wrapper refuses missing hash ===
  insertDraft("c-form", { subject: "Hi", body: "Form body.", recipientEmail: "alex@example.com" });
  const form = new FormData();
  form.set("projectId", "project-1");
  form.set("communicationId", "c-form");
  form.set("approvedBodyHash", "not-the-hash");
  const r12 = await sendApprovedProjectEmailFromForm(form);
  assert.equal(r12.ok, false);
  if (!r12.ok) assert.equal(r12.reason, "hash_mismatch", "form send with wrong hash → hash_mismatch");

  globalThis.fetch = realFetch;
  console.log("email send guard tests passed");
}

main().catch((error) => {
  globalThis.fetch = realFetch;
  console.error(error);
  process.exit(1);
});
