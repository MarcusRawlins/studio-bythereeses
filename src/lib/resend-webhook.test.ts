import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Phase 24 (CR-6) §10 — the Resend bounce/complaint webhook: SVIX signature verification
// (hand-rolled HMAC), suppression-write handling, the signature-reject carve-out (I5), the
// single-recipient guard (MEDIUM 4), the audit-only-on-insert guard (MEDIUM 5), the closed
// inquiry-reply bypass (§5), and the zero-canonical-writes guard (I3).

const here = path.dirname(fileURLToPath(import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-resend-webhook-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
delete process.env.RESEND_API_KEY;
delete process.env.ORIGIN_PROXY_SECRET;
delete process.env.RESEND_WEBHOOK_SECRET;

const SECRET = `whsec_${Buffer.from("resend-webhook-test-signing-key-0001").toString("base64")}`;

function signSvix(secret: string, svixId: string, svixTimestamp: string, rawBody: string): string {
  const withoutPrefix = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const keyBytes = Buffer.from(withoutPrefix, "base64");
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  return createHmac("sha256", keyBytes).update(signedContent).digest("base64");
}

function svixHeader(sig: string): string {
  return `v1,${sig}`;
}

const CANONICAL_TABLES = [
  "projects",
  "clients",
  "invoices",
  "invoice_payments",
  "payment_refunds",
  "refund_initiations",
  "sequence_sends",
] as const;

async function main() {
  const { rawDb } = await import("@/db/client");
  const {
    verifyResendWebhookPayload,
    ResendWebhookSignatureError,
    MAX_RESEND_WEBHOOK_BYTES,
  } = await import("@/lib/resend-webhook");
  const { readJobRun } = await import("@/lib/job-runs");
  const { POST: resendWebhookPOST } = await import("@/app/api/resend/webhook/route");
  const database = rawDb();

  const countSuppressions = () =>
    (database.prepare("SELECT COUNT(*) AS c FROM email_suppressions").get() as { c: number }).c;
  const countActivity = (action: string) =>
    (database.prepare("SELECT COUNT(*) AS c FROM activity_logs WHERE action = ?").get(action) as { c: number }).c;

  function buildRequest(body: string, headers: Record<string, string> = {}): Request {
    return new Request("https://studio.bythereeses.com/api/resend/webhook", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  async function postSignedEvent(payload: Record<string, unknown>, svixId = randomUUID()) {
    const rawBody = JSON.stringify(payload);
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const sig = signSvix(SECRET, svixId, svixTimestamp, rawBody);
    return resendWebhookPOST(
      buildRequest(rawBody, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixHeader(sig),
      }) as unknown as Parameters<typeof resendWebhookPOST>[0],
    );
  }

  // ==========================================================================================
  // Test 1 — signature verify, valid.
  // ==========================================================================================
  {
    const rawBody = JSON.stringify({ type: "email.bounced", data: { to: "verify1@example.com" } });
    const svixId = "msg-verify-1";
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const sig = signSvix(SECRET, svixId, svixTimestamp, rawBody);
    const event = verifyResendWebhookPayload({
      rawBody,
      svixId,
      svixTimestamp,
      svixSignature: svixHeader(sig),
      secret: SECRET,
    });
    assert.deepEqual(event, JSON.parse(rawBody), "a correctly signed payload verifies and returns parsed JSON");
  }

  // ==========================================================================================
  // Test 2 — signature verify, invalid.
  // ==========================================================================================
  {
    const rawBody = JSON.stringify({ type: "email.bounced", data: { to: "verify2@example.com" } });
    const svixId = "msg-verify-2";
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    assert.throws(
      () =>
        verifyResendWebhookPayload({
          rawBody,
          svixId,
          svixTimestamp,
          svixSignature: svixHeader(Buffer.from("totally-wrong-signature-bytes!!").toString("base64")),
          secret: SECRET,
        }),
      ResendWebhookSignatureError,
      "a wrong signature is rejected as ResendWebhookSignatureError",
    );
  }

  // ==========================================================================================
  // Test 3 — signature verify, expired.
  // ==========================================================================================
  {
    const rawBody = JSON.stringify({ type: "email.bounced", data: { to: "verify3@example.com" } });
    const svixId = "msg-verify-3";
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 400); // outside the 300s window
    const sig = signSvix(SECRET, svixId, staleTimestamp, rawBody);
    assert.throws(
      () =>
        verifyResendWebhookPayload({
          rawBody,
          svixId,
          svixTimestamp: staleTimestamp,
          svixSignature: svixHeader(sig),
          secret: SECRET,
        }),
      ResendWebhookSignatureError,
      "a timestamp outside the tolerance window is rejected",
    );
  }

  // ==========================================================================================
  // Test 15 — multi-signature header, valid signature not first.
  // ==========================================================================================
  {
    const rawBody = JSON.stringify({ type: "email.bounced", data: { to: "verify15@example.com" } });
    const svixId = "msg-verify-15";
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const validSig = signSvix(SECRET, svixId, svixTimestamp, rawBody);
    // A decodable-but-wrong candidate FIRST, the correct one SECOND — the loop must not
    // short-circuit on the first non-matching candidate.
    const wrongSig = signSvix(SECRET, "a-different-id", svixTimestamp, rawBody);
    const header = `${svixHeader(wrongSig)} ${svixHeader(validSig)}`;
    const event = verifyResendWebhookPayload({ rawBody, svixId, svixTimestamp, svixSignature: header, secret: SECRET });
    assert.deepEqual(event, JSON.parse(rawBody), "the valid signature verifies even when it is not the first candidate");
  }

  // ==========================================================================================
  // Test 16 — malformed/wrong-length signature + non-base64 secret: fail closed, never throw
  // an unhandled error (and never accidentally match).
  // ==========================================================================================
  {
    const rawBody = JSON.stringify({ type: "email.complained", data: { to: "verify16@example.com" } });
    const svixId = "msg-verify-16";
    const svixTimestamp = String(Math.floor(Date.now() / 1000));

    // Wrong-length decoded signature (shorter than a SHA-256 digest).
    assert.throws(
      () =>
        verifyResendWebhookPayload({
          rawBody,
          svixId,
          svixTimestamp,
          svixSignature: svixHeader(Buffer.from("short").toString("base64")),
          secret: SECRET,
        }),
      ResendWebhookSignatureError,
      "a wrong-length candidate signature is rejected by the length guard, not an unhandled throw",
    );

    // Garbage (non-base64) signature text.
    assert.throws(
      () =>
        verifyResendWebhookPayload({
          rawBody,
          svixId,
          svixTimestamp,
          svixSignature: "v1,!!!not-base64-at-all???",
          secret: SECRET,
        }),
      ResendWebhookSignatureError,
      "a garbage signature string is rejected cleanly",
    );

    // A non-base64 (garbage) RESEND_WEBHOOK_SECRET must fail CLOSED (reject), never throw
    // uncaught, even against an otherwise-correctly-signed payload.
    const sig = signSvix(SECRET, svixId, svixTimestamp, rawBody);
    assert.throws(
      () =>
        verifyResendWebhookPayload({
          rawBody,
          svixId,
          svixTimestamp,
          svixSignature: svixHeader(sig),
          secret: "whsec_!!!not-valid-base64-at-all!!!",
        }),
      ResendWebhookSignatureError,
      "a garbage secret fails closed (rejects) rather than throwing an unhandled error",
    );
  }

  // ==========================================================================================
  // Test 4 — unset secret → route 503, no processing, recorded ONLY under the rejected key.
  // ==========================================================================================
  {
    const before = countSuppressions();
    const rawBody = JSON.stringify({ type: "email.bounced", data: { to: "unset-secret@example.com" } });
    const res = await resendWebhookPOST(
      buildRequest(rawBody, {
        "svix-id": "id-unset",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,irrelevant",
      }) as unknown as Parameters<typeof resendWebhookPOST>[0],
    );
    assert.equal(res.status, 503, "unset RESEND_WEBHOOK_SECRET → 503");
    assert.equal(countSuppressions(), before, "unset secret writes no suppression row");
    const rejected = await readJobRun("resend-webhook-rejected");
    assert.ok(rejected && rejected.lastStatus === "error", "unset secret recorded under resend-webhook-rejected");
    const webhook = await readJobRun("resend-webhook");
    assert.equal(webhook, null, "unset secret never touches the resend-webhook heartbeat");
  }

  // Restore the secret for every route-level test below.
  process.env.RESEND_WEBHOOK_SECRET = SECRET;

  // ==========================================================================================
  // Test 12 — flag-off / secret-unset 503 (kept scoped, separately from test 4, per spec §10
  // note): the no-heartbeat assertion is deliberately isolated here.
  // ==========================================================================================
  {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const before = countSuppressions();
    const res = await resendWebhookPOST(
      buildRequest(JSON.stringify({ type: "email.complained", data: { to: "flag-off@example.com" } }), {
        "svix-id": "id-flag-off",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,irrelevant",
      }) as unknown as Parameters<typeof resendWebhookPOST>[0],
    );
    assert.equal(res.status, 503);
    assert.equal(countSuppressions(), before, "no suppression written while secret is unset");
    const webhook = await readJobRun("resend-webhook");
    assert.equal(webhook, null, "no resend-webhook heartbeat written while secret is unset");
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
  }

  // ==========================================================================================
  // Test 2b (route-level) — a bad signature is a 401 recorded ONLY under the rejected key.
  // ==========================================================================================
  {
    const res = await resendWebhookPOST(
      buildRequest(JSON.stringify({ type: "email.bounced", data: { to: "badsig@example.com" } }), {
        "svix-id": "id-badsig",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": svixHeader(Buffer.from("wrong-signature-bytes-here!!").toString("base64")),
      }) as unknown as Parameters<typeof resendWebhookPOST>[0],
    );
    assert.equal(res.status, 401);
    assert.equal(countSuppressions(), 0, "a bad-signature POST writes no suppression");
  }

  // ==========================================================================================
  // Test 19 — payload-size cap: an oversized raw body is rejected BEFORE signature verification.
  // ==========================================================================================
  {
    const oversized = "x".repeat(MAX_RESEND_WEBHOOK_BYTES + 1);
    const res = await resendWebhookPOST(
      buildRequest(oversized, {
        "svix-id": "id-oversized",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,irrelevant",
      }) as unknown as Parameters<typeof resendWebhookPOST>[0],
    );
    assert.equal(res.status, 413, "an oversized payload is rejected with 413, before verification");
    assert.equal(countSuppressions(), 0);
  }

  // ==========================================================================================
  // Test 5 — bounce (hard) → suppression row, source="bounce", lowercased.
  // ==========================================================================================
  {
    const res = await postSignedEvent({
      type: "email.bounced",
      data: { to: "Bounced@Example.com", bounce: { type: "Permanent", subType: "General" } },
    });
    assert.equal(res.status, 200);
    const row = database
      .prepare("SELECT email, source FROM email_suppressions WHERE email = ?")
      .get("bounced@example.com") as { email: string; source: string } | undefined;
    assert.ok(row, "a signed hard bounce inserts a suppression row");
    assert.equal(row!.source, "bounce");
  }

  // ==========================================================================================
  // Test 6 — complaint → suppression row, source="complaint".
  // ==========================================================================================
  {
    const res = await postSignedEvent({ type: "email.complained", data: { to: "complain@example.com" } });
    assert.equal(res.status, 200);
    const row = database
      .prepare("SELECT source FROM email_suppressions WHERE email = ?")
      .get("complain@example.com") as { source: string } | undefined;
    assert.ok(row);
    assert.equal(row!.source, "complaint");
  }

  // ==========================================================================================
  // Test 7 — idempotent replay: still exactly one row, earliest-wins, audit row gated on insert.
  // ==========================================================================================
  {
    const svixId = "replay-1";
    const email = "replay@example.com";
    const auditBefore = countActivity("email.suppressed");

    const res1 = await postSignedEvent({ type: "email.bounced", data: { to: email, bounce: { type: "Permanent" } } }, svixId);
    assert.equal(res1.status, 200);
    const auditAfterFirst = countActivity("email.suppressed");
    assert.equal(auditAfterFirst, auditBefore + 1, "the first accepted event writes exactly one audit row");

    const row1 = database
      .prepare("SELECT suppressed_at AS at, source FROM email_suppressions WHERE email = ?")
      .get(email) as { at: string; source: string };

    // Replay the identical event (same svix-id), and a differently-shaped event for the same
    // recipient (different svix-id) — both must be no-ops against the existing row.
    const res2 = await postSignedEvent({ type: "email.bounced", data: { to: email, bounce: { type: "Permanent" } } }, svixId);
    assert.equal(res2.status, 200);
    const res3 = await postSignedEvent({ type: "email.complained", data: { to: email } }, `${svixId}-again`);
    assert.equal(res3.status, 200);

    const count = (database.prepare("SELECT COUNT(*) AS c FROM email_suppressions WHERE email = ?").get(email) as { c: number }).c;
    assert.equal(count, 1, "a replayed event stays exactly one row");
    const row2 = database
      .prepare("SELECT suppressed_at AS at, source FROM email_suppressions WHERE email = ?")
      .get(email) as { at: string; source: string };
    assert.deepEqual(row2, row1, "earliest-wins: suppressed_at/source are unchanged by the replay");

    const auditAfterReplays = countActivity("email.suppressed");
    assert.equal(auditAfterReplays, auditAfterFirst, "no additional audit row is written on replay (gated on changes > 0)");

    // A bounce for an address already suppressed by an EARLIER writer (unsubscribe_link) leaves
    // that row's source untouched (earliest-writer-wins across sources, §4.5).
    const now = new Date().toISOString();
    database
      .prepare("INSERT INTO email_suppressions (email, suppressed_at, source) VALUES (?, ?, 'unsubscribe_link')")
      .run("already-unsub@example.com", now);
    await postSignedEvent({ type: "email.bounced", data: { to: "already-unsub@example.com", bounce: { type: "Permanent" } } });
    const row3 = database
      .prepare("SELECT source FROM email_suppressions WHERE email = ?")
      .get("already-unsub@example.com") as { source: string };
    assert.equal(row3.source, "unsubscribe_link", "a bounce for an already-unsubscribed address leaves the earlier source untouched");
  }

  // ==========================================================================================
  // Test 8 — soft-bounce policy: transient/undetermined/unclassified bounces suppress nothing.
  // ==========================================================================================
  {
    const before = countSuppressions();
    const r1 = await postSignedEvent({ type: "email.bounced", data: { to: "soft@example.com", bounce: { type: "Transient" } } });
    assert.equal(r1.status, 200);
    const r2 = await postSignedEvent({ type: "email.bounced", data: { to: "undetermined@example.com", bounce: { type: "Undetermined" } } });
    assert.equal(r2.status, 200);
    const r3 = await postSignedEvent({ type: "email.bounced", data: { to: "unclassified@example.com" } }); // no bounce sub-object at all
    assert.equal(r3.status, 200);
    assert.equal(countSuppressions(), before, "soft/undetermined/unclassified bounces write zero suppression rows");
  }

  // ==========================================================================================
  // Test 14 — multi-recipient over-suppression guard: ambiguous multi-address `data.to` → zero
  // rows; a single-address array still suppresses normally.
  // ==========================================================================================
  {
    const before = countSuppressions();
    await postSignedEvent({
      type: "email.bounced",
      data: { to: ["multi-bounce-1@example.com", "multi-bounce-2@example.com"], bounce: { type: "Permanent" } },
    });
    await postSignedEvent({ type: "email.complained", data: { to: ["multi-complaint-1@example.com", "multi-complaint-2@example.com"] } });
    assert.equal(countSuppressions(), before, "an ambiguous multi-recipient event writes zero suppression rows (log-and-skip)");

    await postSignedEvent({ type: "email.bounced", data: { to: ["single-in-array@example.com"], bounce: { type: "Permanent" } } });
    const row = database
      .prepare("SELECT source FROM email_suppressions WHERE email = ?")
      .get("single-in-array@example.com");
    assert.ok(row, "a single-address array (exactly one recipient) still suppresses");
  }

  // ==========================================================================================
  // Test 18 — data.to array + uppercase normalization together.
  // ==========================================================================================
  {
    await postSignedEvent({ type: "email.complained", data: { to: ["Jane@Example.COM"] } });
    const row = database.prepare("SELECT email FROM email_suppressions WHERE email = ?").get("jane@example.com");
    assert.ok(row, "a single-element array with mixed case normalizes to the lowercased/trimmed form");
  }

  // ==========================================================================================
  // Test 17 — unhandled event type → 200 ignored, records a resend-webhook SUCCESS (not a
  // rejection).
  // ==========================================================================================
  {
    const res = await postSignedEvent({ type: "email.delivered", data: { to: "delivered@example.com" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { received: boolean; result: unknown };
    assert.deepEqual(body.result, { ignored: true, type: "email.delivered" });
    const webhook = await readJobRun("resend-webhook");
    assert.equal(webhook?.lastStatus, "ok", "an unhandled event type records a resend-webhook SUCCESS, not a rejection");
  }

  // ==========================================================================================
  // Test 11 — zero canonical-table writes (guard, mirrors observability-guard.test.ts).
  // ==========================================================================================
  {
    const now = new Date().toISOString();
    database.exec(`
      INSERT INTO clients (id, first_name, last_name, email, sms_opt_in, created_at, updated_at)
        VALUES ('resend-guard-cli-1','Ada','Lovelace','ada-resend-guard@example.com',0,'${now}','${now}');
      INSERT INTO projects (id, name, type, stage, status, calendar_sync_status, created_at, updated_at)
        VALUES ('resend-guard-proj-1','Guard Project','wedding','inquiry','active','not_connected','${now}','${now}');
      INSERT INTO invoices (id, project_id, invoice_number, status, created_at, updated_at)
        VALUES ('resend-guard-inv-1','resend-guard-proj-1','INV-RESEND-GUARD-1','draft','${now}','${now}');
      INSERT INTO invoice_payments (id, invoice_id, label, created_at, updated_at)
        VALUES ('resend-guard-pay-1','resend-guard-inv-1','Balance','${now}','${now}');
      INSERT INTO payment_refunds (id, stripe_refund_id, invoice_payment_id, amount_cents, currency, status, created_at, updated_at)
        VALUES ('resend-guard-pref-1','re_resend_guard','resend-guard-pay-1',5000,'usd','succeeded','${now}','${now}');
      INSERT INTO refund_initiations (id, invoice_payment_id, amount_cents, currency, status, stripe_refund_id, created_at, updated_at)
        VALUES ('resend-guard-ri-1','resend-guard-pay-1',5000,'usd','succeeded','re_resend_guard','${now}','${now}');
      INSERT INTO sequence_sends (id, project_id, sequence_key, step_key, dedupe_key, channel, mode, status, attempts, fired_at)
        VALUES ('resend-guard-seq-1','resend-guard-proj-1','welcome','step1','dedupe-resend-guard-1','email','auto_send','sent',0,'${now}');
    `);
    const snapshot: Record<string, unknown[]> = {};
    for (const table of CANONICAL_TABLES) {
      snapshot[table] = database.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    }

    await postSignedEvent({ type: "email.bounced", data: { to: "guard-bounce@example.com", bounce: { type: "Permanent" } } });
    await postSignedEvent({ type: "email.complained", data: { to: "guard-complaint@example.com" } });
    // Replay one of them.
    await postSignedEvent(
      { type: "email.bounced", data: { to: "guard-bounce@example.com", bounce: { type: "Permanent" } } },
      "guard-replay-id",
    );
    await postSignedEvent(
      { type: "email.bounced", data: { to: "guard-bounce@example.com", bounce: { type: "Permanent" } } },
      "guard-replay-id",
    );

    for (const table of CANONICAL_TABLES) {
      const after = database.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
      assert.deepEqual(after, snapshot[table], `Resend webhook handling must not mutate canonical table ${table}`);
    }
  }

  // ==========================================================================================
  // Tests 9 & 10 — the inquiry-reply bypass is closed: suppression-checked + on canonical
  // transport (@/lib/email), with the drifted local sender gone from inbound-inquiry.ts.
  // ==========================================================================================
  const realFetch = globalThis.fetch;
  const resendCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      let body: Record<string, unknown> = {};
      try {
        body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      resendCalls.push({ url: String(url), body });
      return new Response(JSON.stringify({ id: "resend-msg-inquiry-1" }), { status: 200 });
    }
    return realFetch(url as string, init);
  }) as unknown as typeof fetch;

  try {
    const { sendInquiryReplyEmail } = await import("@/lib/email");
    process.env.RESEND_API_KEY = "re_test_key";

    // Test 9a: a suppressed recipient makes ZERO Resend fetch calls.
    const now = new Date().toISOString();
    database
      .prepare("INSERT INTO email_suppressions (email, suppressed_at, source) VALUES (?, ?, 'bounce')")
      .run("suppressed-inquiry@example.com", now);
    const r1 = await sendInquiryReplyEmail({
      to: "Suppressed-Inquiry@Example.com",
      subject: "Re: hello",
      text: "body",
    });
    assert.deepEqual(r1, { delivered: false, suppressed: true }, "a suppressed recipient refuses with no false success");
    assert.equal(resendCalls.length, 0, "a suppressed recipient makes zero Resend fetch calls");

    // Test 9b: a non-suppressed recipient sends via resendRequest with the byte-identical
    // envelope the drifted local sender used to send (no reply_to, no headers).
    const r2 = await sendInquiryReplyEmail({
      to: "fresh-inquiry@example.com",
      subject: "Re: hello",
      text: "Some body text.",
    });
    assert.deepEqual(r2, { delivered: true, suppressed: false });
    assert.equal(resendCalls.length, 1, "a non-suppressed recipient sends exactly one Resend call");
    const sentBody = resendCalls[0].body;
    assert.equal(sentBody.to, "fresh-inquiry@example.com");
    assert.equal(sentBody.subject, "Re: hello");
    assert.equal(sentBody.text, "Some body text.");
    assert.equal("reply_to" in sentBody, false, "no reply_to on the inquiry-reply envelope");
    assert.equal("headers" in sentBody, false, "no headers on the inquiry-reply envelope");

    delete process.env.RESEND_API_KEY;
  } finally {
    globalThis.fetch = realFetch;
  }

  // Test 10: grep-guard — the drifted local sender (raw `api.resend.com` fetch) is gone from
  // inbound-inquiry.ts, and it now imports the canonical sender from @/lib/email.
  {
    const source = fs.readFileSync(path.join(here, "inbound-inquiry.ts"), "utf8");
    assert.ok(!source.includes("api.resend.com"), "inbound-inquiry.ts no longer reimplements the raw Resend fetch");
    assert.ok(
      /from\s+"@\/lib\/email"/.test(source) && source.includes("sendInquiryReplyEmail"),
      "inbound-inquiry.ts imports the canonical sendInquiryReplyEmail from @/lib/email",
    );
  }

  console.log("resend webhook tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
