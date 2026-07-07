# Phase 19 — Embeddable lead-capture form → inquiry-intake pipeline

Status: spec rev 1 (build-ready — awaiting adversarial Fable spec review).
Origin: roadmap Phase 19 (Tyler): "Booking page + email intake exist; add a customizable inquiry form
the photographer embeds on their own site (→ inquiry intake pipeline)."
Risk class: **MEDIUM-HIGH** — this is a **NEW PUBLIC surface accepting untrusted, unauthenticated
browser input**, and it is **framed on a third-party origin** (`bythereeses.com`). No money, no new
canonical authority. The build is **dark** behind `LEAD_FORM_ENABLED`; flag-off = the routes 404, so
the flag flip is the only surface change.

> **Headline:** a lead-form submission is *just one more inquiry source*. It feeds the EXACT existing
> intake pipeline (`ingestInboundInquiry`'s review-item shape) through a sibling entrypoint
> `ingestWebFormInquiry`, producing a staging `inbound_inquiries` row + a review `agent_tasks` row and
> nothing else. The only path to a canonical project stays `approveInquiryProjectCreation`
> (`src/lib/inbound-inquiry.ts:653-690`), unchanged and admin-gated. Worst case for the whole surface
> is "junk review items Tyler dismisses," never a junk project/client. The spec's job is to make that
> boring and true, and to classify the public routes EXACTLY (this repo's reviews have repeatedly
> caught proxy/origin-guard misclassification — §6 is written to pre-empt every one).

---

## 0. Ground truth (re-verified against live code)

**The intake pipeline we are extending.** `ingestInboundInquiry`
(`src/lib/inbound-inquiry.ts:487-630`) is the reference: it caps + sanitizes every field
(`:35-49`, `sanitizeLine`/`sanitizeBody` `:83-108`), INSERT-OR-IGNOREs a staging row on `message_id`
(B2, `:533-537`), runs a *deterministic, authority-less* draft (`draftFromInquiry` `:383-433`, "no LLM,
no tools, no canonical mutation"), raises an authority-less review `agent_tasks` row (`:602-615`), and
sets `status: "proposed"`. Canonical creation happens ONLY later, in `approveInquiryProjectCreation`
(`:653-690`, "the only place an inquiry becomes a canonical project"), which is admin-gated and
unreachable from the intake endpoint. The core invariant is stated at `:7-24` and `:632-641`.

**The `inbound_inquiries` table (`src/db/schema.ts:713-747`) has NO `kind`/`source_type` column.**
Provenance for a web-form-sourced row therefore rides in the existing `parsed_json` column
(`:736`) — the same column that already carries `attachments`, `spamReason`, `threadReply`
(`inbound-inquiry.ts:525,557,580`). Decision D4: store `{ source: "web_form" }` there. **No column
is added to `inbound_inquiries`** (zero migration on that table).

**The CRM-side flood guard already exists and is reused verbatim.** `isRateLimited`
(`inbound-inquiry.ts:473-485`, caps `GLOBAL_HOURLY_INSERT_CAP=200` / `DOMAIN_HOURLY_INSERT_CAP=25`
`:53-54`) over-cap → auto-`status:"spam"`, no agent task. The web-form ingest runs it unchanged.

**The public booking POST is the pattern to mirror for input caps.** `createSchedulerBookingFromForm`
(`src/lib/scheduler.ts:824-863`) enforces `MAX_ATTENDEE_NAME_LENGTH=200`, `…_EMAIL_LENGTH=320`,
`…_PHONE_LENGTH=50`, `MAX_BOOKING_NOTES_LENGTH=5000` (`:244-248`) and rejects over-cap with a 400. The
questionnaire route mirrors these (`MAX_ANSWER_LENGTH=5000`,
`MAX_SERIALIZED_ANSWERS_LENGTH=100000`, `responses/route.ts:20-22`). The lead form reuses the
inbound-inquiry caps (`inbound-inquiry.ts:36-39`: name 200, email 320, address 320, body 50 000).

**The link-token pattern to mirror** is `src/lib/questionnaire-links.ts:32-68`: HMAC-SHA256 over a
base64url payload (`signPayload` `:32-34`), constant-time verify (`timingSafeEqual` `:55`), secret from
`SCHEDULER_LINK_SECRET || AUTH_SECRET`, throws in production if unset (`:15-22`).

**Config storage.** `app_settings` (`src/db/schema.ts:208-231`) is a single-row settings table read
by `getAppSettings` (`src/lib/settings.ts:139-154`) with JSON-blob columns (`paymentMethodsJson`,
`leadSourceTaxonomyJson`) normalized against code defaults (`normalizePaymentSettings` `:115-122`).
**Verified: there is NO free-form bucket suitable for the lead-form config** — a single additive
nullable column `lead_form_config_json` is required (§7). This is the phase's ONLY schema change.

**The three classification surfaces** (all re-read for §6): the Pages proxy
`pages-proxy/_worker.js` (host gate `:550-557`, `isSchedulePublicPath` `:286-298`,
`isStudioPublicPath` `:224-284`, `rateLimitKind` `:306-362`, `SECURITY_HEADERS` with
`frame-ancestors 'none'` + `x-frame-options DENY` `:12-19`, response finalization `:674-696`);
`src/lib/origin-guard.ts` (`PUBLIC_PAGE_PREFIXES` `:5-9`, `PUBLIC_API_PREFIXES` `:11-38`,
`isPublicOriginBypass*` `:44-58`, `guardDirectWorkerPageRequest` `:76-91`,
`guardDirectWorkerApiRequest` `:93-104`); and `src/lib/admin-proxy-auth.ts` `adminProofRequired`
(`:181-263`), whose fall-through is `return true`.

**The Phase 24 MAJOR-1 dead-code trap (must not repeat).**
`docs/specs/phase-24-resend-bounce-webhook.md:206-216,714`: adding a proxy-only endpoint to
`PUBLIC_API_PREFIXES` is **dead code**, because `PUBLIC_API_PREFIXES` only feeds
`isPublicOriginBypassApiPath`, which is consulted only by `guardDirectWorkerPageRequest`
(middleware). A route we want reachable **only through the proxy** must NOT be added to those lists —
leaving it out is exactly what makes `guardDirectWorkerPageRequest` 404 a direct `*.workers.dev`
request. The lead-form routes follow the Twilio/Resend "PROXY-ONLY" posture, not the Stripe/booking
"origin-bypass" posture (§6, D3).

---

## 1. Invariants this phase must hold

- **I1 — Flag OFF = no surface.** With `LEAD_FORM_ENABLED !== "true"`, the embed page GET, the thanks
  page GET, and the submit POST all `404`. No other code path changes. (`isLeadFormEnabled()`, sibling
  to `isInquiryIntakeEnabled` `inbound-inquiry.ts:765-769`.)
- **I2 — A submission creates ONLY a review item.** The public path writes ONLY: one
  `inbound_inquiries` staging row and one authority-less `agent_tasks` review row (and optional
  `job_runs` heartbeat). It writes NOTHING to `projects` / `clients` / `project_sources` /
  `project_communications`. Enforced structurally: the endpoint calls only `ingestWebFormInquiry`,
  which — like `draftFromInquiry` — has **no canonical-mutation authority** and no reference to
  `createProjectFromAgent`.
- **I3 — Canonical creation stays admin-gated and unchanged.** The ONLY path from a web-form inquiry
  to a canonical project is `approveInquiryProjectCreation` (`inbound-inquiry.ts:653-690`), invoked
  from the admin-only Studio surface. This phase adds **zero** new canonical authority.
- **I4 — Public surface lives on the SCHEDULE host only.** The embed page + POST + thanks page are
  classified in `isSchedulePublicPath` (`_worker.js:286-298`). They are NOT added to
  `isStudioPublicPath` (the admin host), and NOT added to any `origin-guard` bypass list
  (proxy-only; Phase 24 trap). `adminProofRequired` gets explicit exemptions for all three
  (`admin-proxy-auth.ts:181-263`).
- **I5 — Every stored field is length-capped + control-char sanitized** before storage, reusing the
  inbound-inquiry caps (`inbound-inquiry.ts:36-39`) and `sanitizeLine`/`sanitizeBody` (`:83-108`). No
  unbounded payload can be stored.
- **I6 — The embed page is frameable ONLY by Tyler's domains.** A `frame-ancestors` allowlist
  (`'self' https://bythereeses.com https://www.bythereeses.com`) is set **only** for the exact embed
  page path on the schedule host, and `x-frame-options` is dropped **only** there. Every other route
  keeps `frame-ancestors 'none'` + `x-frame-options DENY` (`SECURITY_HEADERS` `_worker.js:12-19`).
- **I7 — The surface is reachable ONLY through the proxy.** Proxy-only (D3) means the per-IP
  `leadForm` rate limit and the honeypot/timing gates cannot be bypassed by hitting `*.workers.dev`
  directly — `guardDirectWorkerPageRequest` (middleware, matcher `/api/:path*` + pages) 404s any
  direct-origin request lacking `x-reese-origin-secret`.
- **I8 — The embed token carries no secret and no PII.** It is an HMAC signature over a
  form-identity payload only (mirrors the questionnaire context token, I5 of Phase 23). No client
  data, no admin token.
- **I9 — Spam-dropped submissions leave no trace.** A honeypot hit / failed timing check / invalid
  nonce returns a friendly `200` and creates **no** row (never tips the bot, never stores junk).

---

## 2. Surface & routes (all on `schedule.bythereeses.com`, the public host)

| Route | Method | Purpose | Classification |
|---|---|---|---|
| `/embed/lead/[token]` | GET | Renders the configured form inside an iframe; mints a per-render timing nonce; serves the `frame-ancestors` carve-out. | schedule-public, proxy-only, framed |
| `/api/lead-form/submit` | POST | Verifies token + nonce + honeypot + timing + caps → `ingestWebFormInquiry` → 303 to thanks. | schedule-public, proxy-only, `leadForm` rate kind |
| `/embed/lead/[token]/thanks` | GET | Post-submit confirmation shown inside the iframe (PRG). | schedule-public, proxy-only, framed |

The photographer embeds one snippet on `bythereeses.com` (generated in Studio settings, §5):

```html
<iframe src="https://schedule.bythereeses.com/embed/lead/<signed-token>"
        title="Inquiry form" style="width:100%;border:0;min-height:720px" loading="lazy"></iframe>
```

**Why iframe, not a JS snippet / POST-only API (D1).** An iframe is style-isolated (no CSS bleed onto
Tyler's marketing site), needs no CORS (the form POSTs same-origin to `schedule.bythereeses.com`, so
the existing origin/rate-limit posture applies unchanged), and confines the untrusted-input surface to
one sandboxed document. The cost is one narrowly-scoped CSP carve-out (§6, D2), which is cheaper and
safer than owning a cross-origin CORS + injected-DOM surface on Tyler's site. A JS-snippet/API variant
would move CORS, styling, and script-injection burden onto the marketing origin for no security gain.
**Recommendation: iframe.**

---

## 3. The intake hand-off — `ingestWebFormInquiry` (the I2/I3 hinge)

New exported function in `src/lib/inbound-inquiry.ts`, a **sibling** to `ingestInboundInquiry` that
reuses its caps, sanitizers, flood guard, drafter, and agent-task insert but skips the email-only MIME/
auth parsing (the input is already structured):

```ts
export type WebFormInquiryInput = {
  name: string; email: string;
  phone?: string | null; eventDate?: string | null; eventType?: string | null;
  message: string; referralSource?: string | null;
  nonceId: string;          // the per-render timing nonce id → synthetic message_id (idempotency)
};

export async function ingestWebFormInquiry(input: WebFormInquiryInput): Promise<IngestInboundInquiryResult>;
```

Behavior (each step cites the reused primitive):

1. **Cap + sanitize** every field: `sanitizeLine(name, MAX_PARSED_NAME_LENGTH)`,
   `normalizeEmail(email)` (`:340-348`, rejects non-single-address), `sanitizeLine(phone, 50)`,
   `sanitizeLine(eventDate, MAX_EVENT_DATE_LENGTH)`, `sanitizeLine(eventType, 200)`,
   `sanitizeBody(message, MAX_BODY_TEXT_LENGTH)`, `sanitizeLine(referralSource, 200)`. (I5.)
2. **Compose `bodyText`** = the sanitized message plus a labeled block of the other structured fields
   (event date/type/phone/referral), so the triage UI and the drafter have full context. Store the
   structured values in `parsed_name` / `parsed_email` / `parsed_event_date` directly (no guessing);
   optionally run `parseEventDate` (`:350-360`) over a free-text date field as a fallback.
3. **Synthetic `messageId` = `webform:${nonceId}`** so the existing INSERT-OR-IGNORE on `message_id`
   (`:533-537`, B2) makes a double-submit of the **same** rendered form idempotent — one row, one task.
   `envelopeFrom`/`headerFrom` = the submitted email so `domainOf` (`:456-463`) still feeds the
   flood guard.
4. **`parsed_json.source = "web_form"`** (D4 provenance). No new column.
5. **Flood guard**: `isRateLimited(email, now)` (`:473-485`) — over-cap → `status:"spam"`,
   `parsed_json.spamReason = "rate_limited"`, **no** agent task, return early. (Reused verbatim.)
6. **Deterministic draft**: `draftFromInquiry({...})` (`:383-433`) → `proposedProjectJson`. Pass an
   optional `origin: "web_form"` so the draft's `intakeSource.kind`/`capturedBy` record the true source
   (`crm.ts:1402,1408` treat `kind`/`capturedBy` as free text) — see D5. **The email path stays
   byte-for-byte unchanged** (origin defaults to today's `"inquiry"` / `"Inbound Inquiry Intake"`).
7. **Authority-less review task** (`agent_tasks`, `:602-615` shape) + set `status:"proposed"`,
   `agentTaskId`. Return `{ id, status, deduped }`.

`approveInquiryProjectCreation` (`:653-690`) consumes `proposedProjectJson` unchanged — the web-form
row approves through the identical admin path (I3). **No edit to the approval functions.**

---

## 4. Spam defense (all in-house — NO CAPTCHA, NO external service)

In order of cost (cheapest first), consistent with the "everything in-house" principle:

1. **Signed embed token (`lead-form-links.ts`, mirrors `questionnaire-links.ts`).** The iframe URL
   carries an HMAC-signed token binding the form identity (`{ v:1, formId:"default" }`). A drive-by
   POST with a missing/tampered token is rejected **before any DB read** with a fast `403`
   (constant-time verify, `timingSafeEqual`). Long-lived (pasted once); no PII (I8).
2. **Per-render timing nonce (`formNonce`).** The GET page mints an HMAC over `{ issuedAtMs, id }`,
   renders it into a hidden field. On POST: reject if `now - issuedAtMs < MIN_FILL_MS` (default 3 s —
   bots submit instantly) or `> MAX_AGE_MS` (default 30 min — stale/replayed). The `id` becomes the
   synthetic `message_id` (§3.3) so replaying one nonce dedups to a single row. No client JS, no
   external service.
3. **Honeypot field** (hidden `company_website`, off-screen, `autocomplete="off"`, `tabindex="-1"`).
   Filled ⇒ friendly `200`, **no row** (I9). Bots fill every field; humans never see it.
4. **Length caps** mirroring the booking form (§0), enforced in `ingestWebFormInquiry` (I5).
5. **Per-IP proxy rate limit — a DEDICATED `leadForm` kind** (D3/§6), not `publicMutation`. Form spam
   has a different profile than booking bursts and Tyler should tune it independently; a dedicated
   bucket also stops booking traffic from sharing the ceiling. Default `{ max: 10, windowSeconds: 600 }`.
6. **CRM-side flood guard** (`isRateLimited`, §3.5) — global 200/hr, per-domain 25/hr → auto-`spam`.
7. **The output ceiling itself.** Every defense that leaks still only yields a **review item**. There
   is no path from the public POST to a canonical project/client (I2/I3). This is the load-bearing
   guarantee — the other six are cost-reducers, not the safety boundary.

Missing/invalid **embed token** → fast `403` (never loaded the page; no politeness owed).
Honeypot / timing / nonce failures → friendly `200` + silent drop (I9, don't tip the bot).

---

## 5. "Customizable" — v1 scope (a fixed field set, NOT a form builder)

**Hard scope: v1 is a fixed field vocabulary with per-field show/hide + required toggles and custom
copy. NO arbitrary field creation, NO drag-and-drop builder.** Config lives in `app_settings` as one
JSON blob (`lead_form_config_json`), normalized against code defaults exactly like
`normalizePaymentSettings` (`settings.ts:115-122`):

```ts
type LeadFormConfig = {
  version: 1;
  introText: string;            // capped ~500
  submitButtonText: string;     // capped ~60
  confirmationMessage: string;  // capped ~500 (shown on the thanks page)
  fields: {
    name:           { enabled: true;  required: true };   // identity — always on, always required
    email:          { enabled: true;  required: true };   // identity — always on, always required
    message:        { enabled: true;  required: true };   // identity — always on, always required
    phone:          { enabled: boolean; required: boolean };
    eventDate:      { enabled: boolean; required: boolean };
    eventType:      { enabled: boolean; required: boolean };
    referralSource: { enabled: boolean; required: boolean };
  };
};
```

- **`name`/`email`/`message` cannot be disabled or made optional** — they are what makes a review item
  actionable. The normalizer forces `enabled:true, required:true` for the three regardless of stored
  input.
- `NULL` column ⇒ code defaults (all fields shown; phone/eventDate/eventType on & optional;
  referralSource off).
- Admin edits via the existing Settings surface (extend `updateAppSettingsFromForm`
  `settings.ts:180-227`, same FormData pattern), plus a **"Copy embed snippet"** action that emits the
  iframe HTML with a freshly-signed embed token.

A full form builder (arbitrary questions, ordering, types) is explicitly **out of scope** — it would
re-introduce the questionnaire system's untrusted-mapping surface for no v1 benefit.

---

## 6. Classification — EXACTLY (the review-sensitive core)

The single spot this repo's reviews keep catching. All three surfaces, stated precisely:

**D2 — CSP `frame-ancestors` carve-out (the ONLY `_worker.js` header change).** Today
`SECURITY_HEADERS` sets `frame-ancestors 'none'` + `x-frame-options: DENY` on every response
(`_worker.js:18` / `:16`). In the response-finalization block, AFTER `applySecurityHeaders` +
`applyAppCsp` (i.e. after `_worker.js:689`, so it WINS), add a carve-out scoped to the exact embed
page path on the schedule host:

```js
// Phase 19: the lead-form embed PAGE is the ONLY frameable surface, and ONLY by
// Tyler's marketing domains. Scoped to the exact embed path on the schedule host;
// every other route keeps frame-ancestors 'none' + x-frame-options DENY.
if (incomingUrl.hostname === "schedule.bythereeses.com" && isLeadFormEmbedPath(incomingUrl.pathname)) {
  responseHeaders.set(
    "content-security-policy",
    "base-uri 'self'; object-src 'none'; frame-ancestors 'self' https://bythereeses.com https://www.bythereeses.com; upgrade-insecure-requests",
  );
  responseHeaders.delete("x-frame-options"); // else DENY defeats frame-ancestors in some UAs
}
```

with `isLeadFormEmbedPath(pathname) = /^\/embed\/lead\/[^/]+(?:\/thanks)?\/?$/.test(pathname)`.
Notes: (a) **must drop `x-frame-options`** — a lingering `DENY` blocks framing regardless of
`frame-ancestors` in browsers that honor XFO; (b) the embed page is NOT cached
(`canCachePublicBookingPage` `:515-522` only matches `/book/`), so there is no cache-HIT path to mirror
(unlike the CSP-preserve fix at `:617-632`); (c) the POST/thanks JSON/redirect responses are never
framed, so only the page carve-out is needed. This is the precise "which header, which route, set
where" the task asked for.

**Proxy host gate (`isSchedulePublicPath`, `_worker.js:286-298`) — ADD** all three paths, else the
schedule-host gate 303-redirects them to the discovery-call booking page (`:554-556`):
```js
/^\/embed\/lead\/[^/]+(?:\/thanks)?\/?$/.test(pathname) ||
pathname === "/api/lead-form/submit" ||
```
**Do NOT add to `isStudioPublicPath`** (`:224-284`) — that is the admin host; the lead form has no
business there.

**D3 — Rate-limit kind (`rateLimitKind`, `_worker.js:306-362`) — a DEDICATED `leadForm` kind.** Add
`leadForm: { max: 10, windowSeconds: 600 }` to `RATE_LIMITS` (`:21-59`) and match it BEFORE the
`publicMutation` branch (`:336-360`):
```js
if (request.method !== "GET" && pathname === "/api/lead-form/submit") return "leadForm";
```
Rationale (mirrors the twilio/inbound "own kind, not publicMutation" reasoning at `:36-51`): form-spam
volume is unrelated to booking volume, and a shared bucket would let one abuse the other. GET requests
to the embed/thanks pages get no rate kind (return `null`), same as the booking pages.

**Origin-guard (`src/lib/origin-guard.ts`) — DO NOT TOUCH (Phase 24 MAJOR-1).** The lead-form routes
are **PROXY-ONLY**. Leaving them OUT of `PUBLIC_PAGE_PREFIXES`/`PUBLIC_API_PREFIXES` is what makes
`guardDirectWorkerPageRequest` (middleware, `origin-guard.ts:76-91`, matcher covers `/api/:path*` and
pages) `404` a direct `*.workers.dev` hit lacking `x-reese-origin-secret` (I7). Adding them would be
**dead code** (those lists only feed `isPublicOriginBypassApiPath`, consulted only by the page guard)
AND would widen the direct-origin surface. Pin the negation in tests (§9): `isPublicOriginBypassPath` /
`isPublicOriginBypassApiPath` both return `false` for the lead-form paths. The submit route ALSO calls
`guardDirectWorkerApiRequest` in-route (`origin-guard.ts:93-104`) as defense-in-depth — the exact
Twilio/Resend posture ("guard called in-route, route NOT in the bypass list").

**`adminProofRequired` (`admin-proxy-auth.ts:181-263`) — ADD explicit exemptions.** The tail
fall-through is `return true` (`:262`), so without exemptions all three paths would `404` under
`ADMIN_PROOF_ENFORCE=1` (the latent trap Phase 8a/8b/8c each had to defuse). Add, alongside the sibling
public exemptions:
```js
if (/^\/embed\/lead\/[^/]+(?:\/thanks)?$/.test(path)) return false;
if (path === "/api/lead-form/submit") return false;
```
The signed embed token + nonce are the credentials, not the admin proof (comment it like `:199-221`).

Summary table:

| Surface | Setting | Value |
|---|---|---|
| Proxy schedule-host gate | `isSchedulePublicPath` | **ADD** embed page, submit POST, thanks page |
| Proxy admin-host gate | `isStudioPublicPath` | **unchanged** (wrong host) |
| Proxy rate limit | `rateLimitKind` / `RATE_LIMITS` | **ADD** dedicated `leadForm` kind (before `publicMutation`) |
| Proxy CSP | response finalize | **ADD** `frame-ancestors` carve-out + drop `x-frame-options`, embed page only |
| Origin guard | `PUBLIC_PAGE_PREFIXES` / `PUBLIC_API_PREFIXES` | **unchanged** (proxy-only; adding = dead code + wider surface) |
| Origin guard | in-route | submit route calls `guardDirectWorkerApiRequest` (defense-in-depth) |
| Admin proof | `adminProofRequired` | **ADD** exemptions for all three paths |

---

## 7. Migration — one additive nullable column (3-place mirror)

Migration number: **0096** (0095 = `questionnaire_autofill_review`, the current tail — verified
`migrations/` ends at `0095`; if a CR races another 0096 in first, renumber to the next free slot).

```sql
-- 0096: Phase 19 embeddable lead-form config. Additive + idempotent. NON-CANONICAL:
-- this column holds a display/config artifact; losing it reverts to code defaults, no business state.
ALTER TABLE app_settings ADD COLUMN lead_form_config_json TEXT;
```

Mirror per repo convention (matches Phase 23 §7):
1. `migrations/0096_lead_form_config.sql` — the file above.
2. `src/db/client.ts` — `addColumnIfMissing(database, "app_settings", "lead_form_config_json", "TEXT");`
3. `src/db/schema.ts` — add `leadFormConfigJson: text("lead_form_config_json")` to `appSettings`
   (`:208-231`).

**No new table. No change to `inbound_inquiries`** (web-form provenance rides in `parsed_json`, D4).
No index (config is read by the single settings row PK).

---

## 8. Task breakdown (ordered; effort / risk)

1. **Migration 0096 + 3-place mirror** (§7). Effort S / Risk L. Purely additive.
2. **Lead-form config module** (`src/lib/lead-form.ts`): `LeadFormConfig` type, defaults,
   `normalizeLeadFormConfig` (forces name/email/message on+required), `getLeadFormConfig`, and a
   settings-write path (extend `updateAppSettingsFromForm`). Effort S / Risk L.
3. **Token module** (`src/lib/lead-form-links.ts`): `createLeadFormEmbedToken` / `verifyLeadFormEmbedToken`
   + `mintFormNonce` / `verifyFormNonce` (timing + max-age), reusing the `questionnaire-links` HMAC
   helpers/secret. Effort S / Risk M.
4. **`ingestWebFormInquiry`** in `src/lib/inbound-inquiry.ts` (§3) + the optional `origin` param on
   `draftFromInquiry` (D5, email path byte-for-byte). Effort M / **Risk H** — the I2/I3 invariant core;
   must reuse (not fork) caps/sanitizers/flood-guard/drafter, and never touch canonical writes.
5. **Embed page route** `/embed/lead/[token]` (GET) + `/embed/lead/[token]/thanks`: verify embed token,
   render configured fields + honeypot + minted nonce; flag-off → `notFound()`. Effort M / Risk M.
6. **Submit route** `/api/lead-form/submit` (POST): flag gate → token → nonce/timing → honeypot → caps
   → `ingestWebFormInquiry` → 303 thanks; `guardDirectWorkerApiRequest` defense-in-depth; friendly
   `200` on spam-drop, `403` on bad token. Effort M / **Risk H**.
7. **Proxy classification** (`_worker.js`, §6/D2/D3): `isSchedulePublicPath` += 3 paths;
   `leadForm` rate kind; `frame-ancestors` carve-out + `x-frame-options` drop + `isLeadFormEmbedPath`
   helper. Effort M / Risk M (the review-sensitive one).
8. **`adminProofRequired` exemptions** (`admin-proxy-auth.ts`, §6). Effort S / Risk L.
9. **Settings UI**: lead-form config editor + "Copy embed snippet" (signed iframe). Effort M / Risk L.
10. **Tests** (§9). Effort M / Risk L.
11. **Docs**: changelog (§12), roadmap Phase 19 → DARK, note `LEAD_FORM_ENABLED` in
    `docs/handoff-build-state.md`. Effort S / Risk L.

---

## 9. Test plan (tsx; follow `src/lib/questionnaire-response-management.test.ts`,
`pages-proxy/proxy-security.test.ts`, and `src/lib/origin-guard.test.ts` — DB tests set
`DATABASE_PATH` to a temp db and import the real fns)

1. **No-canonical-write guard (I2 — the headline pin).** Submit a valid lead via `ingestWebFormInquiry`
   → assert `projects`/`clients`/`project_sources`/`project_communications` UNCHANGED; exactly ONE
   `inbound_inquiries` row (`status:"proposed"`, `parsed_json.source==="web_form"`) + ONE `agent_tasks`
   review row.
2. **Approval is the sole canonical path (I3).** `approveInquiryProjectCreation` on the web-form row →
   canonical project created via the existing path; activity `actorType:"admin"`; no code change to the
   approval fn exercised.
3. **Honeypot drop (I9).** POST with `company_website` filled → `200`, ZERO `inbound_inquiries` rows.
4. **Timing nonce (spam).** POST with nonce age `< MIN_FILL_MS` → dropped (no row); age within window →
   row created; age `> MAX_AGE_MS` → dropped.
5. **Embed token gate.** POST with missing/tampered token → `403`, no row; valid token → proceeds.
6. **Length caps (I5).** Over-cap name/email/phone/message → rejected or stored truncated to the
   inbound-inquiry caps; assert no field exceeds its cap in the stored row.
7. **Idempotent double-submit (B2 reuse).** Same nonce POSTed twice → single `inbound_inquiries` row
   (INSERT-OR-IGNORE on `webform:${nonceId}`), single agent task.
8. **CRM flood guard reuse.** Exceed `DOMAIN_HOURLY_INSERT_CAP` from one email domain → row
   auto-`status:"spam"`, no agent task.
9. **Flag-off = no surface (I1).** `LEAD_FORM_ENABLED` unset → embed GET `404`, submit POST `404`,
   thanks GET `404`.
10. **Proxy classification drift pins (I4/I7).**
    `isSchedulePublicPath("/embed/lead/abc") === true`, `("/embed/lead/abc/thanks") === true`,
    `("/api/lead-form/submit") === true`; `isStudioPublicPath("/embed/lead/abc") === false`;
    `isPublicOriginBypassPath("/embed/lead/abc") === false`;
    `isPublicOriginBypassApiPath("/api/lead-form/submit") === false` (Phase 24 dead-code trap);
    `rateLimitKind` for POST `/api/lead-form/submit` === `"leadForm"`;
    `adminProofRequired("/embed/lead/abc") === false` and `("/api/lead-form/submit") === false`.
11. **CSP framing carve-out pin (I6, `proxy-security.test.ts`).** A schedule-host response for
    `/embed/lead/<token>` has `content-security-policy` containing
    `frame-ancestors 'self' https://bythereeses.com https://www.bythereeses.com` and NO
    `x-frame-options`; a response for any OTHER path (e.g. `/book/...`) still has
    `frame-ancestors 'none'` + `x-frame-options: DENY`. (Drift pin so a future edit cannot silently
    widen framing.)
12. **Config (§5).** `lead_form_config_json` NULL → default field set rendered; a field set
    `enabled:false` → its input absent from the embed HTML and ignored on POST; `name`/`email`/`message`
    forced on+required even if stored otherwise; a missing required field → `400`/re-render.

Gate: `npm run lint` exit 0; `npm run build` EXIT=0 (type errors print after "Compiled successfully");
`npm test` all pass.

---

## 10. Rollout

- **Default:** `LEAD_FORM_ENABLED` unset ⇒ all three routes `404` (I1). No embed possible.
- **Enable:** apply migration 0096, set `LEAD_FORM_ENABLED=true`, configure fields in Settings, copy the
  signed iframe snippet, paste on `bythereeses.com`. Submissions then land in the existing inquiry
  triage inbox as `web_form`-sourced review items.
- **Rollback:** unset `LEAD_FORM_ENABLED` ⇒ routes `404` instantly; existing `inbound_inquiries` rows
  are inert review items (dismiss or approve normally). The additive column is ignored when off. No
  data migration on rollback.
- **Deploy ordering:** migration BEFORE the flag (the config path reads `lead_form_config_json`); the
  proxy/origin-guard/admin-proof classification ships together (a partial classification is the failure
  mode this phase's tests pin). Migration is additive/idempotent and safe to deploy dark ahead.
- **Secret:** `SCHEDULER_LINK_SECRET` (or `AUTH_SECRET`) must be set — the token module throws in
  production if unset (`questionnaire-links.ts:15-22`), same as today.

---

## 11. Hard scope guarantees

- **No money.** Nothing touches payments, invoices, refunds, or any charge/send path.
- **No new canonical authority.** The public endpoint calls only `ingestWebFormInquiry`, which creates
  a review item and nothing canonical. `approveInquiryProjectCreation` is unchanged and remains the
  sole path to a canonical project (I2/I3).
- **Flag OFF = no surface** — the routes `404`; zero behavior change anywhere else (I1).
- **Public surface on the SCHEDULE host only** — `isSchedulePublicPath` gains three paths; the admin
  host (`isStudioPublicPath`) is untouched; the origin-guard bypass lists are untouched (proxy-only,
  Phase 24 trap); `adminProofRequired` gains explicit exemptions (I4/I7).
- **Framing allowed ONLY for Tyler's domains**, scoped to the exact embed page path; every other route
  keeps `frame-ancestors 'none'` + `x-frame-options DENY` (I6).
- **No CAPTCHA / no external service** — spam defense is honeypot + signed timing nonce + signed embed
  token + per-IP `leadForm` limit + CRM flood guard + length caps, all in-house (§4).
- **No full form builder** — fixed field vocabulary with show/hide + required + copy customization only
  (§5).
- **One additive nullable column; no new tables; `inbound_inquiries` unchanged** — provenance rides in
  `parsed_json` (§3/§7).

---

## 12. Changelog

### Rev 1 — 2026-07-07
Initial build-ready spec. Adds an embeddable, customizable lead-capture form that feeds the EXACT
existing inquiry-intake pipeline via a sibling `ingestWebFormInquiry` (review item only; zero new
canonical authority). Iframe embed on `bythereeses.com` with a `frame-ancestors` carve-out scoped to
the one embed page path (+ `x-frame-options` drop). Proxy-only classification on the schedule host
(`isSchedulePublicPath`, dedicated `leadForm` rate kind, `adminProofRequired` exemptions); origin-guard
bypass lists deliberately untouched (Phase 24 dead-code trap). In-house spam defense (signed embed
token + per-render timing nonce + honeypot + caps + CRM flood guard; no CAPTCHA). Config in
`app_settings.lead_form_config_json` (one additive column, migration 0096). Dark behind
`LEAD_FORM_ENABLED`. Awaiting adversarial Fable spec review.
