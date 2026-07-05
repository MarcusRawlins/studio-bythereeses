import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-twilio-inbound-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
delete process.env.ORIGIN_PROXY_SECRET; // keep guardDirectWorkerApiRequest a no-op

const INBOUND_URL = "https://studio.bythereeses.com/api/twilio/inbound";
const TOKEN = "twilio_test_token";

function signature(url: string, fields: Record<string, string>, token: string) {
  const sorted = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const data = url + sorted.map(([k, v]) => k + v).join("");
  return createHmac("sha1", token).update(data, "utf8").digest("base64");
}

function buildRequest(fields: Record<string, string>, opts: { signature?: string | null; forwardedHost?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (opts.signature !== null && opts.signature !== undefined) headers["x-twilio-signature"] = opts.signature;
  if (opts.forwardedHost) headers["x-forwarded-host"] = opts.forwardedHost;
  return new Request(INBOUND_URL, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const database = rawDb();
  const { POST } = await import("./route");
  const now = "2026-06-01T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Couple Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  // A couple sharing ONE number (clients.phone is not unique).
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, sms_opt_in, created_at, updated_at)
    VALUES ('client-a', 'Alex', 'A', 'a@example.com', '(555) 888-7777', 1, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, sms_opt_in, created_at, updated_at)
    VALUES ('client-b', 'Bailey', 'B', 'b@example.com', '555-888-7777', 1, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('p-a', 'project-1', 'client-a', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('p-b', 'project-1', 'client-b', 'partner', 0, ?)
  `).run(now);

  const countSuppression = (e164: string) =>
    (database.prepare("SELECT COUNT(*) AS c FROM sms_suppressions WHERE phone_e164 = ?").get(e164) as { c: number }).c;
  const optIn = (id: string) =>
    (database.prepare("SELECT sms_opt_in AS v FROM clients WHERE id = ?").get(id) as { v: number }).v;
  const activityCount = (action: string) =>
    (database.prepare("SELECT COUNT(*) AS c FROM activity_logs WHERE action = ?").get(action) as { c: number }).c;

  // --- Fail-closed: 503 when TWILIO_AUTH_TOKEN unset ---
  delete process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_PUBLIC_WEBHOOK_URL_INBOUND = INBOUND_URL;
  let res = await POST(buildRequest({ From: "+15558887777", Body: "STOP" }, { signature: "x" }));
  assert.equal(res.status, 503, "503 when auth token unset");

  // --- Fail-closed: 503 when the per-route URL constant unset (B2) ---
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  delete process.env.TWILIO_PUBLIC_WEBHOOK_URL_INBOUND;
  res = await POST(buildRequest({ From: "+15558887777", Body: "STOP" }, { signature: "x" }));
  assert.equal(res.status, 503, "503 when inbound URL constant unset");
  process.env.TWILIO_PUBLIC_WEBHOOK_URL_INBOUND = INBOUND_URL;

  // --- 403 missing signature ---
  res = await POST(buildRequest({ From: "+15558887777", Body: "STOP" }, { signature: null }));
  assert.equal(res.status, 403, "403 when signature header missing");

  // --- 403 wrong signature ---
  res = await POST(buildRequest({ From: "+15558887777", Body: "STOP" }, { signature: "not-the-real-sig" }));
  assert.equal(res.status, 403, "403 on bad signature");
  assert.equal(countSuppression("+15558887777"), 0, "bad-sig STOP writes nothing");

  // --- Correctly signed STOP → 200, suppression + BOTH matched clients opted out ---
  const stopFields = { From: "+15558887777", Body: "STOP", MessageSid: "SM00000000000000000000000000000010" };
  res = await POST(buildRequest(stopFields, { signature: signature(INBOUND_URL, stopFields, TOKEN) }));
  assert.equal(res.status, 200, "signed STOP → 200");
  assert.equal(countSuppression("+15558887777"), 1, "STOP inserts a suppression row");
  assert.equal(optIn("client-a"), 0, "STOP opts out matched client A");
  assert.equal(optIn("client-b"), 0, "STOP opts out matched client B (plural)");
  assert.equal(activityCount("client.sms.opted_out") >= 2, true, "per-client opted_out activity");

  // --- Spoofed X-Forwarded-Host does NOT change the verified URL ---
  // A valid signature over the CONFIGURED constant still passes even with a
  // hostile forwarded host...
  const startFields = { From: "+15558887777", Body: "START", MessageSid: "SM00000000000000000000000000000011" };
  res = await POST(
    buildRequest(startFields, {
      signature: signature(INBOUND_URL, startFields, TOKEN),
      forwardedHost: "evil.attacker.example",
    }),
  );
  assert.equal(res.status, 200, "spoofed host ignored — signature verified against configured constant");
  assert.equal(countSuppression("+15558887777"), 0, "START deletes the suppression row");
  assert.equal(optIn("client-a"), 1, "START re-opts-in matched client (fresh consent)");
  assert.equal(optIn("client-b"), 1, "START re-opts-in matched client B");

  // ...and a signature computed over the SPOOFED host fails (host is not the base).
  const spoofUrl = "https://evil.attacker.example/api/twilio/inbound";
  res = await POST(
    buildRequest(startFields, {
      signature: signature(spoofUrl, startFields, TOKEN),
      forwardedHost: "evil.attacker.example",
    }),
  );
  assert.equal(res.status, 403, "signature over spoofed host is rejected");

  // --- Unmatched STOP: still suppression + Tyler-visible activity row ---
  const unmatched = { From: "+19990001111", Body: "STOP" };
  const beforeUnmatched = activityCount("client.sms.unmatched_stop");
  res = await POST(buildRequest(unmatched, { signature: signature(INBOUND_URL, unmatched, TOKEN) }));
  assert.equal(res.status, 200, "unmatched STOP → 200");
  assert.equal(countSuppression("+19990001111"), 1, "unmatched STOP still writes suppression");
  assert.equal(activityCount("client.sms.unmatched_stop"), beforeUnmatched + 1, "unmatched STOP surfaced to Tyler");

  // --- Normalization-failed STOP: flagged activity, no suppression keyed ---
  const garbage = { From: "not-a-number", Body: "STOP" };
  const beforeBad = activityCount("client.sms.unnormalizable_stop");
  res = await POST(buildRequest(garbage, { signature: signature(INBOUND_URL, garbage, TOKEN) }));
  assert.equal(res.status, 200, "unnormalizable STOP → 200");
  assert.equal(activityCount("client.sms.unnormalizable_stop"), beforeBad + 1, "unnormalizable STOP surfaced");

  // --- Length caps: an over-cap body is truncated, not error-dropped ---
  const bigBody = "A".repeat(5000);
  const bigFields = { From: "+15558887777", Body: bigBody, MessageSid: "SM00000000000000000000000000000020" };
  res = await POST(buildRequest(bigFields, { signature: signature(INBOUND_URL, bigFields, TOKEN) }));
  assert.equal(res.status, 200, "over-cap body handled, not crashed");
  const bigRow = database.prepare(
    "SELECT body FROM project_communications WHERE provider_message_id = 'SM00000000000000000000000000000020'",
  ).get() as { body: string } | undefined;
  assert.ok(bigRow, "over-cap inbound message logged");
  assert.equal(bigRow!.body.length <= 1600, true, "body capped at 1600");

  // --- Replayed MessageSid is an idempotent no-op (INSERT ON CONFLICT, no dup) ---
  const replay = { From: "+15558887777", Body: "Just a normal reply.", MessageSid: "SM00000000000000000000000000000030" };
  const sig = signature(INBOUND_URL, replay, TOKEN);
  await POST(buildRequest(replay, { signature: sig }));
  await POST(buildRequest(replay, { signature: sig }));
  const replayCount = (database.prepare(
    "SELECT COUNT(*) AS c FROM project_communications WHERE provider_message_id = 'SM00000000000000000000000000000030'",
  ).get() as { c: number }).c;
  assert.equal(replayCount, 1, "replayed MessageSid does not duplicate the inbound row");

  console.log("twilio inbound route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
