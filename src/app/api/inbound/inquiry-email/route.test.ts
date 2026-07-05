import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-inbound-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
delete process.env.RESEND_API_KEY;

const ENDPOINT = "https://studio.bythereeses.com/api/inbound/inquiry-email";
const SECRET = "test-inbound-secret";

function post(body: unknown, opts?: { auth?: string | null }) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts?.auth !== null) headers.authorization = `Bearer ${opts?.auth ?? SECRET}`;
  return new Request(ENDPOINT, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function validPayload(messageId: string) {
  return {
    envelopeFrom: "jane@example.com",
    envelopeTo: "inquiries@bythereeses.com",
    headerFrom: '"Jane Doe" <jane@example.com>',
    subject: "Wedding inquiry",
    messageId,
    authResults: "mx; spf=pass; dkim=pass; dmarc=pass",
    raw: "Content-Type: text/plain\n\nWe would love to book you!",
  };
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();

  // ---- 503 when the secret is unset (fail closed) ----
  delete process.env.INBOUND_INTAKE_SECRET;
  process.env.INQUIRY_INTAKE_ENABLED = "true";
  assert.equal((await POST(post(validPayload("<a@x>")) as never)).status, 503, "unset secret → 503");

  // ---- 401 on wrong/absent bearer ----
  process.env.INBOUND_INTAKE_SECRET = SECRET;
  assert.equal((await POST(post(validPayload("<a@x>"), { auth: "wrong" }) as never)).status, 401, "wrong bearer → 401");
  assert.equal((await POST(post(validPayload("<a@x>"), { auth: null }) as never)).status, 401, "missing bearer → 401");

  // ---- 503 when the flag is off (non-2xx, NOT 202) ----
  process.env.INQUIRY_INTAKE_ENABLED = "false";
  const flagOff = await POST(post(validPayload("<a@x>")) as never);
  assert.equal(flagOff.status, 503, "flag off → 503 (Worker forwards to human)");
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM inbound_inquiries").get().c, 0, "flag off writes nothing");

  // ---- 200 + row insert on valid ----
  process.env.INQUIRY_INTAKE_ENABLED = "true";
  const ok = await POST(post(validPayload("<msg-1@example.com>")) as never);
  assert.equal(ok.status, 200, "valid → 200");
  const okBody = await ok.json();
  assert.equal(okBody.deduped, false);
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM inbound_inquiries").get().c, 1, "one row persisted");

  // ---- idempotent on repeated Message-ID ----
  const again = await POST(post(validPayload("<msg-1@example.com>")) as never);
  assert.equal(again.status, 200, "replay → 200");
  assert.equal((await again.json()).deduped, true, "replay is deduped");
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM inbound_inquiries").get().c, 1, "still one row");

  // ---- oversized payload rejected (non-2xx) ----
  const huge = JSON.stringify({ ...validPayload("<big@x>"), raw: "x".repeat(2_000_001) });
  const oversize = await POST(post(huge) as never);
  assert.equal(oversize.status, 413, "oversize payload → 413 (non-2xx)");

  // ---- malformed JSON rejected ----
  assert.equal((await POST(post("{not json") as never)).status, 400, "bad JSON → 400");

  console.log("inbound inquiry endpoint auth/flag/dedupe tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
