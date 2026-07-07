// Phase 24 (CR-6) — Resend bounce/complaint webhook → email suppression.
//
// Closes two gaps from the email-deliverability audit (docs/email-deliverability.md §2, fixes
// #2/#3): nothing ever fed Resend bounce/complaint events back into `email_suppressions`, even
// though the schema documents a `"bounce"` source nobody wrote.
//
// Hard-scope guarantees (spec docs/specs/phase-24-resend-bounce-webhook.md §2):
//   - I1/I4/I5: signature verified BEFORE any processing; every write is
//     `INSERT ... ON CONFLICT DO NOTHING` (append-only, earliest-writer-wins, idempotent replay);
//     a pre-verification reject is classified separately from a post-verify processing failure
//     (the route, not this module, records the job_runs heartbeat under the right key).
//   - I3: this module's ONLY DB writes are the `email_suppressions` insert and one `logActivity`
//     audit row (gated on the insert actually inserting, §4.6) — never an UPDATE/DELETE, never a
//     canonical table.
//   - I6: only a HARD/permanent bounce, or any complaint, ever suppresses. Soft/transient/
//     undetermined bounces are a deliberate no-op (§4.3 — suppression is permanent and
//     unreversible-by-UI, so an ambiguous signal fails toward NOT suppressing).
//
// SVIX verification is hand-rolled (no `svix` dependency), mirroring how this repo hand-rolls
// Stripe's HMAC verify in `verifyStripeWebhookPayload` (stripe-checkout.ts) rather than pulling a
// dependency. The one real difference: SVIX's secret (`whsec_<base64>`) is base64-encoded key
// material; Stripe's is used as raw UTF-8 bytes.

import { db } from "@/db/client";
import { emailSuppressions } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { createHmac, timingSafeEqual } from "node:crypto";

// Mirrors MAX_INBOUND_JSON_BYTES (inbound-inquiry.ts) — this endpoint is reachable through the
// proxy before signature verification, so the raw body must be capped defensively.
export const MAX_RESEND_WEBHOOK_BYTES = 2_000_000; // ~2 MB

const SVIX_SECRET_PREFIX = "whsec_";
const DEFAULT_TOLERANCE_SECONDS = 300;

// Phase 21 signature-reject carve-out (mirrors StripeWebhookSignatureError): a typed error for
// PRE-verification rejects (missing/invalid/expired signature) so the route can classify it to
// the non-alerting `resend-webhook-rejected` key — never `resend-webhook` (I5).
export class ResendWebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResendWebhookSignatureError";
  }
}

export function resendWebhookSecret(): string {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("Resend webhook is not configured. Add RESEND_WEBHOOK_SECRET before accepting webhook events.");
  }
  return secret;
}

// SVIX's signing secret is `whsec_<base64>` — strip the prefix (if present) and base64-decode the
// remainder to raw key bytes. `Buffer.from(x, "base64")` never throws on malformed input (Node's
// base64 decoder is lenient) — a garbage secret simply decodes to different key bytes, which then
// fails the HMAC comparison below. That is the intended fail-CLOSED behavior (test 16): a bad
// secret never throws uncaught, it just never matches.
function decodeSvixSecretToKeyBytes(secret: string): Buffer {
  const withoutPrefix = secret.startsWith(SVIX_SECRET_PREFIX) ? secret.slice(SVIX_SECRET_PREFIX.length) : secret;
  return Buffer.from(withoutPrefix, "base64");
}

// Constant-time compare of two base64-encoded signatures (decoded to bytes first). A length
// mismatch short-circuits to `false` BEFORE calling `timingSafeEqual` — that function throws on
// unequal-length buffers, and a wrong-length/garbage candidate signature must be REJECTED, never
// throw uncaught (test 16).
function secureCompareBase64(actualBase64: string, expectedBytes: Buffer): boolean {
  const actualBytes = Buffer.from(actualBase64, "base64");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function verifyResendWebhookPayload(input: {
  rawBody: string;
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
  secret?: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): Record<string, unknown> {
  const {
    rawBody,
    svixId,
    svixTimestamp,
    svixSignature,
    secret = resendWebhookSecret(),
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    nowSeconds = Math.floor(Date.now() / 1000),
  } = input;

  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new ResendWebhookSignatureError("Missing Resend webhook signature headers.");
  }

  const timestamp = Number(svixTimestamp);
  if (!Number.isFinite(timestamp)) {
    throw new ResendWebhookSignatureError("Invalid Resend webhook signature timestamp.");
  }
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new ResendWebhookSignatureError("Resend webhook signature timestamp is outside the tolerance window.");
  }

  const keyBytes = decodeSvixSecretToKeyBytes(secret);
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expectedBytes = Buffer.from(createHmac("sha256", keyBytes).update(signedContent).digest("base64"), "base64");

  // svix-signature is space-delimited `v1,<base64sig> v1,<base64sig> ...`. Accept if ANY
  // candidate matches (test 15: the valid one need not be first — never short-circuit early on a
  // non-matching candidate other than by trying the next one).
  const candidates = svixSignature.split(" ").filter(Boolean);
  const matched = candidates.some((candidate) => {
    const commaIndex = candidate.indexOf(",");
    if (commaIndex === -1) return false;
    const version = candidate.slice(0, commaIndex);
    const signature = candidate.slice(commaIndex + 1);
    if (version !== "v1" || !signature) return false;
    return secureCompareBase64(signature, expectedBytes);
  });

  if (!matched) {
    throw new ResendWebhookSignatureError("Resend webhook signature verification failed.");
  }

  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new ResendWebhookSignatureError("Resend webhook payload is not valid JSON.");
  }
}

// ---------------------------------------------------------------------------
// Event handling (§4). Defensive parsing throughout: an unknown/malformed shape is ignored, never
// thrown — a mis-parse can only ever result in "no suppression happened," never a false write.
// ---------------------------------------------------------------------------

type SuppressionSource = "bounce" | "complaint";

export type ResendWebhookResult =
  | { ignored: true; type: string }
  | { suppressed: true; email: string; source: SuppressionSource }
  | { suppressed: false; reason: "soft_bounce" | "recipient_not_resolved" };

function eventType(event: Record<string, unknown>): string {
  return typeof event.type === "string" ? event.type : "";
}

function eventData(event: Record<string, unknown>): Record<string, unknown> {
  const data = event.data;
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

// Rev 2 (MEDIUM 4) — resolve exactly one recipient, or null (log-and-skip). `data.to` may be a
// single string or an array (Resend supports multi-recipient sends); a bounce/complaint event
// reports the delivery outcome, not necessarily which of several `to` addresses actually
// bounced/complained, so suppressing every address in a multi-recipient `to` would suppress
// innocent co-recipients. Normalized the same way `isEmailSuppressed` normalizes (email.ts:122).
function resolveSingleRecipient(data: Record<string, unknown>): string | null {
  const to = data.to;
  const raw: string[] = [];
  if (typeof to === "string") {
    raw.push(to);
  } else if (Array.isArray(to)) {
    for (const item of to) {
      if (typeof item === "string") raw.push(item);
    }
  }
  const normalized = Array.from(
    new Set(raw.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0)),
  );
  return normalized.length === 1 ? normalized[0] : null;
}

// Classify a bounce sub-type (Resend surfaces SES-style classification, typically
// `data.bounce.type`). Only an explicit "permanent" (case-insensitive) is a HARD bounce.
// Transient/undetermined/missing → soft (§4.3 — fail toward NOT suppressing an ambiguous signal,
// because suppression here is permanent and there is no admin un-suppress UI).
function bounceIsHard(data: Record<string, unknown>): boolean {
  const bounce = data.bounce;
  if (!bounce || typeof bounce !== "object") return false;
  const type = (bounce as Record<string, unknown>).type;
  return typeof type === "string" && type.trim().toLowerCase() === "permanent";
}

function bounceNote(data: Record<string, unknown>): string | null {
  const bounce = data.bounce;
  if (!bounce || typeof bounce !== "object") return null;
  const record = bounce as Record<string, unknown>;
  const parts = [record.type, record.subType].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return parts.length ? parts.join("/") : null;
}

function complaintNote(data: Record<string, unknown>): string | null {
  const complaint = data.complaint;
  if (!complaint || typeof complaint !== "object") return null;
  const feedbackType = (complaint as Record<string, unknown>).feedbackType;
  return typeof feedbackType === "string" && feedbackType ? feedbackType : null;
}

// The ONLY DB write besides the audit log (I3). INSERT ... ON CONFLICT DO NOTHING keyed on the
// PRIMARY KEY email — idempotent, earliest-writer-wins (I4). `.returning()` (not a driver-specific
// `.changes`/`.meta.changes` shape) is the portable way to detect "did this call actually insert a
// row" across both the D1 and better-sqlite3 drizzle drivers (mirrors the CAS idiom already used
// in sequences.ts's `retryFailedSends`).
async function insertSuppression(email: string, source: SuppressionSource, note: string | null): Promise<boolean> {
  const now = new Date().toISOString();
  const inserted = await db
    .insert(emailSuppressions)
    .values({ email, suppressedAt: now, source, note })
    .onConflictDoNothing()
    .returning({ email: emailSuppressions.email });
  return inserted.length > 0;
}

// Rev 2 (MEDIUM 5) — write the audit row ONLY when the insert actually inserted a NEW row, so a
// replayed event (or a bounce for an address some other writer already suppressed) does not spam
// the activity log with entries that record nothing new (§4.6).
async function auditSuppression(email: string, source: SuppressionSource) {
  await logActivity({
    action: "email.suppressed",
    actorType: "system",
    actorName: "Resend webhook",
    metadata: { email, source },
  });
}

async function auditAmbiguousRecipient(type: string) {
  await logActivity({
    action: "email.suppression_skipped_ambiguous_recipient",
    actorType: "system",
    actorName: "Resend webhook",
    metadata: { type, note: "Multi-recipient event with no single identifiable recipient — no suppression written." },
  });
}

export async function handleResendWebhookEvent(event: Record<string, unknown>): Promise<ResendWebhookResult> {
  const type = eventType(event);
  const data = eventData(event);

  if (type === "email.complained") {
    const recipient = resolveSingleRecipient(data);
    if (!recipient) {
      await auditAmbiguousRecipient(type);
      return { suppressed: false, reason: "recipient_not_resolved" };
    }
    const inserted = await insertSuppression(recipient, "complaint", complaintNote(data));
    if (inserted) await auditSuppression(recipient, "complaint");
    return { suppressed: true, email: recipient, source: "complaint" };
  }

  if (type === "email.bounced") {
    const recipient = resolveSingleRecipient(data);
    if (!recipient) {
      await auditAmbiguousRecipient(type);
      return { suppressed: false, reason: "recipient_not_resolved" };
    }
    if (!bounceIsHard(data)) {
      return { suppressed: false, reason: "soft_bounce" };
    }
    const inserted = await insertSuppression(recipient, "bounce", bounceNote(data));
    if (inserted) await auditSuppression(recipient, "bounce");
    return { suppressed: true, email: recipient, source: "bounce" };
  }

  // Rev 2 (§4.5) — Cross-source keying note: `email` is the single PK across ALL sources
  // (unsubscribe_link / admin / bounce / complaint), so a bounce/complaint for an
  // already-suppressed address is an idempotent no-op that leaves the original row's
  // suppressedAt/source/note untouched (earliest-writer-wins). This handler intentionally never
  // UPDATEs the sequence-draft-voiding the unsubscribe route performs (I3) — `isEmailSuppressed`
  // re-checks at send time (email.ts:138), so a stale queued draft is still caught, just later.

  // Any other event type (email.sent, email.delivered, email.opened, ...) is a deliberate no-op —
  // only email.bounced and email.complained are subscribed in the dashboard, but this is
  // defensive against Resend sending anything else through.
  return { ignored: true, type };
}
