import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-inbound-inquiry-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
delete process.env.RESEND_API_KEY;

async function main() {
  const { rawDb } = await import("@/db/client");
  const inbound = await import("./inbound-inquiry");
  const {
    ingestInboundInquiry,
    stripHtmlToText,
    extractPlainTextFromRaw,
    parseAuthResults,
    parseNameAndEmail,
    normalizeEmail,
    parseEventDate,
    parseVenue,
    stripReplySubjectForSend,
    sanitizeLine,
    draftFromInquiry,
    extractAttachmentMetadata,
    MAX_MESSAGE_ID_LENGTH,
  } = inbound;
  const database = rawDb();

  // ---- HTML → text sanitize (removes script/handlers/javascript:) ----
  const stripped = stripHtmlToText(
    `<div>Hello <b>there</b><script>alert('x')</script> <a href="javascript:evil()">link</a></div>`,
  );
  assert.ok(!/alert/.test(stripped), "script contents removed");
  assert.ok(!/javascript:/i.test(stripped), "javascript: scheme neutralized");
  assert.ok(!/</.test(stripped) && !/>/.test(stripped), "all tags removed");
  assert.ok(/Hello there/.test(stripped), "visible text preserved");
  assert.equal(stripHtmlToText("A &amp; B &lt;3 &#39;q&#39;"), "A & B <3 'q'", "entities decoded");

  // ---- MIME multipart plain-text extraction ----
  const multipart = [
    'Content-Type: multipart/alternative; boundary="B1"',
    "",
    "--B1",
    "Content-Type: text/plain",
    "",
    "Plain body wins here.",
    "--B1",
    "Content-Type: text/html",
    "",
    "<p>HTML body</p>",
    "--B1--",
  ].join("\n");
  assert.equal(extractPlainTextFromRaw(multipart), "Plain body wins here.", "prefers text/plain part");

  const htmlOnly = ["Content-Type: text/html", "", "<p>Only <b>HTML</b> here</p>"].join("\n");
  assert.equal(extractPlainTextFromRaw(htmlOnly), "Only HTML here", "falls back to stripped html");

  // ---- attachment metadata recorded (body dropped, but Tyler sees it existed) ----
  const withAttachment = [
    'Content-Type: multipart/mixed; boundary="MIX"',
    "",
    "--MIX",
    "Content-Type: text/plain",
    "",
    "See the attached contract.",
    "--MIX",
    "Content-Type: application/pdf; name=contract.pdf",
    'Content-Disposition: attachment; filename="contract.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "AAAAAAAAAAAAAAAA",
    "--MIX--",
  ].join("\n");
  const atts = extractAttachmentMetadata(withAttachment);
  assert.equal(atts.length, 1, "one attachment recorded");
  assert.equal(atts[0].filename, "contract.pdf");
  assert.equal(atts[0].mimeType, "application/pdf");
  assert.ok(atts[0].sizeBytes > 0, "approximate size recorded");
  // The text/plain body part is NOT treated as an attachment.
  assert.equal(extractPlainTextFromRaw(withAttachment), "See the attached contract.", "plain body still extracted");

  // ---- auth-results parse: display-only, spoof in body never overrides ----
  const verdicts = parseAuthResults("mx.cloudflare.net; spf=pass; dkim=fail reason=bad; dmarc=pass");
  assert.deepEqual(verdicts, { spf: "pass", dkim: "fail", dmarc: "pass" });
  // parseAuthResults reads ONLY the header string it is given; there is no code
  // path that scans the raw MIME for Authentication-Results.
  assert.deepEqual(parseAuthResults(null), { spf: null, dkim: null, dmarc: null });
  // Hardening: a non-Cloudflare authserv-id is NOT trusted → no verdicts, even
  // if it claims spf/dkim/dmarc all pass.
  assert.deepEqual(
    parseAuthResults("evil.example; spf=pass; dkim=pass; dmarc=pass"),
    { spf: null, dkim: null, dmarc: null },
    "non-cloudflare authserv-id yields no verdicts (fail-safe)",
  );
  // Hardening: a spoofed SECOND Authentication-Results header joined by
  // headers.get() (", <authserv>; ...") after Cloudflare's is truncated away, so
  // the attacker cannot inject a verdict Cloudflare omitted.
  const joined = parseAuthResults("mx.cloudflare.net; dmarc=none, evil.example; dmarc=pass; spf=pass");
  assert.equal(joined.dmarc, "none", "attacker's joined dmarc=pass is discarded");
  assert.equal(joined.spf, null, "attacker's joined spf=pass past the boundary is discarded");

  // ---- name/email parsing + single-address validation ----
  assert.deepEqual(parseNameAndEmail('"Jane Doe" <jane@example.com>', null), { name: "Jane Doe", email: "jane@example.com" });
  assert.deepEqual(parseNameAndEmail("plain@example.com", null), { name: null, email: "plain@example.com" });
  assert.equal(normalizeEmail("Jane <jane@x.com>, evil@y.com"), null, "comma-list is not a single address");
  assert.equal(normalizeEmail("MixedCase@Example.COM"), "mixedcase@example.com", "lowercased");

  // ---- heuristics ----
  assert.equal(parseEventDate("We are getting married on 2027-09-18 at sunset."), "2027-09-18");
  assert.equal(parseEventDate("The wedding is October 3rd, 2026 in the evening."), "October 3rd, 2026");
  assert.equal(parseVenue("Our venue is The Grand Hall downtown."), "The Grand Hall downtown");

  // ---- caps: over-length fields truncate, never crash ----
  assert.equal(sanitizeLine("x".repeat(5000), 200)?.length, 200, "sanitizeLine truncates to cap");
  assert.equal(sanitizeLine("a\r\nb\tc", 200), "a b c", "control chars collapsed to spaces");

  // ---- CRLF-strip the reply subject at send time (N6) ----
  const dirtySubject = "Re: Congrats\r\nBcc: leak@evil.example\nX-Injected: 1";
  const cleanSubject = stripReplySubjectForSend(dirtySubject);
  assert.ok(!/[\r\n]/.test(cleanSubject), "no newline survives in the reply subject");
  assert.equal(cleanSubject, "Re: Congrats Bcc: leak@evil.example X-Injected: 1");

  // ---- draft step is pure: same input → same output, stage always inquiry ----
  const draft = draftFromInquiry({
    id: "inq-1",
    subject: "Wedding photography",
    bodyText: "Hi, we love your work!",
    parsedName: "Jane Doe",
    parsedEmail: "jane@example.com",
    parsedEventDate: "2027-09-18",
    parsedVenue: "The Grand Hall",
  });
  assert.equal(draft.proposedProject.stage, "inquiry");
  assert.equal(draft.proposedProject.primaryClient?.email, "jane@example.com");
  assert.equal(draft.proposedProject.intakeSource?.sourceType, "inbound_inquiry");
  assert.ok(!/[\r\n]/.test(draft.draftReplySubject), "draft subject is single-line");

  // ---- dedupe: INSERT-OR-IGNORE, never UPDATE from inbound (B2) ----
  const first = await ingestInboundInquiry({
    envelopeFrom: "jane@example.com",
    headerFrom: '"Jane Doe" <jane@example.com>',
    envelopeTo: "inquiries@bythereeses.com",
    subject: "Original inquiry",
    messageId: "<dupe-key@example.com>",
    authResults: "mx; spf=pass; dkim=pass; dmarc=pass",
    raw: "Content-Type: text/plain\n\nOriginal body.",
  });
  assert.equal(first.deduped, false);
  assert.equal(first.status, "proposed");

  // Second delivery: SAME message_id but a swapped sender/recipient/body. An
  // upsert would redirect the about-to-be-approved reply — insert-or-ignore must
  // make it a no-op that returns the original id and never mutates the row.
  const second = await ingestInboundInquiry({
    envelopeFrom: "attacker@evil.example",
    headerFrom: '"Attacker" <attacker@evil.example>',
    envelopeTo: "inquiries@bythereeses.com",
    subject: "SWAPPED subject",
    messageId: "<dupe-key@example.com>",
    authResults: "mx; spf=fail; dkim=fail; dmarc=fail",
    raw: "Content-Type: text/plain\n\nSwapped body.",
  });
  assert.equal(second.deduped, true, "same message_id → deduped");
  assert.equal(second.id, first.id, "returns the existing row id");

  const rows = database.prepare("SELECT * FROM inbound_inquiries WHERE message_id = '<dupe-key@example.com>'").all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1, "exactly one row for the message_id");
  assert.equal(rows[0].parsed_email, "jane@example.com", "row NOT updated to the attacker's email");
  assert.equal(rows[0].subject, "Original inquiry", "row NOT updated to the swapped subject");
  const taskCount = (database.prepare("SELECT COUNT(*) AS c FROM agent_tasks WHERE source_id = ?").get(first.id) as { c: number }).c;
  assert.equal(taskCount, 1, "no second review task from the replayed delivery");

  // ---- message_id cap: an over-long attacker id is truncated, not error ----
  const capped = await ingestInboundInquiry({
    envelopeFrom: "long@example.com",
    headerFrom: "long@example.com",
    subject: "Long id",
    messageId: "<" + "a".repeat(4000) + "@x>",
    authResults: "mx; spf=pass",
    raw: "Content-Type: text/plain\n\nHello.",
  });
  const cappedRow = database.prepare("SELECT message_id FROM inbound_inquiries WHERE id = ?").get(capped.id) as { message_id: string };
  assert.ok(cappedRow.message_id.length <= MAX_MESSAGE_ID_LENGTH, "message_id capped to RFC line limit");

  // ---- null message_id is always a distinct (non-deduplicable) row ----
  const a = await ingestInboundInquiry({ envelopeFrom: "n1@x.com", headerFrom: "n1@x.com", subject: "no id 1", messageId: null, raw: "Content-Type: text/plain\n\nA" });
  const b = await ingestInboundInquiry({ envelopeFrom: "n2@x.com", headerFrom: "n2@x.com", subject: "no id 2", messageId: null, raw: "Content-Type: text/plain\n\nB" });
  assert.notEqual(a.id, b.id, "two null-message-id inquiries are distinct rows");
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, false);

  console.log("inbound inquiry parser/sanitizer/dedupe tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
