# Phase 24 — Resend bounce/complaint webhook → email suppression (CR-6)

Status: spec (build-ready), **rev 2** — Fable-reviewed, **APPROVE WITH CHANGES**. No code in this
document.
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
| 3 | Public-route classification (pages-proxy allowlist + rate kind). **Rev 2:** proxy-only — no `origin-guard.ts` edit; a new test asserts the route is NOT an origin-guard bypass | `pages-proxy/_worker.js`, `src/lib/origin-guard.test.ts` | additive |
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
  one sender that bypassed the gate. (Rev 2: `approveInquiryReply` itself is currently unwired — no
  caller in `src/` — and its return changes to `{ sent, suppressed }`, §5.)

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

### 3.3 Public-route classification (mirror Twilio, NOT Stripe)

**Rev 2 (MAJOR 1 fix).** Rev 1 proposed adding `"/api/resend/webhook"` to origin-guard's
`PUBLIC_API_PREFIXES` (mirroring Stripe). **That edit is dead code for this route and is deleted.**
`PUBLIC_API_PREFIXES` only feeds `isPublicOriginBypassApiPath`, which is consulted **only** by
`guardDirectWorkerPageRequest` (`origin-guard.ts:76-91`, called from `middleware.ts:87`, whose
matcher includes `/api/:path*`). `guardDirectWorkerApiRequest` (`origin-guard.ts:93-104`) — the guard
this route's own control flow calls at §3.2 step `blocked = guardDirectWorkerApiRequest(request)` —
**never consults the bypass list at all**; it unconditionally 404s any `*.workers.dev` request
lacking the `x-reese-origin-secret` header, regardless of `PUBLIC_API_PREFIXES` membership. Stripe's
origin-bypass works only because `stripe/webhook/route.ts` does **not** import or call
`guardDirectWorkerApiRequest` — it relies solely on the middleware-layer bypass. Twilio's route
(`twilio/inbound/route.ts:23`), by contrast, calls `guardDirectWorkerApiRequest` directly and is
**not** in `PUBLIC_API_PREFIXES` — direct-origin access is always rejected regardless of secret
configuration, same as the unsubscribe route. Because this spec's route control flow (§3.2) already
calls `guardDirectWorkerApiRequest`, adding Resend to the bypass list would have had **zero runtime
effect** — the in-route guard call overrides it every time.

**Fix: declare `/api/resend/webhook` PROXY-ONLY — the exact Twilio posture (guard called in-route,
route NOT in the origin-guard bypass).** Resend must be pointed at the public studio host
(`https://studio.bythereeses.com/api/resend/webhook`), never at the `*.workers.dev` origin directly;
there is no "self-authenticates via SVIX regardless" fallback posture the way Stripe has one, because
the in-route `guardDirectWorkerApiRequest` call already forecloses direct-origin access. A new test in
`origin-guard.test.ts` asserts `isPublicOriginBypassApiPath("/api/resend/webhook") === false` (§10
test 13), pinning this posture so a future edit can't silently re-add the dead bypass entry.

Recommended endpoint URL: **`https://studio.bythereeses.com/api/resend/webhook`** — the public
studio host, through the Pages proxy (so it gets the proxy rate limiter + security headers), exactly
like Twilio and the unsubscribe route. One classification edit, plus one rate-limit edit:

1. **pages-proxy `isStudioPublicPath`** (load-bearing): add
   `pathname === "/api/resend/webhook"` to the allowlist in
   `pages-proxy/_worker.js:217-268`, alongside the Twilio/unsubscribe entries — same "NOT in the
   origin-guard bypass; reachable only through the proxy" shape as those entries (`_worker.js:233,
   241, 257`). **Rev 2 (MINOR 8 fix — corrected mechanism, same outcome):** without this entry, an
   unauthenticated POST to the studio host is `303`'d to `/admin/login`. That is **not** a
   false-success failure mode — SVIX does not follow redirects, so it observes the `303` itself
   (never a `2xx`), and the delivery is a **noisy**, repeatedly-failing/retried event (surfaced in the
   Resend/SVIX dashboard's delivery log, and eventually the endpoint gets auto-disabled after enough
   consecutive failures), not a silently-swallowed success. The practical outcome rev 1 described —
   bounce/complaint events never reach the handler — stands; only the "SVIX reads `2xx` as success"
   framing was wrong and is corrected here. The SVIX signature is the credential; the route verifies
   it constant-time.
2. **pages-proxy `rateLimitKind`** — add a **dedicated generous kind `resendWebhook`**
   (`RATE_LIMITS`, `_worker.js:21-52`; matched POST-only in `rateLimitKind`, `_worker.js:290-340`,
   **before** the `publicMutation` branch). Suggested cap `{ max: 600, windowSeconds: 60 }`, cloned
   from `twilioWebhook`/`inboundProjectEmail`. **Rev 2 (MINOR 8 fix — corrected mechanism, same
   outcome):** `/api/resend/webhook` does not match any existing `publicMutation` prefix
   (`_worker.js:314-338`), so an unlisted path does not fall back to the tight `publicMutation` cap —
   `rateLimitKind` returns `null`, and `rateLimitResponse` (`_worker.js:342-344`) short-circuits to
   "no limit at all" for a `null` kind. Skipping this edit would leave the route **completely
   unbounded**, not 429-prone. The dedicated kind is therefore an **abuse ceiling being deliberately
   added where none would otherwise exist** — not a fix for a false `429`. Justification for the
   generous cap (not a tighter one) mirrors the twilioWebhook rationale verbatim (`_worker.js:35-42`):
   bounce/complaint events arrive in bursts (one send that hits many dead addresses fans out) from
   Resend/SVIX's concentrated egress IPs (one bucket key), so a tight per-IP cap would risk dropping a
   legitimate burst of compliance-relevant complaint events. The signature at the origin is the real
   trust boundary; this cap only bounds abuse volume → err generous.

---

## 4. Event handling

Resend delivers a top-level `{ type, created_at, data: {...} }` envelope. **Confirm the exact
`data` field names against the live Resend webhook payload docs at build time** and parse
defensively (unknown shape → ignore, never throw, never mis-suppress). The recipient is taken from
`data.to` (string or array), normalized with the same `email.trim().toLowerCase()` rule
`isEmailSuppressed` uses (`email.ts:122`).

**Rev 2 (MEDIUM 4 fix) — resolve exactly one recipient, or log-and-skip.** `data.to` can be an array
(Resend supports multi-recipient sends). A bounce/complaint event reports the *delivery* outcome, not
necessarily which of several `to` addresses is the one that actually bounced/complained — suppressing
every address in the array on a multi-recipient send would suppress innocent co-recipients. So:

- If `data.to` (normalized) resolves to **exactly one** address, suppress that address (§4.1/§4.2 as
  written).
- If the payload otherwise identifies the specific bouncing/complaining recipient (e.g. a bounce
  sub-object naming the failed address, if Resend's schema exposes one — confirm at build time), use
  that address instead of the full `to` list.
- Otherwise (multiple `to` addresses, no per-recipient identification in the payload): **do not
  guess** — log-and-skip (record the event as handled/ignored for heartbeat purposes, write **no**
  suppression row, and note the ambiguity in the activity-log/audit trail). This is the same
  fail-toward-not-suppressing posture §4.3 already takes for ambiguous soft bounces (I3/I7).
- A test (§10 test 14) asserts a multi-recipient `data.to` writes zero suppression rows when no
  single recipient can be identified.

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

**Rev 2 (MEDIUM 7 fix) — the asymmetry with the unsubscribe writer is INTENTIONAL, document it as
such.** The unsubscribe route (`unsubscribe/route.ts:100-113`) does two writes: the
`email_suppressions` insert, **and** an `UPDATE` that archives any queued `draft`-status sequence
email for that recipient (voiding the queued-send window). This webhook's handler does **not** do
the second part — per I3 it performs **no** `UPDATE`/`DELETE` anywhere, ever. A future builder reading
only the unsubscribe route might reasonably conclude the bounce/complaint handler should mirror that
`UPDATE` to stay "consistent" — **it should not.** Doing so would violate this phase's hard-scope
guarantee (I3, "no new attack surface... append-only") and reintroduce a canonical-adjacent write this
spec deliberately avoids. The practical consequence of the asymmetry is already fully covered by the
existing gate: `sendSequenceEmail` calls `isEmailSuppressed` immediately before every send
(`email.ts:138`), so a queued draft written before the bounce/complaint lands still gets caught —
it just surfaces later, at send time, as a `{ ok: false, reason: "suppressed" }` refusal rather than
being pre-emptively archived. No client is ever mailed after suppression; only the *visible draft
status* lags briefly. Document this explicitly in the handler comment so it reads as a decision, not
an oversight.

### 4.6 Audit-row write only on a real insert (rev 2, MEDIUM 5 fix)

Rev 1 implied an unconditional `logActivity` audit row per accepted bounce/complaint event. Because
every write is `INSERT ... ON CONFLICT DO NOTHING` (I4), a **replay** of an already-suppressed address
still returns success from the handler but performs **no actual database change** — an unconditional
audit-log write would then log a fresh "suppressed" activity row on every replay of the same event,
spamming the activity log with entries that record nothing new. **Fix:** gate the audit-log write on
the insert having actually inserted a row (D1/drizzle's `.run()` result exposes `meta.changes`; treat
`changes > 0` as "this call actually added the row"). Only write `logActivity` when `changes > 0`;
a no-op replay (or a bounce for an address already suppressed by an earlier writer) records **no**
audit row. This gives test 7 (idempotent replay, §10) real teeth — it now also asserts the activity
log gained exactly one row across all replays, not one row per replay.

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

**Rev 2 (MEDIUM 6 fix) — `approveInquiryReply` is currently UNWIRED, and its return value must not
collapse "suppressed" and "transport failure" into the same shape.** A repo-wide search finds
`approveInquiryReply` defined at `inbound-inquiry.ts:691` with **no caller anywhere in `src/`** (it
is not wired to any admin UI action or API route today) — this fix closes the bypass regardless, but
there is currently no live path that would exercise the new `suppressed` branch in production. Today
`approveInquiryReply` returns `{ sent }` (`:729`), where `sent: false` is ambiguous between "recipient
suppressed" and "Resend transport failed." Change the return to `{ sent, suppressed }` (`suppressed:
true` when `sendInquiryReplyEmail` returned `{ suppressed: true }`, else `false`) so that whenever a
caller is eventually wired up, it can distinguish the two failure modes instead of only ever seeing an
undifferentiated `sent: false`. The envelope/header-parity claim (byte-for-byte identical outbound
body on a non-suppressed send) stands unchanged.

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
guarding (`docs/email-deliverability.md:57`). **Rev 2 note (ties to MAJOR 2, §8):** this preflight
check only catches the secret being **completely unset**. A **rotated/wrong** secret (set, but no
longer matching what's configured in the Resend dashboard) passes this preflight cleanly while every
real event 401s at runtime — that failure mode is covered by the new WARN heartbeat signal in §8, not
by config-preflight.

**Rev 2 (MAJOR 3 fix) — un-suppress runbook.** Rev 1 shipped every risky decision in this spec
(§4.3's soft-bounce-ignore choice, I3's append-only invariant, the lack of an admin UI) leaning on the
premise that "suppression is forever" being an acceptable failure mode *because* it can be manually
reversed if needed — but rev 1 never actually documented how. Without a written path, an operator
who needs to un-suppress a false-positive address has to reverse-engineer the schema under pressure.
This phase still ships **no code** for un-suppression (that would violate I3's append-only guarantee
for the feature as scoped), but the runbook must exist in this document:

1. **Reverse the CRM-side suppression** — delete the row from `email_suppressions` directly via
   Wrangler against the remote D1 database:
   ```
   npx wrangler d1 execute studio-bythereeses --remote --command "DELETE FROM email_suppressions WHERE email = '<address>'"
   ```
   (Same `wrangler d1 execute --remote` invocation shape already used for migrations in
   `docs/deploy-next.md:49-50`, here with `--command` instead of `--file`.) Confirm the address with
   a `SELECT` first; this is a manual, one-off admin action, not a script.
2. **Also clear Resend's own provider-side suppression list.** Resend maintains its **own**
   independent suppression/bounce list at the provider level, separate from this CRM's
   `email_suppressions` table. Deleting the CRM-side row does **not** clear Resend's list — Resend
   may continue to refuse or flag sends to that address regardless of what this table says. The
   operator must **also** remove the address from the Resend dashboard's suppression list (Resend →
   Contacts/Suppressions, or equivalent) for the address to actually become sendable again. Skipping
   this step is the most likely way an operator "fixes" the CRM and is still confused why sends keep
   failing.
3. **Follow-up phase (not this one):** a guarded, **admin-only** un-suppress action (e.g. a button on
   an admin-only suppression list view, behind the same admin-proof/session gate as other mutating
   admin actions) is the designated way to close this gap properly — logged via `logActivity` like
   every other manual admin action, and explicitly **not** exposed to the agent/MCP surface (same
   boundary already drawn for the Phase 21 monitoring internals, §6). This spec does not build that
   action; it only names it as the next step so the manual-D1-delete runbook above is understood as
   an interim, not a permanent, story.

---

## 8. Heartbeat wiring (Phase 21)

Event-driven, error-rate — **not** staleness (no bounces for a week is normal). Mirror the
`twilio-inbound` / `inbound-inquiry` WARN-only entries.

1. **`src/lib/job-runs.ts`** — extend the `JobName` union (`job-runs.ts:55-66`) with:
   - `"resend-webhook"` — the real, alertable key.
   - `"resend-webhook-rejected"` — a separate **non-alerting** key for pre-verify signature rejects
     / unset-secret, kept OUT of the health catalog (exactly the `stripe-webhook-rejected` pattern,
     `job-runs.ts:64-66`), so a scanner spamming bad signatures cannot grief the real counter (I5).
   **Rev 2 (ties to MINOR 9): add `RESEND_WEBHOOK_SECRET` to `SECRET_ENV_NAMES`
   (`job-runs.ts:27-38`) — mandatory, not optional**, so its value can never leak into `last_error`.
   Rev 1 called this optional; a leaked webhook secret in a stored error message is exactly the class
   of mistake `SECRET_ENV_NAMES` exists to prevent (it already redacts `RESEND_API_KEY`,
   `STRIPE_WEBHOOK_SECRET`, etc. — `job-runs.ts:27-30`), so there is no justification for treating this
   one secret as skippable.
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
3. **Rev 2 (MAJOR 2 fix) — reject-misconfiguration WARN signal, mirroring the existing Stripe
   pattern.** Rev 1 left a real gap: a **rotated/wrong** `RESEND_WEBHOOK_SECRET` (set, but no longer
   matching the Resend dashboard's signing secret) makes **every real event** reject pre-verify,
   recorded only under the non-alerting `resend-webhook-rejected` key (I5) — while `resend-webhook`
   itself just quietly stops accumulating successes and sits at whatever severity its last real
   success left it (`ok`/`info`, never escalating, because the `WEBHOOK_JOBS` loop only reacts to
   **failures recorded under its own key**, and rejects never touch `resend-webhook`). Left
   unnoticed, every bounce/complaint 401s forever, Svix eventually disables the endpoint after enough
   consecutive delivery failures, and nothing in `/system-status` ever said so. This is the identical
   shape to the Stripe gap the repo already fixed (`system-health.ts:124-131,278-298`, "FIX 4",
   `STRIPE_REJECT_FRESH_MS` / `STRIPE_REJECT_MIN_COUNT` / `STRIPE_WEBHOOK_SUCCESS_FRESH_MS`). Add the
   same block for Resend: introduce `RESEND_REJECT_FRESH_MS` (mirror `STRIPE_REJECT_FRESH_MS`, 6h),
   `RESEND_REJECT_MIN_COUNT` (mirror `STRIPE_REJECT_MIN_COUNT`, 2 — so one scanner probe never trips
   it), and `RESEND_WEBHOOK_SUCCESS_FRESH_MS` (mirror the Stripe 24h constant), then push a `warn`
   signal (key `"resend-webhook-signature"`, no `alertKey` — WARN-only, consistent with the
   `WEBHOOK_JOBS` entry above never reaching CRITICAL) when `resend-webhook-rejected` has recent
   (`<= RESEND_REJECT_FRESH_MS` old) rejects with `consecutiveFailures >= RESEND_REJECT_MIN_COUNT`
   **and** `resend-webhook` has **no** recent success (`> RESEND_WEBHOOK_SUCCESS_FRESH_MS` since
   `lastSuccessAt`, or no success ever). This is the exact condition (recent+repeated rejects, no
   recent success) that distinguishes "the secret is actually wrong" from "a scanner probed us once
   while everything is otherwise fine."

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
   address already `unsubscribe_link`-suppressed leaves `source="unsubscribe_link"`. **Rev 2 (MEDIUM
   5, gives this test real teeth):** additionally assert the activity log gained **exactly one** audit
   row across the original POST **and** every replay — the replay's `INSERT ... ON CONFLICT DO
   NOTHING` performs no actual change, so `logActivity` must not fire again (§4.6).
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
    heartbeat written. Keep this test scoped to exactly that — the no-heartbeat assertion is the
    point of #12; it stays separate from #4 rather than being merged into it.)

**Rev 2 additions (MAJOR 1, MEDIUM 4, MINOR 9):**

13. **Origin-guard classification (MAJOR 1).** `isPublicOriginBypassApiPath("/api/resend/webhook")
    === false` — pins the PROXY-ONLY posture (§3.3) so a future edit can't silently re-add the dead
    `PUBLIC_API_PREFIXES` entry rev 1 proposed.
14. **Multi-recipient over-suppression guard (MEDIUM 4).** A signed hard `email.bounced`/
    `email.complained` whose `data.to` is a multi-address array with no per-recipient identification
    in the payload writes **zero** suppression rows (log-and-skip, §4's rev-2 addition) — contrasted
    with a single-address `data.to`, which still suppresses normally.
15. **Multi-signature header, valid signature not first.** `svix-signature` carrying several
    space-delimited `v1,<sig>` tokens where the *correct* one is not the first token still verifies
    (the "accept if any matches" loop, §3.1 step 5, must not short-circuit on the first candidate).
16. **Malformed/wrong-length signature.** A `svix-signature` value that is not valid base64, or whose
    decoded length differs from the expected HMAC digest length, is rejected by the constant-time
    compare's length guard rather than throwing an unhandled error or (worse) matching. Also cover a
    non-base64 (garbage) `RESEND_WEBHOOK_SECRET` — verification fails closed, not throws uncaught.
17. **Unhandled event type → `200` ignored.** An event with an unsubscribed `type` (e.g.
    `email.delivered`) returns `{ ignored: true, type }` from the handler, records a `resend-webhook`
    success (not a rejection), and the route returns `200` (§4.4) — no SVIX retry.
18. **`data.to` array + uppercase normalization.** A single-element `data.to` array with mixed-case
    (e.g. `["Jane@Example.COM"]`) suppresses the lowercased, trimmed form — exercising both the array
    unwrap and the normalization rule together (not just the single-string case tests 5/6 already
    cover).
19. **Payload-size cap.** Mirror `MAX_INBOUND_JSON_BYTES` (`inbound-inquiry.ts:43`): a raw body over
    the cap on `request.text()` is rejected before signature verification is even attempted (or as part
    of it, per implementation) — the route must not buffer an unbounded body from an unauthenticated
    `*.workers.dev`-adjacent-but-proxy-fronted endpoint.

---

## 11. Ordered tasks (with effort / risk)

| # | Task | Effort | Risk | Notes |
|---|---|---|---|---|
| 1 | `src/lib/resend-webhook.ts`: `ResendWebhookSignatureError`, `resendWebhookSecret()`, `verifyResendWebhookPayload` (hand-rolled SVIX HMAC, base64) | M | **Med** | Highest-risk piece — get the base64-secret-decode + `{id}.{ts}.{body}` scheme + multi-sig loop exactly right; unit-test against a known-good SVIX vector before wiring the route |
| 2 | `handleResendWebhookEvent`: parse envelope, classify bounce hard/soft, resolve single recipient (rev 2 MEDIUM 4 — log-and-skip on ambiguous multi-recipient `data.to`), append `email_suppressions` ON CONFLICT DO NOTHING, audit-log write gated on `changes > 0` (rev 2 MEDIUM 5) | S | **Med** | Confirm exact Resend `data` field names against live payload docs; parse defensively (unknown → ignore) |
| 3 | `src/app/api/resend/webhook/route.ts`: raw-body read (payload-size cap, rev 2 MINOR 9 test 19), origin guard, 503/401/200/500 flow, heartbeat classification | S | Low | Direct mirror of `stripe/webhook/route.ts` structure |
| 4 | Public-route classification: `isStudioPublicPath` allowlist + dedicated `resendWebhook` rate kind (`_worker.js`). **Rev 2: NO origin-guard `PUBLIC_API_PREFIXES` edit** (MAJOR 1 — that edit is dead code here); add the negative classification test instead | S | Low | **Rev 2 (MINOR 8 — corrected rationale):** a missed `isStudioPublicPath` entry doesn't silently drop events via false-success — Svix doesn't follow redirects, so it sees the `303` itself and the failure is noisy (retried, eventually disables the endpoint). Verify with a proxy-path test regardless; the outcome (events never reach the handler) is the same risk. |
| 5 | Heartbeat wiring: `JobName` union + `WEBHOOK_JOBS` entry + **mandatory** `SECRET_ENV_NAMES` addition (rev 2 — was optional) + **new** reject-misconfiguration WARN signal mirroring Stripe FIX 4 (rev 2 MAJOR 2, §8 item 3) | S | Low | The WARN-signal addition is the one piece of meaningful new logic in this task; everything else stays additive |
| 6 | Close the bypass: canonical `sendInquiryReplyEmail` in `email.ts`, delete local copy, update `approveInquiryReply` to return `{ sent, suppressed }` (rev 2 MEDIUM 6 — note it is currently unwired, no caller in `src/`) | S | Low | Envelope parity verified byte-for-byte (§5); one new suppressed-case log line |
| 7 | Admin visibility: INFO suppression signal in `computeSystemHealth` | XS | Low | Pure read, wrapped best-effort |
| 8 | Schema comment `+ "complaint"`; `config-preflight` warn (unset-secret only, per rev 2 note in §7 — the rotated/wrong-secret case is covered by task 5's WARN signal, not this) | XS | Low | Doc-only; no migration |
| 9 | Tests (§10, now 19 tests incl. rev 2 additions 13–19) | M | Low | Reuse the standalone-runner harness |
| 10 | Document the un-suppress runbook (rev 2 MAJOR 3, §7) — no code, doc-only; name the guarded admin-only un-suppress action as a named follow-up phase | XS | Low | This spec ships no un-suppress code; only the manual `wrangler d1 execute --remote --command "DELETE ..."` runbook + the Resend-dashboard-suppression-list reminder |

Overall: **medium** effort, concentrated in tasks 1–2 (signature correctness + payload shape). Rev 2
adds no new high-risk surface — the additions are a corrected classification posture (removing dead
code), a WARN heartbeat signal (mirrors an existing pattern), a log-and-skip guard, an audit-log gate,
and a documentation-only runbook.

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

### Rev 2 — 2026-07-07 — Fable review: **APPROVE WITH CHANGES**

Fable's review verified this spec against the live code (`origin-guard.ts`, `middleware.ts`,
`system-health.ts`, `job-runs.ts`, `_worker.js`, `email.ts`, `inbound-inquiry.ts`,
`unsubscribe/route.ts`) and found 3 MAJOR, 4 MEDIUM, and 2 MINOR issues, plus endorsed two of rev 1's
riskier design calls as sound. All findings are folded in below; two of Fable's own rationale notes
were themselves double-checked against the code during this revision (see "Independent
verification" below).

| # | Finding | Fix (this doc) |
|---|---|---|
| MAJOR 1 | The rev-1 `origin-guard.ts` `PUBLIC_API_PREFIXES` edit is **dead code** for this route: `guardDirectWorkerApiRequest` (called by this route's own control flow, §3.2) 404s any workers.dev request lacking the origin secret and never consults the bypass list — that list only feeds `guardDirectWorkerPageRequest` via `middleware.ts`. Stripe's origin-bypass works only because its route never calls the guard at all. | §3.3 rewritten: the `PUBLIC_API_PREFIXES` edit is **deleted**; the route is declared **PROXY-ONLY** — the exact Twilio posture (guard called in-route, route NOT in the origin-guard bypass). New test 13 asserts `isPublicOriginBypassApiPath("/api/resend/webhook") === false`. |
| MAJOR 2 | A **rotated/wrong** `RESEND_WEBHOOK_SECRET` is permanently silent: every real event 401s under the non-alerting `resend-webhook-rejected` key while `resend-webhook` never accumulates a failure, so nothing ever escalates — Svix eventually disables the endpoint with zero visibility in `/system-status`. | §8 adds a new WARN signal mirroring the repo's existing Stripe `STRIPE_REJECT_*` pattern (`system-health.ts:124-131,278-298`): recent + repeated `resend-webhook-rejected` entries with no recent `resend-webhook` success → WARN. §7 clarifies the config-preflight check (task 8) only catches the secret being **unset**, not rotated/wrong — that gap is what the new WARN signal closes. |
| MAJOR 3 | **No un-suppress path exists anywhere**, yet the spec's riskiest decisions (append-only I3, the soft-bounce-ignore choice in §4.3, no admin UI) all lean on suppression being reversible if something goes wrong. | §7 gains a documented un-suppress runbook: the exact `npx wrangler d1 execute studio-bythereeses --remote --command "DELETE FROM email_suppressions WHERE email = '<address>'"` command; a reminder that **Resend keeps its own provider-side suppression list** that must be cleared separately in the Resend dashboard; and a named follow-up phase for a guarded, admin-only un-suppress action (not built in this phase). |
| MEDIUM 4 | Multi-recipient `data.to` over-suppression: suppressing every address in a multi-recipient send's `to` array can suppress innocent co-recipients who didn't bounce/complain. | §4 (new subsection): suppress only when `data.to` resolves to exactly one address, or the payload identifies the specific bouncing recipient; otherwise log-and-skip (no suppression row). New test 14. |
| MEDIUM 5 | Replayed valid events spam the activity log: an unconditional `logActivity` write on every accepted event logs a fresh row on every no-op replay of an already-suppressed address, even though `ON CONFLICT DO NOTHING` performed no actual write. | New §4.6: write the audit row only when the insert's `changes > 0` (an actual new row). Test 7 (idempotent replay) now also asserts exactly one audit row across the original event and all replays. |
| MEDIUM 6 | `approveInquiryReply` is currently **unwired** (no caller anywhere in `src/`), and its `{ sent }` return collapses "suppressed" and "transport failure" into the same `sent: false`, so a future caller could never tell them apart. | §5 states the unwired status explicitly and changes the return to `{ sent, suppressed }`. Envelope-parity claim (byte-for-byte identical outbound body on a non-suppressed send) stands unchanged. |
| MEDIUM 7 | The asymmetry with the unsubscribe writer (which archives queued sequence drafts via an `UPDATE`) versus this webhook (which never does) reads like an oversight and invites a future builder to "fix" it by adding the `UPDATE` — which would violate the append-only invariant (I3). | §4.5 expanded: the asymmetry is declared **intentional** — `isEmailSuppressed` already re-checks at send time (`email.ts:138`), so a stale queued draft surfaces later as a suppressed refusal rather than being pre-emptively archived. Documented so a builder doesn't add the UPDATE. |
| MINOR 8 | Two rationale errors in §3.3 (outcomes unaffected): (a) a missed `isStudioPublicPath` entry doesn't drop events via a false `2xx` success — Svix doesn't follow redirects, so it sees the `303` itself and the failure is noisy/retried, not silent; (b) an unlisted path isn't exposed to the tight `publicMutation` 429 cap — `rateLimitKind` returns `null` for it, meaning **no** rate limit at all (a bigger gap, differently shaped). | §3.3 rewritten with corrected mechanisms for both; the practical risk (add the entries) is unchanged. Ordered-tasks row 4 note corrected to match. |
| MINOR 9 | Missing test coverage: multi-signature header with the valid signature not first; malformed/wrong-length signature + non-base64 secret (length-guard behavior); unhandled event type → `200` ignored; `data.to` array + uppercase normalization together; a payload-size cap mirroring `MAX_INBOUND_JSON_BYTES`; the `SECRET_ENV_NAMES` addition should be mandatory, not optional; test 12 should stay scoped to its no-heartbeat assertion. | §10 gains tests 15–19 for the above; §8 item 1 makes the `SECRET_ENV_NAMES` addition mandatory; test 12's note clarifies it stays a distinct, narrowly-scoped assertion from test 4. |

**Endorsements (assessed as sound, unchanged):** the review explicitly assessed §4.3's
soft-bounce-ignore policy (fail toward *not* suppressing an ambiguous signal, given suppression is
otherwise permanent) and §7's no-separate-flag / unset-secret-`503` dark mechanism as **sound
design decisions** — both are carried forward into rev 2 without modification.

**Independent verification during this revision:** two of the review's rationale corrections (MINOR
8) were re-checked directly against `middleware.ts` (matcher includes `/api/:path*`, confirming
`guardDirectWorkerPageRequest` — and therefore the `PUBLIC_API_PREFIXES` bypass list — does run on API
routes, which is what makes Stripe's bypass work) and `pages-proxy/_worker.js:290-344` (confirming
`rateLimitKind` returning `null` short-circuits `rateLimitResponse` to "no limit," not a fallback to
`publicMutation`). Both corrections held up and are reflected as written above; nothing in Fable's
review was walked back.

Re-verify all cited line numbers if the underlying files change shape before build.
