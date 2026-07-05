import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-email-suppression-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.RESEND_API_KEY = "re_test_key";
process.env.UNSUBSCRIBE_SECRET = "unsub-secret-value";
process.env.UNSUBSCRIBE_BASE_URL = "https://studio.bythereeses.com";

const realFetch = globalThis.fetch;
let resendCalls = 0;
let lastBody: Record<string, unknown> | null = null;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (String(url).includes("api.resend.com")) {
    resendCalls += 1;
    lastBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return realFetch(url as string, init);
}) as unknown as typeof fetch;

async function main() {
  const { rawDb } = await import("@/db/client");
  const { sendSequenceEmail, isEmailSuppressed } = await import("./email");
  const { signUnsubscribeToken, verifyUnsubscribeToken } = await import("./unsubscribe-token");
  const database = rawDb();
  const now = "2026-07-06T15:00:00.000Z";

  database.prepare(
    "INSERT INTO email_suppressions (email, suppressed_at, source) VALUES ('blocked@example.com', ?, 'unsubscribe_link')",
  ).run(now);

  // --- suppressed address: zero Resend calls, no false success ---
  const suppressed = await sendSequenceEmail({ to: "Blocked@Example.com", subject: "Hi", text: "body" });
  assert.equal(suppressed.ok, false, "suppressed send refuses");
  if (!suppressed.ok) assert.equal(suppressed.reason, "suppressed");
  assert.equal(resendCalls, 0, "suppressed send makes ZERO Resend calls");
  assert.equal(await isEmailSuppressed("blocked@example.com"), true, "isEmailSuppressed true for suppressed");
  assert.equal(await isEmailSuppressed("fresh@example.com"), false, "isEmailSuppressed false for fresh");

  // --- non-suppressed send: List-Unsubscribe + List-Unsubscribe-Post headers ---
  const ok = await sendSequenceEmail({ to: "fresh@example.com", subject: "Reminder", text: "hello" });
  assert.equal(ok.ok, true, "non-suppressed send succeeds");
  assert.equal(resendCalls, 1, "exactly one Resend call for a live send");
  const headers = (lastBody?.headers ?? {}) as Record<string, string>;
  assert.ok(headers["List-Unsubscribe"]?.includes("/api/email/unsubscribe?t="), "List-Unsubscribe header present with token link");
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click", "RFC 8058 List-Unsubscribe-Post header present");
  assert.ok(String(lastBody?.text).includes("unsubscribe here:"), "visible unsubscribe footer appended to body");

  // --- classification: definitive pre-acceptance 4xx → rejected (provably not sent) ---
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("api.resend.com")) return new Response("bad", { status: 422 });
    return realFetch(url as string);
  }) as unknown as typeof fetch;
  const rejected = await sendSequenceEmail({ to: "fresh@example.com", subject: "x", text: "y" });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.reason, "rejected", "4xx classified as provably-not-sent");

  // --- classification: 5xx → unknown (ambiguous, terminal, never auto-retry) ---
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("api.resend.com")) return new Response("err", { status: 503 });
    return realFetch(url as string);
  }) as unknown as typeof fetch;
  const unknown = await sendSequenceEmail({ to: "fresh@example.com", subject: "x", text: "y" });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, "unknown", "5xx classified as ambiguous/unknown");

  // --- classification: thrown network → unknown ---
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("api.resend.com")) throw new Error("network down");
    return realFetch(url as string);
  }) as unknown as typeof fetch;
  const thrown = await sendSequenceEmail({ to: "fresh@example.com", subject: "x", text: "y" });
  assert.equal(thrown.ok, false);
  if (!thrown.ok) assert.equal(thrown.reason, "unknown", "thrown network classified as unknown (terminal)");

  // --- token: verifies constant-time, scoped to purpose, binds the email ---
  const token = signUnsubscribeToken("client-a@example.com", "sequences");
  assert.deepEqual(verifyUnsubscribeToken(token, "sequences"), { email: "client-a@example.com" }, "valid token verifies + returns email");
  assert.equal(verifyUnsubscribeToken(token, "marketing"), null, "token scoped to purpose=sequences cannot verify a different purpose");

  // A token for email A cannot be used to suppress email B: forge B's payload
  // while keeping A's signature — verify must reject.
  const parts = token.split(".");
  const forgedPayload = Buffer.from("client-b@example.com|sequences", "utf8").toString("base64url");
  const forged = `${forgedPayload}.${parts[1]}`;
  assert.equal(verifyUnsubscribeToken(forged, "sequences"), null, "token bound to A cannot suppress B (signature mismatch)");
  assert.equal(verifyUnsubscribeToken("garbage", "sequences"), null, "malformed token → null (fail closed)");
  assert.equal(verifyUnsubscribeToken("", "sequences"), null, "empty token → null");

  // Fail-closed when the secret is unset.
  const savedSecret = process.env.UNSUBSCRIBE_SECRET;
  delete process.env.UNSUBSCRIBE_SECRET;
  assert.equal(verifyUnsubscribeToken(token, "sequences"), null, "unset UNSUBSCRIBE_SECRET → verify fails closed");
  process.env.UNSUBSCRIBE_SECRET = savedSecret;

  globalThis.fetch = realFetch;
  console.log("email suppression + unsubscribe token tests passed");
}

main().catch((error) => {
  globalThis.fetch = realFetch;
  console.error(error);
  process.exit(1);
});
