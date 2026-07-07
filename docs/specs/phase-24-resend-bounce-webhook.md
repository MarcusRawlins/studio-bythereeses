# Phase 24 — Resend bounce/complaint webhook → email suppression (CR-6)

Status: spec (build-ready). No code in this document.
Scope owner: autonomous build loop. Enablement: **Tyler** (subscribe the webhook in the Resend
dashboard + set `RESEND_WEBHOOK_SECRET`).

Closes the two email-deliverability gaps the audit (`docs/email-deliverability.md` §2, fixes #2 and
#3) flagged as the only *code* gaps in an otherwise-sound sending stack:

1. Nothing feeds Resend bounce/complaint events back into `email_suppressions`, even though the
   schema documents a `"bounce"` source nobody ever writes (`src/db/schema.ts:799`). A
   hard-bouncing or complaining address stays in the sequence rotation forever.
2. One sender — `sendInquiryReplyEmail` (`src/lib/inbound-inquiry.ts:750-764`) — reimplements the
   raw Resend `fetch` and **never** checks suppression, so an unsubscribed/complained address can
   still receive an inquiry reply.

All line numbers are current as of this commit; re-verify if the cited files change shape.

---

## 0. Why this exists (the motivating gap)

`email_suppressions` is consulted fail-closed before every sequence send
(`isEmailSuppressed`, `src/lib/email.ts:121-126`, called at `:138`) and before every approved
project-thread send (`src/lib/project-communications.ts:617`). But the table only ever *grows* from
**one** writer: the one-click unsubscribe route
(`src/app/api/email/unsubscribe/route.ts:95-98`, `source: "unsubscribe_link"`). Resend already knows
which addresses hard-bounce or file spam complaints — it emits `email.bounced` and
`email.complained` webhook events — but the CRM has no endpoint to receive them. The result: a dead
or hostile address is re-mailed on every sequence run (`src/lib/sequences.ts` fires per active
project), which is exactly the repeat-send-to-dead-address behavior that erodes sender reputation as
volume grows.

This phase adds the receiving endpoint and closes the one sender that bypasses the suppression gate.

**Hard scope guarantees (non-negotiable):**

1. **Adds no new attack surface and moves no money.** The endpoint's *only* write authority is an
   append to `email_suppressions` (+ the non-canonical `job_runs` heartbeat + an activity-log audit
   row). It never updates or deletes any row, never touches a canonical business table, never sends
   anything.
2. **Dark until configured.** With `RESEND_WEBHOOK_SECRET` unset the route is a `503` no-op (§7).
   No canonical behavior changes until Tyler subscribes the webhook and sets the secret.
3. **Suppression stays append-only + fail-safe.** The only effect any accepted event can have is to
   *add* a suppression row (never remove one) — same invariant the unsubscribe route and
   `sms_suppressions` already hold. A guard test asserts zero canonical writes (§10, mirrors the
   `observability-guard` / `email-send-guard` zero-write guards).
4. **Signature-first, like every other webhook here.** No untrusted field is read until the SVIX
   signature verifies — mirroring Stripe (`verifyStripeWebhookPayload` before any processing) and
   Twilio (`403` before the recorded region).

---

## 1. What ships

| # | Change | File(s) | Kind |
|---|---|---|---|
| 1 | New `POST /api/resend/webhook` route | `src/app/api/resend/webhook/route.ts` (new) | additive |
| 2 | SVIX signature verify + event handler (hand-rolled HMAC, **no `svix` dep**) | `src/lib/resend-webhook.ts` (new) | additive |
| 3 | Public-route classification (origin-guard + pages-proxy + rate kind) | `src/lib/origin-guard.ts`, `pages-proxy/_worker.js` | additive |
| 4 | Heartbeat wiring (`resend-webhook` + non-alerting `resend-webhook-rejected`) | `src/lib/job-runs.ts`, `src/lib/system-health.ts` | additive |
| 5 | Close the bypass: `sendInquiryReplyEmail` → canonical transport + suppression gate | `src/lib/email.ts`, `src/lib/inbound-inquiry.ts` | refactor (behavior-preserving + one added gate) |
| 6 | Admin visibility: an INFO "Email suppressions" signal on `/system-status` | `src/lib/system-health.ts` (read only) | additive |
| 7 | Schema comment: add `"complaint"` to the `source` union comment (doc-only, **no migration**) | `src/db/schema.ts:799` | comment |

**No migration.** `email_suppressions` already has every column needed (§9).

---

## 2. Invariants

- **I1 — Verify before act.** The route reads `await request.text()` (raw body) and verifies the
  SVIX signature **before** parsing JSON or writing anything. A verification throw returns before any
  DB effect. (Mirrors `stripe/webhook/route.ts:20-38`; Twilio's `403` gates at
  `twilio/inbound/route.ts:40,57` return before its recorded region.)
- **I2 — Fail-closed on unset secret.** `RESEND_WEBHOOK_SECRET` unset → `503`, no processing, no
  false success. (Mirrors Twilio's unset-`TWILIO_AUTH_TOKEN` → `503`, `twilio/inbound/route.ts:31`.)
- **I3 — Append-only, non-canonical.** The handler's only DB write is
  `INSERT INTO email_suppressions ... ON CONFLICT DO NOTHING`. Plus the non-canonical `job_runs`
  heartbeat and one `logActivity` audit row (both already established non-canonical surfaces). It
  performs **no** `UPDATE`/`DELETE` anywhere and touches **no** canonical table.
- **I4 — Idempotent.** `email` is the PRIMARY KEY; every write is `ON CONFLICT DO NOTHING`, so a
  replayed bounce/complaint (or a bounce for an already-unsubscribed address) is a no-op. **Earliest
  writer wins** — the first row's `suppressed_at`/`source`/`note` persist; a later event never
  overwrites them. This matches the unsubscribe writer's `.onConflictDoNothing()`
  (`unsubscribe/route.ts:98`) and the `sms_suppressions` "earliest STOP wins" rule
  (`twilio-webhook.ts:177-182`).
- **I5 — Signature-reject never poisons the alerting counter.** A pre-verification reject
  (bad/missing signature, stale timestamp, or unset secret) is recorded only under the separate,
  **non-alerting** `resend-webhook-rejected` key — never `resend-webhook`. Only a throw from
  processing a *successfully verified* event records a `resend-webhook` failure. (Mirrors the Stripe
  carve-out, `stripe/webhook/route.ts:13-38,55-59`.)
- **I6 — Only hard bounces + complaints suppress.** `email.complained` always suppresses.
  `email.bounced` suppresses only a **hard/permanent** bounce. Soft/transient (and
  undetermined/unknown) bounces do **not** suppress in v1 (§4.3).
- **I7 — Survives rollback.** `email_suppressions` is never dropped on a feature rollback (schema
  note `src/db/schema.ts:787-788`, migration note `0088_automated_sequences.sql:13-14`). Bounce and
  complaint rows inherit that guarantee.
- **I8 — Suppression gate on the inquiry-reply path.** After §5, `sendInquiryReplyEmail` consults
  `isEmailSuppressed` before any Resend call and refuses (no false success) on a hit — closing the
  one sender that bypassed the gate.

---

## 3. The webhook route + signature verification

### 3.1 SVIX verification, hand-rolled (no `svix` dependency)

Resend signs webhooks with SVIX. The request carries three headers:

- `svix-id` — the message id (also the natural idempotency key).
- `svix-timestamp` — unix seconds.
- `svix-signature` — one or more space-delimited signatures, each formatted `v1,<base64sig>`.

The signing secret is `whsec_<base64>`. Verification (mirroring how the repo hand-rolls Stripe in
`verifyStripeWebhookPayload`, `stripe-checkout.ts:162-188`, rather than pulling a dependency):

1. Take the secret; strip the `whsec_` prefix if present; **base64-decode the remainder to raw key
   bytes**. (Stripe uses its secret as raw UTF-8 key bytes; SVIX's is base64 — that is the one real
   difference from the Stripe helper.)
2. Reject if `|nowSeconds - svixTimestamp| > toleranceSeconds` (default **300s**, same window as
   Stripe's `toleranceSeconds = 300`, `stripe-checkout.ts:167,176-178`).
3. Build the signed content string: `` `${svixId}.${svixTimestamp}.${rawBody}` `` (SVIX's scheme;
   Stripe's is `` `${timestamp}.${rawBody}` `` — same shape, plus the id).
4. `expected = createHmac("sha256", keyBytes).update(signedContent).digest("base64")`.
5. Split `svix-signature` on space; for each token take the part after `v1,`; constant-time-compare
   its base64-decoded bytes against `expected`'s decoded bytes. Accept if **any** matches. (Mirrors
   Stripe's multi-signature loop `signatures.some(...)`, `stripe-checkout.ts:183`, and its
   length-checked `timingSafeEqual` compare `secureCompareHex`, `:156-160` — the SVIX variant is
   `secureCompareBase64`.)

Any failure (missing headers, unparseable timestamp, out-of-tolerance, no matching signature) throws
a typed `ResendWebhookSignatureError` (a new class mirroring `StripeWebhookSignatureError`,
`stripe-checkout.ts:132-137`) so the route can classify it to the non-alerting key.

`src/lib/resend-webhook.ts` exports (all pure/Node-runtime; uses `node:crypto`, like
`stripe-checkout.ts:9` and `twilio-webhook.ts:6`):

```
export class ResendWebhookSignatureError extends Error {}

export function resendWebhookSecret(): string   // throws if RESEND_WEBHOOK_SECRET unset/blank

export function verifyResendWebhookPayload(input: {
  rawBody: string;
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
  secret?: string;              // defaults to resendWebhookSecret()
  toleranceSeconds?: number;    // default 300
  nowSeconds?: number;          // default Math.floor(Date.now()/1000)
}): Record<string, unknown>     // returns JSON.parse(rawBody); throws ResendWebhookSignatureError

export async function handleResendWebhookEvent(event: Record<string, unknown>): Promise<ResendWebhookResult>
```

### 3.2 Route control flow (`src/app/api/resend/webhook/route.ts`)

`export const runtime = "nodejs";` (node:crypto) and `export const dynamic = "force-dynamic";` —
same pins as the unsubscribe and Twilio routes.

```
POST(request):
  rawBody = await request.text()
  svixId / svixTimestamp / svixSignature = request.headers.get(...)

  # Belt-and-suspenders: reject a direct workers.dev POST that bypassed the proxy limiter
  # (no-op when ORIGIN_PROXY_SECRET unset). Mirrors twilio/inbound/route.ts:23.
  blocked = guardDirectWorkerApiRequest(request); if (blocked) return blocked

  # (A) Fail-closed on unset secret → 503, recorded under the NON-alerting rejected key.
  #     Not attacker-triggerable-into-alert; surfaced by config-preflight instead.
  if (!process.env.RESEND_WEBHOOK_SECRET?.trim()):
    await recordJobRun("resend-webhook-rejected", false, "RESEND_WEBHOOK_SECRET unset")
    return 503 { error: "Resend webhook is not configured." }

  # (B) Verify BEFORE any processing (I1). A pre-verify throw → 401, recorded ONLY under the
  #     non-alerting rejected key (I5) so a scanner spamming bad signatures cannot grief the
  #     resend-webhook counter. Mirrors stripe/webhook/route.ts:20-38.
  try:
    event = verifyResendWebhookPayload({ rawBody, svixId, svixTimestamp, svixSignature })
  catch (err):
    await recordJobRun("resend-webhook-rejected", false, err.message)
    return 401 { error: "Invalid signature." }

  # (C) Signature verified → act. A throw here is a REAL processing failure and DOES count toward
  #     resend-webhook consecutive_failures. Return non-2xx so Resend/SVIX retries (no silent loss).
  try:
    result = await handleResendWebhookEvent(event)
    await recordJobRun("resend-webhook", true)
    return 200 { received: true, result }
  catch (err):
    await recordJobRun("resend-webhook", false, err.message)
    return 500 { error: "Resend webhook processing failed." }   # 5xx → SVIX retries
```

Status codes are exactly as required: `503` unset secret, `401` bad signature, `200` on accept
(including ignored/soft events, so SVIX does not retry a deliberate no-op), `500` only on a genuine
post-verify processing failure (so SVIX *does* retry a transient DB write failure).

### 3.3 Public-route classification (mirror Stripe + Twilio)

Recommended endpoint URL: **`https://studio.bythereeses.com/api/resend/webhook`** — the public
studio host, through the Pages proxy (so it gets the proxy rate limiter + security headers), exactly
like Twilio and the unsubscribe route. Two classification edits, plus one defense-in-depth edit:

1. **pages-proxy `isStudioPublicPath`** (load-bearing): add
   `pathname === "/api/resend/webhook"` to the allowlist in
   `pages-proxy/_worker.js:217-268`, alongside the Twilio/unsubscribe entries. Without this, an
   unauthenticated POST to the studio host is `303`'d to `/admin/login` (a `200` login **page**),
   SVIX reads `2xx` as success, and every bounce/complaint is silently dropped — the identical
   failure mode the Twilio comment at `_worker.js:243-249` warns about. The SVIX signature is the
   credential; the route verifies it constant-time.
2. **pages-proxy `rateLimitKind`** — add a **dedicated generous kind `resendWebhook`**
   (`RATE_LIMITS`, `_worker.js:21-52`; matched POST-only in `rateLimitKind`, `_worker.js:290-340`,
   **before** the `publicMutation` branch). Suggested cap `{ max: 600, windowSeconds: 60 }`, cloned
   from `twilioWebhook`/`inboundProjectEmail`. Justification is the twilioWebhook rationale verbatim
   (`_worker.js:35-42`): bounce/complaint events arrive in bursts (one send that hits many dead
   addresses fans out) from Resend/SVIX's concentrated egress IPs (one bucket key), so the tight
   `publicMutation` cap (20/300s) would `429` a legitimate burst and drop compliance-relevant
   complaint events. The signature at the origin is the real trust boundary; this cap is only an
   abuse ceiling → err generous.
3. **origin-guard `PUBLIC_API_PREFIXES`** (defense-in-depth, mirrors Stripe): add
   `"/api/resend/webhook"` to `src/lib/origin-guard.ts:11-38`. Stripe is classified here because it
   posts directly to the workers.dev origin. Resend is recommended to go through the proxy, but this
   entry keeps the route reachable if Resend is ever pointed at the origin, and the route
   self-authenticates via the SVIX signature regardless — same posture as Stripe.

---

## 4. Event handling

Resend delivers a top-level `{ type, created_at, data: {...} }` envelope. **Confirm the exact
`data` field names against the live Resend webhook payload docs at build time** and parse
defensively (unknown shape → ignore, never throw, never mis-suppress). The recipient is taken from
`data.to` (string or array), normalized with the same `email.trim().toLowerCase()` rule
`isEmailSuppressed` uses (`email.ts:122`).

### 4.1 `email.complained` → always suppress

A spam complaint is an unambiguous, permanent opt-out signal. For each recipient:

```
INSERT INTO email_suppressions (email, suppressed_at, source, note)
VALUES (<normalized>, <now ISO>, "complaint", <optional: svix-id or feedback type>)
ON CONFLICT DO NOTHING
```

`source: "complaint"`.

### 4.2 `email.bounced` → suppress only HARD bounces

Classify from the bounce sub-type (Resend surfaces SES-style classification, typically
`data.bounce.type` — verify field name at build): **Permanent/hard → suppress**; Transient/soft and
Undetermined → do **not** suppress (§4.3). For a hard bounce, per recipient:

```
INSERT INTO email_suppressions (email, suppressed_at, source, note)
VALUES (<normalized>, <now ISO>, "bounce", <optional: bounce type/subtype>)
ON CONFLICT DO NOTHING
```

`source: "bounce"` — the value the schema already documents (`schema.ts:799`) that nothing writes
today.

### 4.3 Soft-bounce policy (v1: **ignore**, justified)

**v1 ignores soft/transient/undetermined bounces** — logs the run as a success, optionally records
an activity-log audit row, and writes **no** suppression row. Rationale:

- Soft bounces are transient by definition (full mailbox, greylisting, temporary server refusal) and
  self-heal; a live client should not be permanently killed over one transient blip.
- **Suppression here is permanent and append-only — there is no admin un-suppress UI.** A false
  suppression is unrecoverable without a manual DB edit, so the correct failure direction for an
  *ambiguous* signal is *don't suppress* (fail toward keeping a live address, per I3/I7's fail-safe
  posture). Undetermined/unknown bounce types are treated as soft for the same reason.
- **Count-based (suppress-after-N-soft) is explicitly deferred**, not chosen, because it needs
  per-address failure-count state — a new column or table plus its own idempotency/decay logic —
  which would break this phase's "append-only, no other writes" invariant (I3) and add a migration.
  v1 stays minimal; a future phase can add a soft-bounce counter if real data shows soft bounces
  masking dead addresses.

### 4.4 Unhandled event types

Any other `type` (`email.sent`, `email.delivered`, `email.opened`, …) is a deliberate no-op:
`handleResendWebhookEvent` returns `{ ignored: true, type }`, the route records success and returns
`200` (no SVIX retry). Only `email.bounced` and `email.complained` are subscribed in the dashboard,
but the code ignores anything else defensively.

### 4.5 Cross-source keying note

Because `email` is the single PK across **all** sources, a bounce for an address that already
unsubscribed (or vice-versa) is an idempotent no-op that leaves the original row's `source`
untouched (I4, earliest-wins). This is intentional and consistent with the existing writer — the row
already suppresses; `source` records only the first reason. Document this in the handler comment.

---

## 5. Close the bypass — `sendInquiryReplyEmail`

Today `sendInquiryReplyEmail` (`inbound-inquiry.ts:750-764`) reimplements the raw Resend `fetch`
and **never** checks suppression. Per the audit's fix #3, consolidate it onto the canonical transport
and add the gate.

**Refactor:**

1. **Delete** the local `sendInquiryReplyEmail` and its "kept local so the intake surface has no
   incidental import of the canonical email module" comment (`inbound-inquiry.ts:746-764`) — that
   rationale is exactly what this fix reverses.
2. **Add** a canonical `sendInquiryReplyEmail` to `src/lib/email.ts`, co-locating the suppression
   gate with the transport (structurally mirroring `sendSequenceEmail`, `email.ts:128-163`):
   ```
   export async function sendInquiryReplyEmail(input: { to; subject; text }):
     Promise<{ delivered: boolean; suppressed: boolean }>:
       to = input.to.trim().toLowerCase()
       if (await isEmailSuppressed(to)) return { delivered: false, suppressed: true }  # I8, no Resend call
       const { delivered } = await resendRequest({ to, subject: input.subject, text: input.text })
       return { delivered, suppressed: false }
   ```
   It reuses the private `resendRequest` (`email.ts:32-74`), which already returns
   `delivered:false` (never throws) when `RESEND_API_KEY` is unset — preserving the current helper's
   "returns false, never throws" contract (`inbound-inquiry.ts:747-748,751-752`).
3. `inbound-inquiry.ts` imports the canonical `sendInquiryReplyEmail` and calls it at
   `approveInquiryReply` (`:700`).

**Envelope / header parity to preserve (verified byte-for-byte):** the current local sender POSTs
`{ from: RESEND_FROM_EMAIL||default, to, subject, text }` with **no** `reply_to` and **no**
`headers` (`inbound-inquiry.ts:756-761`). `resendRequest` with neither `replyTo` nor `headers`
supplied emits the *identical* body (`email.ts:51-58` spreads `reply_to`/`headers` only when
present). So on a non-suppressed, transport-configured send the outbound envelope is unchanged. The
only intended behavioral changes: (a) a suppressed recipient now sends nothing, and (b) the send now
flows through the shared transport (so it inherits future `email.ts` hardening the drifted copy
would have missed).

**Caller (`approveInquiryReply`, `:700-729`) handling of the new suppressed case:** map the result
so a suppressed recipient keeps the comm row a `draft` (as a transport-failure does today,
`inbound-inquiry.ts:708,713`) and logs a distinct activity action (e.g.
`inquiry.reply_suppressed`) rather than a silent `sent:false`, so Tyler sees *why* it didn't send.
`{ delivered: true }` → unchanged `sent` path. Everything else in `approveInquiryReply` is
untouched.

---

## 6. Admin visibility (minimal, cheap)

Surface suppression state where operational signals already render: add one **INFO** signal to
`computeSystemHealth` (`src/lib/system-health.ts`), which flows automatically to `/system-status`
(via `getStudioSystemStatus`'s `systemsHealth` map, `system-status.ts:59-62`) and the daily digest.
`/system-status` is already linked from `/settings` (`settings/page.tsx:56-63`), so this is the
cheapest existing surface — no new page, no new route, no new query surface for agents.

The signal (a pure read, wrapped like the other best-effort blocks in `computeSystemHealth`, e.g.
`:405-423`): `SELECT COUNT(*)` over `email_suppressions` plus the most-recent `suppressed_at` (and,
cheaply, a per-`source` count). Rendered as, e.g.:

```
{ key: "email-suppressions", label: "Email suppressions",
  severity: "info",
  detail: "<N> suppressed address(es) (unsubscribe <a>, bounce <b>, complaint <c>); most recent <ISO>.",
  value: <N> }
```

**INFO only — it never alerts** (a suppression is healthy, expected behavior, not a fault). It is
deliberately *not* exposed as an agent/MCP tool (same boundary as the Phase 21 monitoring internals,
enforced by the `observability-guard` MCP-surface assertion). Alternative considered: a tile on
`/data-health` — rejected because `data-health` is about *canonical* data-integrity issues with
repair workflows (`data-health.ts:28-50`), and a suppression count is an operational metric that
belongs with the other operational heartbeat signals on `/system-status`.

---

## 7. Flag / dark mechanism + enablement runbook

**Decision: the unset-secret `503` IS the dark mechanism. No separate boolean flag is needed.**

Justification: the route is a pure event *sink* with no autonomous behavior — it does nothing until
(a) Resend is configured in the dashboard to POST to it *and* (b) `RESEND_WEBHOOK_SECRET` is set so
verification can pass. With the secret unset it returns `503` and writes nothing (I2). This mirrors
Twilio's unset-`TWILIO_AUTH_TOKEN` → `503` dark pattern (`twilio/inbound/route.ts:31-33`) and Phase
14's secret-unset dark posture. An extra `RESEND_WEBHOOK_ENABLED`-style flag would be redundant
belt-with-no-suspenders: there is no cron to gate, no autonomous loop to disable, and no code path
that acts before the signature (which itself requires the secret). The secret is simultaneously the
enablement switch *and* the trust boundary.

**Enablement runbook (Tyler):**

1. In the Resend dashboard → **Webhooks** → add an endpoint pointing at
   `https://studio.bythereeses.com/api/resend/webhook`, subscribed to **`email.bounced`** and
   **`email.complained`** only.
2. Copy the endpoint's **signing secret** (`whsec_…`) into `RESEND_WEBHOOK_SECRET` as a Wrangler
   secret, then redeploy.
3. (Optional, recommended) send a Resend test event and confirm `/system-status` shows
   `resend-webhook` as `ok` and the suppression count reacts.

**Config-preflight (optional, cheap):** add a check to `scripts/config-preflight.mjs` that warns if
`RESEND_API_KEY` is set (real sends happen) but `RESEND_WEBHOOK_SECRET` is unset (bounces are being
dropped on the floor) — the same "silent misconfiguration" class the audit's fix #4 recommends
guarding (`docs/email-deliverability.md:57`).

---

## 8. Heartbeat wiring (Phase 21)

Event-driven, error-rate — **not** staleness (no bounces for a week is normal). Mirror the
`twilio-inbound` / `inbound-inquiry` WARN-only entries.

1. **`src/lib/job-runs.ts`** — extend the `JobName` union (`job-runs.ts:55-66`) with:
   - `"resend-webhook"` — the real, alertable key.
   - `"resend-webhook-rejected"` — a separate **non-alerting** key for pre-verify signature rejects
     / unset-secret, kept OUT of the health catalog (exactly the `stripe-webhook-rejected` pattern,
     `job-runs.ts:64-66`), so a scanner spamming bad signatures cannot grief the real counter (I5).
   Optionally add `RESEND_WEBHOOK_SECRET` to `SECRET_ENV_NAMES` (`job-runs.ts:27-38`) so its value
   can never leak into `last_error`.
2. **`src/lib/system-health.ts`** — add one entry to `WEBHOOK_JOBS` (`system-health.ts:117-122`):
   ```
   "resend-webhook": { label: "Resend bounce/complaint webhook", warnFailures: 3,
                       criticalFailures: Number.POSITIVE_INFINITY }   # WARN-only, no CRITICAL alertKey
   ```
   WARN-only (like `twilio-inbound`/`inbound-inquiry`): a failing bounce webhook degrades
   deliverability hygiene but is not money-state drift, so it should never page. A missing row is
   correctly INFO ("event-driven — not-configured, not an alarm", the existing
   `WEBHOOK_JOBS` missing-row branch `:250-258`). Do **not** add `resend-webhook-rejected` to any
   catalog — it stays invisible to alerting by design.

---

## 9. Migration

**None.** `email_suppressions` already has exactly the columns needed
(`schema.ts:796-801`, `migrations/0088_automated_sequences.sql:19-24`):

```
email TEXT PRIMARY KEY NOT NULL   -- lowercased recipient (dedupe / idempotency key)
suppressed_at TEXT NOT NULL       -- ISO timestamp
source TEXT                       -- plain TEXT, NO CHECK constraint
note TEXT                         -- optional (bounce type / svix-id)
```

`source` is an unconstrained `TEXT` column, so writing `"bounce"` / `"complaint"` needs **zero**
schema change — only the inline union comment at `schema.ts:799`
(`"unsubscribe_link" | "admin" | "bounce"`) should gain `"complaint"` (doc-only). If a future
soft-bounce counter (§4.3) is ever built it would need a new migration; the next free number after
`0095_questionnaire_autofill_review.sql` is **`0096`** — but this phase adds none.

---

## 10. Tests

New `src/lib/resend-webhook.test.ts` (+ a route test), following the standalone-runner style of
`email-send-guard.test.ts` / `observability-guard.test.ts` (stub `globalThis.fetch`, temp D1):

1. **Signature verify — valid.** A correctly SVIX-signed payload (`whsec_` base64 secret,
   `{id}.{ts}.{body}` HMAC-SHA256 base64) verifies and returns parsed JSON.
2. **Signature verify — invalid.** Wrong signature → `ResendWebhookSignatureError` → route `401`,
   recorded under `resend-webhook-rejected`, **not** `resend-webhook`.
3. **Signature verify — expired.** Timestamp outside the 300s window → reject → `401` / rejected key.
4. **Unset secret.** `RESEND_WEBHOOK_SECRET` unset → route `503`, no processing, recorded under
   `resend-webhook-rejected` only.
5. **Bounce → suppression row.** A signed hard `email.bounced` inserts one
   `email_suppressions` row, `source="bounce"`, email lowercased.
6. **Complaint → suppression row.** A signed `email.complained` inserts `source="complaint"`.
7. **Idempotent replay.** Re-POSTing the same event (same recipient) is a no-op — still exactly one
   row, original `suppressed_at`/`source` unchanged (earliest-wins, I4). Also: a bounce for an
   address already `unsubscribe_link`-suppressed leaves `source="unsubscribe_link"`.
8. **Soft-bounce policy.** A signed soft/transient (and an undetermined) `email.bounced` writes
   **no** suppression row and returns `200` (I6/§4.3).
9. **Inquiry-reply now suppression-checked.** `sendInquiryReplyEmail` to a suppressed address makes
   **zero** Resend `fetch` calls and returns `{ delivered:false, suppressed:true }`; to a
   non-suppressed address it sends via `resendRequest` with the byte-identical
   `{from,to,subject,text}` body (no `reply_to`, no `headers`).
10. **Inquiry-reply on canonical transport.** Assert the drifted local `fetch` is gone — the intake
    path routes through `email.ts` (e.g. grep-guard that `inbound-inquiry.ts` no longer contains a
    literal `api.resend.com`, and imports `sendInquiryReplyEmail` from `@/lib/email`).
11. **Zero canonical-table writes (guard).** Mirror `observability-guard.test.ts`: seed one row in
    each canonical table, drive a bounce + complaint + replay through the handler, assert every
    canonical table is byte-for-byte unchanged and only `email_suppressions` (+ `job_runs`) grew.
12. **Flag-off / secret-unset `503`.** (Covered by #4; assert no suppression + no `resend-webhook`
    heartbeat written.)

---

## 11. Ordered tasks (with effort / risk)

| # | Task | Effort | Risk | Notes |
|---|---|---|---|---|
| 1 | `src/lib/resend-webhook.ts`: `ResendWebhookSignatureError`, `resendWebhookSecret()`, `verifyResendWebhookPayload` (hand-rolled SVIX HMAC, base64) | M | **Med** | Highest-risk piece — get the base64-secret-decode + `{id}.{ts}.{body}` scheme + multi-sig loop exactly right; unit-test against a known-good SVIX vector before wiring the route |
| 2 | `handleResendWebhookEvent`: parse envelope, classify bounce hard/soft, append `email_suppressions` ON CONFLICT DO NOTHING | S | **Med** | Confirm exact Resend `data` field names against live payload docs; parse defensively (unknown → ignore) |
| 3 | `src/app/api/resend/webhook/route.ts`: raw-body read, origin guard, 503/401/200/500 flow, heartbeat classification | S | Low | Direct mirror of `stripe/webhook/route.ts` structure |
| 4 | Public-route classification: `isStudioPublicPath` + dedicated `resendWebhook` rate kind (`_worker.js`) + origin-guard prefix | S | Med | A missed `isStudioPublicPath` entry silently drops every event (the Twilio 303 trap) — verify with a proxy-path test |
| 5 | Heartbeat wiring: `JobName` union + `WEBHOOK_JOBS` entry (+ optional secret-name) | XS | Low | Additive |
| 6 | Close the bypass: canonical `sendInquiryReplyEmail` in `email.ts`, delete local copy, update `approveInquiryReply` | S | Low | Envelope parity verified byte-for-byte (§5); one new suppressed-case log line |
| 7 | Admin visibility: INFO suppression signal in `computeSystemHealth` | XS | Low | Pure read, wrapped best-effort |
| 8 | Schema comment `+ "complaint"`; optional `config-preflight` warn | XS | Low | Doc-only; no migration |
| 9 | Tests (§10) | M | Low | Reuse the standalone-runner harness |

Overall: **medium** effort, concentrated in tasks 1–2 (signature correctness + payload shape).

---

## 12. Changelog

### Rev 1 — 2026-07-07

Initial build-ready spec for CR-6 (Resend bounce/complaint webhook → suppression, + close the one
sender that bypasses suppression). Written against a read of: `email_suppressions`
(`schema.ts:796-801`, `0088_automated_sequences.sql:19-24`); the sole current writer
(`unsubscribe/route.ts:95-98`); `isEmailSuppressed` + the sender inventory (`email.ts`); the bypass
(`inbound-inquiry.ts:750-764`); the Stripe hand-rolled-HMAC verify + signature-reject carve-out
(`stripe-checkout.ts:132-188`, `stripe/webhook/route.ts:13-59`); the Twilio `403`-before-recorded
pattern (`twilio/inbound/route.ts`, `twilio-webhook.ts`); proxy classification
(`origin-guard.ts:11-38`, `_worker.js:21-52,217-340`); heartbeat wiring (`job-runs.ts:55-66`,
`system-health.ts:108-122`); and the admin surfaces (`system-status.ts`, `data-health.ts`,
`settings/page.tsx`). Confirmed **no migration** is required (`source` is unconstrained `TEXT`).

_Fable review to follow._
