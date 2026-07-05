import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-twilio-status-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
delete process.env.ORIGIN_PROXY_SECRET;

const STATUS_URL = "https://studio.bythereeses.com/api/twilio/status";
const TOKEN = "twilio_test_token";

function signature(url: string, fields: Record<string, string>, token: string) {
  const sorted = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const data = url + sorted.map(([k, v]) => k + v).join("");
  return createHmac("sha1", token).update(data, "utf8").digest("base64");
}

function buildRequest(fields: Record<string, string>, opts: { signature?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (opts.signature !== null && opts.signature !== undefined) headers["x-twilio-signature"] = opts.signature;
  return new Request(STATUS_URL, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const database = rawDb();
  const { POST } = await import("./route");
  const now = "2026-06-01T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_communications (id, project_id, direction, channel, status, body, provider_message_id, delivery_status, created_by, created_at, updated_at)
    VALUES ('comm-1', 'project-1', 'outbound', 'sms', 'sent', 'Hi there. Reply STOP to opt out.', 'SM00000000000000000000000000000099', 'queued', 'admin', ?, ?)
  `).run(now, now);

  const deliveryStatus = () =>
    (database.prepare("SELECT delivery_status AS v FROM project_communications WHERE id = 'comm-1'").get() as { v: string }).v;
  const commCount = () =>
    (database.prepare("SELECT COUNT(*) AS c FROM project_communications").get() as { c: number }).c;

  // --- Fail-closed matrix ---
  delete process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_PUBLIC_WEBHOOK_URL_STATUS = STATUS_URL;
  let res = await POST(buildRequest({ MessageSid: "SM00000000000000000000000000000099", MessageStatus: "delivered" }, { signature: "x" }));
  assert.equal(res.status, 503, "503 when auth token unset");

  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  delete process.env.TWILIO_PUBLIC_WEBHOOK_URL_STATUS;
  res = await POST(buildRequest({ MessageSid: "SM00000000000000000000000000000099", MessageStatus: "delivered" }, { signature: "x" }));
  assert.equal(res.status, 503, "503 when status URL constant unset (B2)");
  process.env.TWILIO_PUBLIC_WEBHOOK_URL_STATUS = STATUS_URL;

  res = await POST(buildRequest({ MessageSid: "SM00000000000000000000000000000099", MessageStatus: "delivered" }, { signature: null }));
  assert.equal(res.status, 403, "403 when signature missing");

  res = await POST(buildRequest({ MessageSid: "SM00000000000000000000000000000099", MessageStatus: "delivered" }, { signature: "wrong" }));
  assert.equal(res.status, 403, "403 on bad signature");
  assert.equal(deliveryStatus(), "queued", "bad-sig callback does not mutate the row");

  // --- Valid callback advances deliveryStatus on the row matched by SID ---
  const okFields = { MessageSid: "SM00000000000000000000000000000099", MessageStatus: "delivered" };
  res = await POST(buildRequest(okFields, { signature: signature(STATUS_URL, okFields, TOKEN) }));
  assert.equal(res.status, 200, "valid callback → 200");
  assert.equal(deliveryStatus(), "delivered", "deliveryStatus advanced by providerMessageId");

  // --- Status validated against the allowlist (bogus status → no update) ---
  const bogus = { MessageSid: "SM00000000000000000000000000000099", MessageStatus: "totally-made-up" };
  res = await POST(buildRequest(bogus, { signature: signature(STATUS_URL, bogus, TOKEN) }));
  assert.equal(res.status, 200, "unknown status still 2xx (no retry storm)");
  assert.equal(deliveryStatus(), "delivered", "bogus status left the row unchanged");

  // --- Unknown SID logged + ignored (no row created/mutated) ---
  const before = commCount();
  const unknown = { MessageSid: "SM00000000000000000000000000000000", MessageStatus: "failed" };
  res = await POST(buildRequest(unknown, { signature: signature(STATUS_URL, unknown, TOKEN) }));
  assert.equal(res.status, 200, "unknown SID → 200");
  assert.equal(commCount(), before, "unknown SID creates no row");
  assert.equal(deliveryStatus(), "delivered", "unknown SID mutates nothing");
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM activity_logs WHERE action = 'project.communication.sms_status_unknown_sid'").get() as { c: number }).c,
    1,
    "unknown SID is logged",
  );

  console.log("twilio status route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
