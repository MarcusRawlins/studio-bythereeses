# Phase 8 (slice B): SMS (Twilio) — Design Spec

Status: **design only, not built.** Flag OFF by default. No implementation code in this document.

Owner approval doctrine: **agents draft, Tyler sends.** Nothing in this slice auto-sends an SMS. Agents/automation DRAFT SMS as `project_communications` rows (`channel = "sms"`, `status = "draft"`); Tyler approves and sends from Studio admin. There is no auto-send path from any agent, automation, or inbound handler.

Legal doctrine: **consent-gated (TCPA).** No SMS is ever sent to a client without a recorded opt-in. Every message carries opt-out language; inbound `STOP` opts the client out immediately. This is a hard gate, enforced in the send helper, not a UI convention.

## 0. Goal and scope

Add outbound SMS via Twilio behind the existing Tyler-approval guard, plus a self-authenticated inbound webhook for delivery status and `STOP`/`START`/`HELP` compliance keywords. Built **dark**: `SMS_ENABLED` off by default, and `TWILIO_*` secrets fail-closed in production so nothing can send until Tyler provisions a Twilio account and sets credentials (the same "Tyler-provisions-to-enable" posture as 8a's Email Routing config).

### In scope for slice B
- `src/lib/sms.ts` — a Twilio REST send helper mirroring the `sendResendEmail` shape in `src/lib/email.ts`, fail-closed in prod, E.164 validation/normalization, logs every send to `project_communications` (`channel = "sms"`).
- Client-level SMS **consent** columns (opt-in state + source + timestamp) on `clients` (migration `0087`, next after `0086`), because the only existing `smsOptIn` today is **booking-scoped** (see §2.0). Mandatory opt-out language + `STOP` honoring.
- **Approval model:** SMS drafts flow through the existing `project_communications` draft path (which already accepts `channel = "sms"`); a new admin-only "send approved SMS" action; a **draft-only** agent tool (`studio_draft_sms`) with a guard test.
- **Inbound webhook** `POST /api/twilio/inbound` (+ a status callback) with **X-Twilio-Signature** verification (HMAC-SHA1 over URL + sorted params, constant-time, fail-closed). Untrusted-input hardening: every field hostile. `STOP` → opt-out; `START` → opt-in; `HELP` → Twilio auto-replies (Advanced Opt-Out, provider-side).
- Proxy composition edits so the webhook is reachable and self-authed (`isStudioPublicPath` + `adminProofRequired` exemption + drift test), mirroring the 8a inbound endpoint.
- `SMS_ENABLED` flag, additive migration, flag-only + secret-delete rollback, and an **enable runbook** (Tyler's Twilio steps).

### Explicitly OUT of scope for slice B
- **MMS / media messages.** Text-only.
- **Marketing blasts / bulk campaigns.** One message to one consented recipient at a time, from an approval action.
- **Auto-send from any agent/automation/inbound path.** Draft-only, always.
- **Two-way conversation threading** beyond `STOP`/`START`/`HELP` keyword handling + delivery-status logging. Inbound non-keyword messages are logged as an inbound `project_communications` row (best-effort client match) and surfaced for Tyler; no auto-reply, no thread state machine.
- **Short-code / 10DLC brand registration mechanics** beyond documenting them as a Tyler enable-runbook prerequisite.

---

## 2. Consent / TCPA compliance (the crux)

### 2.0 Reality check: the existing `smsOptIn` is booking-scoped, not client-scoped

The task framing says "reuse the existing `smsOptIn` field." Grounding the design against the real schema (`src/db/schema.ts`):

- `scheduler_bookings.smsOptIn` (line 158, `sms_opt_in`, default `false`) — **per-booking** consent captured at booking time when the meeting type has `schedulerMeetingTypes.smsOptInEnabled` (line 119) on.
- **There is no `clients.smsOptIn`.** The `clients` table (lines 8–20) has `phone` but no SMS-consent column.

Client-facing CRM SMS needs **client-level** consent, not booking-level. So this slice:

1. **Reuses** `scheduler_bookings.smsOptIn` as a *consent source* — a booking opt-in is one valid way a client becomes consented.
2. **Adds** durable client-level consent state on `clients` (migration `0087`), which the send helper reads. A booking opt-in (existing field) can seed/propagate into the client-level state at approval time, but the send gate reads the client-level truth so `STOP`/`START` have a single authoritative place to live.

This is called out explicitly so the builder does not assume a `clients.smsOptIn` exists.

### 2.1 New consent columns on `clients` (migration `0087`)

```
// src/db/schema.ts (DESIGN — additive columns on the existing `clients` table)
smsOptIn:            integer("sms_opt_in", { mode: "boolean" }).notNull().default(false),
smsConsentSource:    text("sms_consent_source"),   // "booking" | "portal" | "admin" | "inbound_start" | null
smsConsentAt:        text("sms_consent_at"),        // ISO timestamp of the current consent state change
smsOptOutAt:         text("sms_opt_out_at"),        // ISO timestamp of last STOP (null while opted in)
smsLastConsentNote:  text("sms_last_consent_note"), // free text audit ("STOP via +1555…", "booking abc")
```

- **`NOT NULL DEFAULT false`** so every existing client is opted-*out* until an explicit opt-in — no client is retroactively swept into consent. This is the legally safe default.
- `smsConsentSource` records **where** consent came from (audit requirement — you must be able to prove how you obtained consent).
- Opt-out sets `smsOptIn = false` + `smsOptOutAt = now` but **retains** the row and prior source note (never delete the consent history — you must prove both consent and revocation).
- **Migration ordering (Active-Learning Log):** these columns are read by the send helper on an **always-on** code path (the consent gate runs whenever a send is attempted, independent of the flag — the flag only decides whether the *transport* fires). Selecting the client row is a broad, existing query surface, so `0087` is an **always-on schema change** and MUST be applied to prod **before** the Worker deploy, or existing client reads risk `no such column`. Apply `0087` first, verify the columns + row sanity, then deploy. Use the repo's idempotent `CREATE`/`ALTER … ADD COLUMN` direct `d1 execute --file` pattern (do not blanket `migrations apply --remote`; the `d1_migrations` tracker is known out of sync — see Active-Learning Log).
  - SQLite note: `ALTER TABLE clients ADD COLUMN sms_opt_in INTEGER NOT NULL DEFAULT 0` (five `ADD COLUMN` statements). SQLite allows `NOT NULL` on add **only** with a default; all five have defaults/nullable, so this is safe and non-rewriting.

### 2.2 The consent gate (enforced in `src/lib/sms.ts`, not the UI)

The send helper's **first** action, before any Twilio call:

1. Resolve the destination client + `phone`.
2. Load client-level consent. **If `client.smsOptIn !== true` → refuse to send** (throw a typed `SmsConsentError`; never fall through). No opt-in, no send, ever — this is a code gate, not a checkbox.
3. Normalize `phone` to E.164 (§1.2). If it cannot be normalized → refuse (a malformed number is treated as no valid consented destination).
4. Only then compose + send.

The gate lives in the library so it holds for **every** caller (admin action, future automation), not just the admin form.

### 2.3 Mandatory opt-out language + `STOP` honoring

- **Every** outbound body appended (by the helper, not the caller) with opt-out language when it is not already present, e.g. `"\n\nReply STOP to opt out."` The helper owns this so no caller can send a message that lacks it. (For an established 10DLC campaign the carrier appends its own; the helper's append is idempotent — it checks for an existing `STOP` token before adding, and is a per-brand config toggle in the enable runbook.)
- `STOP` (and `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT` — the standard set) inbound → immediate opt-out (§4). Twilio's Advanced Opt-Out also stops delivery carrier-side; our webhook mirrors it into `clients.smsOptIn = false` so the CRM gate agrees with the carrier.
- **No silent drops (Active-Learning Log):** a refused send (no consent, bad number, flag off, secret unset in dev) returns a typed, logged result; it is never a swallowed no-op that looks like success. The admin send action surfaces the refusal reason to Tyler.

---

## 1. Twilio send helper — `src/lib/sms.ts`

Mirror the `sendResendEmail` shape in `src/lib/email.ts` (read env in the body, small typed function), with three deliberate differences: (a) **fail-closed (throw) in production** when `TWILIO_*` is unset — `email.ts` returns `false`, but SMS is consent/legal-sensitive and must not appear to succeed; (b) a **consent gate** (§2.2) before send; (c) **E.164 normalization**.

### 1.1 Signatures (design)

```
// src/lib/sms.ts  (DESIGN — not final code)

export type SmsSendResult =
  | { ok: true; sid: string; to: string; status: string }
  | { ok: false; reason: "flag_off" | "unconfigured_dev" | "no_consent" | "bad_number" };

export class SmsConfigError extends Error {}   // secrets unset in PROD → thrown (fail closed)
export class SmsConsentError extends Error {}   // recipient not opted in → thrown

// Low-level transport. Reads env in the body (no `env = process.env` default-param —
// avoids the TS2559 weak-type build failure in the Active-Learning Log). Fail-closed
// in prod when secrets unset; dev fallback (no-op, logs) only OUTSIDE prod.
async function sendTwilioMessage(input: { to: string; body: string }): Promise<{ sid: string; status: string } | { simulated: true }> {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER;
  const isProd = process.env.NODE_ENV === "production";

  if (!sid || !token || !from) {
    if (isProd) throw new SmsConfigError("Twilio is not configured.");   // fail closed
    return { simulated: true };                                          // dev-only fallback
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = btoa(`${sid}:${token}`);                                  // Basic ACCOUNT_SID:AUTH_TOKEN
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: input.to,
      From: from,
      Body: input.body,
      // Optional: StatusCallback: process.env.TWILIO_STATUS_CALLBACK_URL
    }).toString(),
  });
  if (!res.ok) throw new Error(`Twilio send failed: ${res.status}`);
  const json = await res.json() as { sid: string; status: string };
  return { sid: json.sid, status: json.status };
}

// High-level, consent-gated, logging send. THIS is what admin actions call.
export async function sendProjectSms(input: {
  projectId: string;
  clientId: string;
  body: string;
  communicationId?: string | null;   // the approved draft being sent, if any
  actorName?: string;                 // "Tyler"
}): Promise<SmsSendResult> { /* see §1.3 */ }
```

### 1.2 E.164 validation / normalization

- A single helper `toE164(raw, defaultCountry = "US"): string | null`:
  - strip spaces, dashes, parens, dots; keep a leading `+`.
  - if already `+` followed by 8–15 digits → validate against `^\+[1-9]\d{7,14}$`.
  - if 10 digits (US local) → prefix `+1`; if 11 digits starting `1` → prefix `+`.
  - anything else → `null` (reject; do not guess).
- Reused by both the outbound gate (destination) and the inbound webhook (matching a `From` number to a client). No external phone lib needed for US-first; keep the regex tight and documented. `clients.phone` is free-text today, so normalization at send time is mandatory.

### 1.3 Logging every send to `project_communications`

`sendProjectSms` reuses the existing communications model (`src/lib/project-communications.ts`) — the table already supports `channel = "sms"` (`communicationChannels` includes `"sms"`, line 8). Flow:

1. Run the consent gate (§2.2): load client, assert `smsOptIn === true`, normalize `phone` → E.164 or refuse.
2. Check `SMS_ENABLED` (§5). If off → return `{ ok: false, reason: "flag_off" }` **without** calling Twilio (dark no-op) — but still record nothing as "sent" (no false success).
3. Append opt-out language (§2.3) to `body`.
4. Call `sendTwilioMessage`. On dev-simulated result, log a `draft`→`sent`(simulated) note but never claim a real SID.
5. Write/patch the `project_communications` row: if `communicationId` provided (an approved draft), **update** it to `status = "sent"`, `sentAt = now`, `recipientName`, and store the Twilio SID + delivery status in a new nullable column (see below); else insert a fresh outbound `sms` row.
6. `logActivity({ action: "project.communication.sms_sent", actorType: "admin", actorName, metadata: { communicationId, sid, to (masked), status } })`.

Delivery-status persistence: add two nullable columns to `project_communications` in `0087` so status callbacks (§4) can update the row:

```
// src/db/schema.ts (DESIGN — additive on project_communications)
providerMessageId:  text("provider_message_id"),  // Twilio Message SID (also dedupe/lookup key for status callbacks)
deliveryStatus:     text("delivery_status"),        // queued|sent|delivered|undelivered|failed|received
```

- Mask the destination number in logs/metadata (`+1555…1234`) — never log the full number or the auth token.
- The helper is the **only** module that talks to Twilio; nothing else imports `fetch("api.twilio.com")`.

---

## 3. Approval model — agents draft, Tyler sends

Identical doctrine to email/8a: the SMS pipeline is a **draft-only producer**; the only send is a human, admin-side action.

### 3.1 Drafting (agents / automation)
- SMS drafts are ordinary `project_communications` rows with `channel = "sms"`, `status = "draft"`, `direction = "outbound"`. This already works today via `createProjectCommunicationFromAgent` / `…FromForm` — **no new draft table**. An agent draft is created with `createdBy = "agent"`.
- A **new draft-only agent tool** `studio_draft_sms` (in `src/lib/studio-mcp.ts`), mirroring the `studio_attach_gallery_link` draft-only pattern (which **always** forces `status: "draft"`, `createdBy: "agent"` regardless of supplied values):
  - `studio_draft_sms(projectId, clientId?, body, sourceType?, sourceId?)` → calls `createProjectCommunicationFromAgent(projectId, { channel: "sms", status: "draft", direction: "outbound", body, clientId, sourceType, sourceId })`.
  - It **hard-forces** `channel: "sms"`, `status: "draft"`, `createdBy: "agent"` — an agent can never set `status: "sent"` or `"queued"`, so the tool cannot trigger a send. It has **zero** send authority.
  - Description marks it draft-only ("Drafts an SMS for Tyler to review and send. Never sends.").
- Automation (Phase 8c sequences) that wants to nudge by SMS produces the same draft rows; it never calls `sendProjectSms`.

### 3.2 Sending (admin only)
- New admin action `sendApprovedProjectSmsAction(formData)` (server action, mirrors the existing `createInvoiceAction`/comm form actions in `sales.ts`/`project-communications.ts`), behind the admin session + Phase 6 admin-proof. It:
  1. Loads the target `project_communications` draft (`channel = "sms"`, belongs to the project).
  2. Calls `sendProjectSms({ projectId, clientId, body, communicationId })` — which enforces consent + E.164 + flag + fail-closed transport.
  3. Surfaces `SmsConsentError` / `bad_number` / `flag_off` back to Tyler as a visible reason (no silent success).
- This admin action is the **sole** place `sendProjectSms` is invoked. `sendProjectSms` is not exported to any agent/MCP surface.

### 3.3 Guard invariants + required guard test
- No agent tool, no automation, no inbound handler can send an SMS. Only `sendApprovedProjectSmsAction` (admin session) can.
- The agent draft tool forces `status: "draft"`/`createdBy: "agent"`/`channel: "sms"` server-side — a hostile argument (`status: "sent"`) is ignored.
- **Required guard test** `src/lib/sms-guard.test.ts` (mirrors the finance-guard assertions in `src/lib/studio-mcp.test.ts` and the 8a injection-guard test), asserting:
  1. `studio_draft_sms` with `status: "sent"` (or `"queued"`, or `createdBy: "admin"`, or `channel: "email"`) in its args STILL produces a row with `status = "draft"`, `channel = "sms"`, `createdBy = "agent"` — and calls Twilio **zero** times (spy on the transport).
  2. `sendProjectSms` to a client with `smsOptIn = false` throws `SmsConsentError`, writes no `sent` row, and calls Twilio **zero** times.
  3. `sendProjectSms` with `SMS_ENABLED` unset returns `{ ok: false, reason: "flag_off" }` and calls Twilio zero times.
  4. `sendTwilioMessage` with `TWILIO_*` unset under `NODE_ENV=production` throws `SmsConfigError` (fail closed); outside prod returns a simulated result (no throw, no network).
  This test is the enforcement contract for the approval + consent + fail-closed doctrine and must pass before the flag is enabled.

---

## 4. Inbound webhook (untrusted input)

Twilio POSTs to our webhook for (a) inbound SMS (`STOP`/`START`/`HELP` + any client reply) and (b) delivery-status callbacks. **Every field is attacker-controllable** — anyone can POST form-encoded data to a public URL claiming to be Twilio. The endpoint is only trustworthy because of the **X-Twilio-Signature** check.

### 4.1 Routes
- `POST /api/twilio/inbound` — inbound messages (Twilio Messaging webhook). Handles `STOP`/`START`/`HELP` keyword logic + logging inbound messages.
- `POST /api/twilio/status` — delivery-status callbacks (`MessageStatus` transitions). Updates `project_communications.deliveryStatus` by `providerMessageId` (the `MessageSid`).

(One combined route with a discriminator is acceptable, but two keeps the classifier/rate-limit predicates simple. Spec assumes two; both get the same signature verification.)

### 4.2 X-Twilio-Signature verification (fail-closed, constant-time)

Twilio signs each request: `signature = base64( HMAC-SHA1( AuthToken, url + concat(sortedParamKey + paramValue) ) )` where `url` is the **full public URL Twilio was configured to call** (scheme+host+path, incl. query for GET), and for `application/x-www-form-urlencoded` POSTs the params are the POST fields sorted by key, concatenated as `key+value` with no separators, appended to the URL.

```
// DESIGN — verification outline
const token = process.env.TWILIO_AUTH_TOKEN;
if (!token) return 503;                                   // fail closed (unconfigured)
const provided = request.headers.get("x-twilio-signature");
if (!provided) return 403;
const url = TWILIO_PUBLIC_WEBHOOK_URL;                    // configured constant, NOT derived from Host header
const params = [...form.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
const data = url + params.map(([k, v]) => k + v).join("");
const expected = base64(hmacSha1(token, data));
if (!constantTimeEqual(provided, expected)) return 403;   // constant-time compare
```

Critical details, each tied to the Active-Learning Log:

- **The signed URL must be the configured public URL, not reconstructed from the `Host`/`X-Forwarded-Host` header.** A header-derived URL is attacker-influenceable and would let a mismatch slip. Store the exact configured URL (`TWILIO_PUBLIC_WEBHOOK_URL`, the same string set in the Twilio console) and sign against it. Because the request arrives **through the Pages proxy**, the origin sees a rewritten host; the constant is the only reliable signed base. If Twilio is configured with the `studio.bythereeses.com` URL, sign against that literal.
- **Constant-time compare.** Use a length-checked byte-XOR compare (`constantTimeEqual`, as in `admin-proxy-auth.ts`) — never `===`. If the route runs on the Node runtime (like `scheduler-reminders/route.ts`, which imports `node:crypto`), `crypto.createHmac("sha1", token)` + `crypto.timingSafeEqual` is available. If it runs on edge, use WebCrypto: `crypto.subtle.importKey(..., { name: "HMAC", hash: "SHA-1" }, ...)` + the byte-XOR compare (no `timingSafeEqual` on edge — Active-Learning Log). **Pin the runtime** with `export const runtime` and match the crypto accordingly; default to Node runtime to reuse the proven `scheduler-reminders` pattern.
- **Fail closed:** `503` when `TWILIO_AUTH_TOKEN` unset; `403` on missing/bad signature. Never process an unverified body.
- **Verify BEFORE reading business meaning.** Parse the form once for signature computation; only after the signature passes do we act on `From`/`Body`/`MessageSid`.

### 4.3 Treat every field hostile
- **Length caps** on every stored field (mirroring 8a / scheduler caps): `Body` ≤ 1600 (Twilio's own max concatenated length), `From`/`To` validated through `toE164` (reject non-E.164), `MessageSid` ≤ 64 and matched against `^SM[a-zA-Z0-9]{32}$`/`^MM…$` shape, `MessageStatus` matched against a fixed allowlist. Over-cap → truncate + flag, never error-drop.
- **Strip CR/LF and control chars** from any single-line field before storage.
- **Attacker-chosen ids → INSERT ON CONFLICT DO NOTHING, never UPDATE from inbound** (Active-Learning Log). For inbound message logging, dedupe on `MessageSid` (unique); a replayed callback is an idempotent no-op. Status callbacks are the **one** allowed inbound update — but only to `deliveryStatus` on a row we already own, keyed by our stored `providerMessageId`, and only advancing status (never rewriting recipient/body). A callback referencing an unknown SID is logged + ignored, never used to create or mutate a canonical row.
- **No canonical-write authority beyond consent state + comm logging.** The webhook can: flip `clients.smsOptIn`, insert an inbound `project_communications` row, update `deliveryStatus`. It **cannot** create projects, clients, move money, or send anything. (Twilio-side auto-reply for `HELP`/`STOP` confirmations is configured in the Twilio console, not sent by us — so the webhook never triggers an outbound send, preserving "no auto-send.")
- **No silent drops:** every branch returns an explicit `2xx` (empty TwiML / 204) only after the intended DB effect is durably written; verification failures return `403`/`503`. Unknown/non-keyword inbound is **logged** (inbound comm row, best-effort client match by `From` E.164), never discarded.

### 4.4 Keyword handling
- **`STOP` (+ `STOPALL`/`UNSUBSCRIBE`/`CANCEL`/`END`/`QUIT`)** → find client by normalized `From`; set `smsOptIn = false`, `smsOptOutAt = now`, `smsConsentSource = "inbound_stop"` (append audit note); `logActivity({ action: "client.sms.opted_out", actorType: "system" })`. Twilio also blocks delivery carrier-side; we mirror it so our gate agrees. If no client matches `From`, record the opt-out against the raw number in an audit note (do not create a client) so a later match still honors it — **never** send to that number regardless.
- **`START`/`YES`/`UNSTOP`** → set `smsOptIn = true`, `smsConsentAt = now`, `smsConsentSource = "inbound_start"`, clear `smsOptOutAt`; `logActivity({ action: "client.sms.opted_in", actorType: "system" })`. Only re-enables a number the client themselves texted from (self-authorized by the inbound message + Twilio signature).
- **`HELP`/`INFO`** → **Twilio-side auto-reply** (Advanced Opt-Out message configured in the Messaging Service). Our webhook logs the event; it does **not** compose a reply (keeps "no auto-send from our code" intact).
- Keyword matching: case-insensitive, trimmed, exact-token match on the standard sets (do not substring-match — "STOPPING BY" is not `STOP`; Twilio itself uses exact keyword sets).

### 4.5 Proxy composition (REJECT-class — explicit, per Active-Learning Log)

`/api/twilio/inbound` and `/api/twilio/status` are **proxy-reachable** (Twilio calls the public host, which is fronted by the Pages proxy). Per the proxy-composition rule, an endpoint that must be reachable through the proxy needs **both** `isStudioPublicPath` (so it is not 303'd to `/admin/login`) **and** an `adminProofRequired` exemption (so `ADMIN_PROOF_ENFORCE=1` does not 404 it). Without both, the proxy 303s Twilio's POST to the `/admin/login` **200 page**, Twilio reads `2xx` as success, and the `STOP`/status is **silently lost** — the exact silent-success-that-didn't-happen failure 8a documents for the inbound endpoint.

Exact edits (mirroring the Phase 8a `/api/inbound/inquiry-email` entries):

1. **`pages-proxy/_worker.js` → `isStudioPublicPath(pathname)`** — add:
   ```
   pathname === "/api/twilio/inbound" ||
   pathname === "/api/twilio/status" ||
   ```
   with a comment matching the 8a note: self-authenticated by the **X-Twilio-Signature**, so it must NOT be gated behind the admin Google session. Like 8a, it is **NOT** added to the origin-guard bypass — it is reachable only through the proxy, which stamps the origin secret.

2. **`pages-proxy/_worker.js` → `rateLimitKind(url, request)`** — add both paths to the `publicMutation` POST branch (belt-and-suspenders per-IP cap alongside Twilio's own delivery rate), matching the 8a `/api/inbound/inquiry-email` entry:
   ```
   request.method !== "GET" && (
     … || pathname === "/api/twilio/inbound" || pathname === "/api/twilio/status"
   )
   ```
   (Confirm the `publicMutation` cap is generous enough for legitimate Twilio status-callback bursts, or give status a dedicated kind; a too-tight cap would drop legitimate callbacks — a delivery-visibility loss, not a compliance loss, but call it out.)

3. **`src/lib/admin-proxy-auth.ts` → `adminProofRequired(pathname)`** — add before the final `return true`:
   ```
   if (path === "/api/twilio/inbound" || path === "/api/twilio/status") return false;
   ```
   with the same rationale comment as the 8a `/api/inbound/inquiry-email` exemption (self-authed by Twilio signature, not the admin proof; without this, `ADMIN_PROOF_ENFORCE` 404s Twilio's POST).

4. **Drift test** `src/lib/admin-surface-classification.test.ts` — extend the existing drift assertions so both Twilio paths are pinned: `adminProofRequired("/api/twilio/inbound") === false`, same for `/status`, and that they are members of `isStudioPublicPath` (keeping the app classifier and the proxy's public-path predicate in lockstep, per the classifier-drift rule).

5. **Machine-caller `redirect: "manual"`:** any **machine client we write** that calls a proxy-fronted endpoint MUST use `redirect: "manual"` and treat any 3xx/opaqueredirect as failure (Active-Learning Log). For 8b this applies to:
   - The **status callback URL / any internal machine caller** — we do not control Twilio's redirect behavior, which is *why* both classifier edits above are mandatory (a 303 would be read by Twilio as `200` success). We cannot make Twilio use `redirect: "manual"`, so correctness here rests entirely on the endpoint being classified public + proof-exempt.
   - The **outbound send** in `sms.ts` calls `api.twilio.com` directly (not through our proxy), so it is unaffected by our proxy classifier; no `redirect: manual` needed there. Explicitly noted so the builder does not add spurious redirect handling to the send path.

---

## 5. Flag + rollout

### 5.1 `SMS_ENABLED` flag (OFF by default)
- `SMS_ENABLED` gates the **transport**. `smsEnabled()` = `process.env.SMS_ENABLED === "1"` (read in the function body, not an `env = process.env` default param — TS2559 weak-type build failure per Active-Learning Log). Off/unset → `sendProjectSms` returns `{ ok: false, reason: "flag_off" }` and never calls Twilio; the admin send action shows "SMS is disabled."
- Consider a three-state (`off`/`observe`/`enforce`) only if an observation window is wanted; SMS has no "report" mode analog, so a two-state `off`/`on` is sufficient — but keep the flag read centralized so it can grow to three-state like `ADMIN_PROOF_ENFORCE`/`CSP_MODE` if needed.
- **Drafting is always available** (drafts are just rows) — the flag only blocks the send transport, matching 7a's "read/draft always on, client-facing surface flag-gated" split. The inbound webhook's **consent handling stays functional even with `SMS_ENABLED` off** so a `STOP` is always honored (defensive: if a message ever went out, opt-out must work); the webhook's signature/consent logic is independent of the send flag.

### 5.2 Additive migration + dark ship
- `0087` adds the `clients` consent columns + `project_communications` delivery columns. All additive, all nullable/defaulted. Ship the migration, `sms.ts`, the draft tool, the admin action, and the webhook **dark** (flag off, `TWILIO_*` unset → prod fail-closed).
- Rollout order: (1) apply `0087` to prod (always-on client columns → **before** the Worker deploy, §2.1); verify columns + row sanity; (2) deploy app (Worker) with webhook + send helper + admin action + draft tool, `SMS_ENABLED` unset, `TWILIO_*` unset; (3) deploy Pages-proxy with the classifier edits (§4.5); (4) — Tyler steps, §5.4 — provision Twilio, set secrets, configure the webhook URLs; (5) send one consented test SMS to Tyler's own phone; (6) flip `SMS_ENABLED=1` after the test passes. Flag-flip is a Tyler step (enablement flips are not autonomous — guardrail #2).

### 5.3 Rollback
- **Flag-only + secret-delete**, both instant and non-destructive:
  - `wrangler secret delete SMS_ENABLED` (or set to `0`) → send path no-ops immediately; drafts remain, nothing sends.
  - `wrangler secret delete TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER` → transport fail-closed in prod (throws), belt-and-suspenders.
  - The `0087` columns are additive and harmless when unused; no down-migration needed. No canonical data is corrupted by a rollback because nothing auto-mutates canonical data (only consent state + comm logs, all benign).
- Follows the repo deploy gate (`npm run lint` / `build` **exit code** / `deploy:preflight`, source-drift check); the app + proxy deploy on the normal rails (backup → capture rollback version → deploy → health-check → rollback-on-failure).

### 5.4 Enable runbook (Tyler steps — like 8a's Email Routing config)
Documented, not automated (guardrail #2). Prerequisites Tyler completes to enable:
1. Create/configure a Twilio account; buy an SMS-capable number (or provision a Messaging Service).
2. **US A2P 10DLC brand + campaign registration** for the number/Messaging Service (carrier requirement for business SMS; unregistered traffic is filtered). Document that this is a lead-time item (days).
3. Configure the number's **Messaging webhook** → `https://studio.bythereeses.com/api/twilio/inbound` (POST); **Status Callback** → `…/api/twilio/status`.
4. Enable Twilio **Advanced Opt-Out** on the Messaging Service (carrier-standard `STOP`/`START`/`HELP` auto-replies) so `HELP` is answered provider-side and `STOP` is enforced carrier-side in addition to our mirror.
5. Set Worker secrets: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and `TWILIO_PUBLIC_WEBHOOK_URL` (the exact URL configured in step 3, used for signature verification). Optionally `TWILIO_STATUS_CALLBACK_URL`.
6. Set `SMS_ENABLED=1`.
7. Send one consented test message to Tyler's phone; reply `STOP` then `START` and confirm `clients.smsOptIn` flips both ways and delivery status logs.

---

## 6. Config / secrets, test plan, tasks

### 6.1 Config / secrets (add to the "Who Has Access" inventory in `docs/studio-agent-access.md`)

| Name | Store | Consumer | Notes |
| --- | --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | app Worker secret | `sms.ts` (Basic auth user; Messages URL) | New. Fail-closed in prod when unset. |
| `TWILIO_AUTH_TOKEN` | app Worker secret | `sms.ts` (Basic auth pass); webhook signature verify | New. **Also the webhook HMAC key** — rotate on suspected exposure; rotation invalidates in-flight signature checks + send auth simultaneously. Never log. |
| `TWILIO_FROM_NUMBER` | app Worker secret | `sms.ts` (`From`) | New. E.164 sending number / Messaging Service SID. |
| `TWILIO_PUBLIC_WEBHOOK_URL` | app Worker var/secret | webhook signature verify | New. The **exact** URL configured in the Twilio console; signature is computed against this literal, not a header-derived URL (§4.2). |
| `SMS_ENABLED` | app Worker var | `sms.ts` send gate + admin action | New. Flag, **default OFF** (`"1"` to enable). Rollback = delete/`0`. |
| `TWILIO_STATUS_CALLBACK_URL` | app Worker var (optional) | `sms.ts` (StatusCallback param) | Optional; enables per-message delivery callbacks. |

Rotation trigger for `TWILIO_AUTH_TOKEN`: suspected exposure (it is both the API credential and the webhook signing key — a leak compromises both send and inbound trust). Add a row to the credential inventory table with this dual role called out.

### 6.2 Test plan (per file)
- **`src/lib/sms.test.ts`** — `toE164` normalization (US 10/11-digit, already-`+`, reject garbage); `sendTwilioMessage` fail-closed **throws** `SmsConfigError` when `TWILIO_*` unset under `NODE_ENV=production`, returns simulated outside prod (no network); Basic-auth header shape (`btoa("sid:token")`) and form body (`To/From/Body`) asserted against a fetch spy; opt-out language appended idempotently.
- **`src/lib/sms-guard.test.ts`** (the enforcement contract, §3.3) — draft-tool forcing (`status`/`channel`/`createdBy` cannot be overridden); no-consent send throws + zero Twilio calls; flag-off returns `flag_off` + zero Twilio calls; fail-closed prod throw. **Must pass before the flag is enabled.**
- **`src/app/api/twilio/inbound/route.test.ts`** — signature verify: `503` when `TWILIO_AUTH_TOKEN` unset (fail closed), `403` on missing/wrong `X-Twilio-Signature`, `2xx` + effect on a **correctly signed** body (compute a real reference HMAC-SHA1 in the test); constant-time compare used (assert helper is the byte-XOR path, not `===`); URL signed is the configured constant, not the `Host` header (feed a spoofed `X-Forwarded-Host` and assert it does not change the verified URL); `STOP` sets `smsOptIn=false`, `START` sets `true`, `HELP` composes no outbound send; unknown `From` opt-out recorded without creating a client; length caps truncate-not-crash; replayed `MessageSid` is an idempotent no-op (INSERT ON CONFLICT DO NOTHING, no UPDATE of recipient/body).
- **`src/app/api/twilio/status/route.test.ts`** — signature verify (same fail-closed matrix); a valid callback advances `deliveryStatus` on the row matched by `providerMessageId`; an unknown SID is logged + ignored (no row created/mutated); status is validated against the allowlist.
- **`src/lib/admin-surface-classification.test.ts`** (drift, §4.5) — `adminProofRequired` returns `false` for both Twilio paths and they are `isStudioPublicPath` members, pinned against the proxy predicates.
- **Send/approval flow** (admin action) — `sendApprovedProjectSmsAction` on a consented client updates the draft row to `sent` + stores SID + logs activity; on a non-consented client surfaces the refusal and sends nothing.
- **Manual/staging** — real signed webhook from Twilio to a staging URL; send a consented test SMS; `STOP`/`START` round-trip flips `clients.smsOptIn`; delivery status logs.

### 6.3 Ordered task breakdown (effort / risk)

| # | Task | Effort | Risk |
| --- | --- | --- | --- |
| 1 | Migration `0087` + Drizzle model: `clients` consent columns (§2.1) + `project_communications` delivery columns (§1.3). Apply to prod **before** Worker deploy (always-on client columns) | S | Med (migration ordering) |
| 2 | `src/lib/sms.ts`: `toE164`, `sendTwilioMessage` (Basic auth, **fail-closed prod throw**, dev simulate), `sendProjectSms` (consent gate + flag + opt-out append + `project_communications` log) | M | **High** (consent/legal + fail-closed) |
| 3 | Draft-only agent tool `studio_draft_sms` (force `channel/status/createdBy`) in `studio-mcp.ts` + `studio-agent-access.md` tool description | S | Med (must have zero send authority) |
| 4 | Admin send action `sendApprovedProjectSmsAction` (sole send caller) + admin UI touchpoint on the project communications surface (send button on `sms` drafts, consent badge, refusal reasons) | M | Med (only place a send happens) |
| 5 | `POST /api/twilio/inbound` route: **X-Twilio-Signature** verify (fail-closed, constant-time, signed against configured URL), keyword `STOP`/`START`/`HELP` handling, inbound logging, INSERT-ON-CONFLICT dedupe, field caps | **L** | **High** (untrusted-input crux) |
| 6 | `POST /api/twilio/status` route: signature verify + `deliveryStatus` update by `providerMessageId` (known-SID only) | M | Med |
| 7 | Proxy composition edits (§4.5): `isStudioPublicPath` + `rateLimitKind` in `pages-proxy/_worker.js`; `adminProofRequired` in `admin-proxy-auth.ts`; drift test | M | **High** (silent-drop if wrong) |
| 8 | Tests: `sms.test.ts`, `sms-guard.test.ts` (gate before flag), inbound + status route tests (real reference HMAC), drift test, approval-flow test | M | Med |
| 9 | Secrets + "Who Has Access" doc update; enable runbook (§5.4); dark rollout then Tyler flag-flip | S | Low |

Highest-risk items: **#2 (consent gate + fail-closed send)**, **#5 (untrusted-input webhook + signature verify)**, and **#7 (proxy composition — get it wrong and Twilio's `STOP`/status is silently accepted-and-discarded)**. The canonical-safety guarantee rests on: the send helper being the sole Twilio caller with an enforced consent gate; the draft tool having **zero** send authority (#3, guard test #8); the webhook being verify-first, constant-time, INSERT-not-UPDATE from inbound, and never triggering an outbound send; and the flag/secrets being off/fail-closed by default. The `sms-guard.test.ts` (#8) and the signature-verify tests must pass before `SMS_ENABLED` is ever flipped.
