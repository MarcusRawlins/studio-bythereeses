# Phase 19 — Embeddable lead-capture form → inquiry-intake pipeline

Status: spec rev 2 (build-ready — two adversarial Fable reviews applied; see §12).
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
  page path (`/embed/lead`), its thanks path (`/embed/lead/thanks`), and the submit response
  (`/api/lead-form/submit`) on the schedule host, and `x-frame-options` is dropped **only** there.
  Framing the harmless redirect/re-render response is required because the form POSTs same-origin and
  the POST **response becomes the framed document** (frame-ancestors/XFO apply to form-submission
  navigations) — see D2/BLOCKER-2. Every other route keeps `frame-ancestors 'none'` +
  `x-frame-options DENY` (`SECURITY_HEADERS` `_worker.js:12-19`).
- **I7 — The surface is reachable ONLY through the proxy.** The embed/thanks page paths are
  **dot-free** (the token rides in the `?t=` query param, NOT the path — see §2/BLOCKER-1), so they are
  actually MATCHED by the Next middleware page matcher (`/((?!…|.*\\..*).*)`, `middleware.ts:126-131`,
  which EXCLUDES any path containing a dot). Proxy-only (D3) then means the per-IP `leadForm` rate
  limit and the honeypot/timing gates cannot be bypassed by hitting `*.workers.dev` directly —
  `guardDirectWorkerPageRequest` (middleware, `origin-guard.ts:76-91`, matcher `/api/:path*` + pages)
  404s any direct-origin request lacking `x-reese-origin-secret`. A token-in-path form
  (`/embed/lead/<token>`, token contains a dot per `questionnaire-links.ts:44`) would be silently
  EXCLUDED from the matcher and I7 would be undeliverable — this is why the token is a query param.
- **I8 — The embed token carries no secret and no PII.** It is an HMAC signature over a
  form-identity payload only (mirrors the questionnaire context token, I5 of Phase 23). No client
  data, no admin token.
- **I9 — Bot-signal submissions leave no trace, and NO user-visible POST renders inside the frame.**
  A honeypot hit or a sub-`MIN_FILL_MS` submission (the only two genuine bot signals) creates **no**
  row and returns a **303 redirect to the thanks page** — indistinguishable from success, so the bot
  is never tipped. Every user-visible POST outcome is a 303 to a carve-out-matched embed path (thanks,
  or back to the form), NEVER a `200`/JSON body rendered in the iframe (a non-redirect response would
  render as a BLANK FRAME under `frame-ancestors 'none'` — see D2/BLOCKER-2). A **stale nonce is NOT a
  bot signal** (a couple composing a long inquiry is expected): it 303s back to a re-rendered form, it
  does not silently vanish (see §4/MAJOR-4). The only non-redirect response is the raw `403` for an
  invalid/missing embed token (no page was ever legitimately rendered there).

---

## 2. Surface & routes (all on `schedule.bythereeses.com`, the public host)

The token rides in a `?t=` QUERY PARAM, never in the path. This is load-bearing (BLOCKER-1): the
embed token mirrors `questionnaire-links.ts` and therefore CONTAINS A DOT
(`${payload}.${signPayload(payload)}`, `questionnaire-links.ts:44`), and the Next middleware page
matcher (`/((?!…|.*\\..*).*)`, `middleware.ts:129`) EXCLUDES any path containing a dot. A dotted path
(`/embed/lead/<token>`) would never reach `guardDirectWorkerPageRequest` or `adminProofRequired`,
defeating I7 and serving the framable page on the raw `*.workers.dev` origin with none of the proxy's
`SECURITY_HEADERS`. A dot-free path + `?t=` token is the repo-native answer (questionnaire context
tokens ride in `?context=`, `questionnaire-links.ts:70-75`).

| Route | Method | Purpose | Classification |
|---|---|---|---|
| `/embed/lead?t=<token>` | GET | Renders the configured form inside an iframe; mints a per-render timing nonce; serves the `frame-ancestors` carve-out. Dot-free path. | schedule-public, proxy-only, framed |
| `/api/lead-form/submit` | POST | Verifies token + nonce + honeypot + timing + caps → `ingestWebFormInquiry` → **303** to thanks (success) / back to form (validation/stale) / thanks (bot-signal drop). | schedule-public, proxy-only, `leadForm` rate kind, framed redirect |
| `/embed/lead/thanks?t=<token>` | GET | Post-submit confirmation shown inside the iframe (PRG). Dot-free path. | schedule-public, proxy-only, framed |

The photographer embeds one snippet on `bythereeses.com` (generated in Studio settings, §5):

```html
<iframe src="https://schedule.bythereeses.com/embed/lead?t=<signed-token>"
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
  nonceId: string;          // a `crypto.randomUUID()` from the signed nonce → synthetic message_id (idempotency)
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
   `nonceId` MUST be a `crypto.randomUUID()` minted per GET render and embedded in the signed nonce
   payload (§4.2, MEDIUM-1) — NEVER derived from `issuedAtMs` or a counter, or two simultaneous loads
   would mint the same `nonceId`, collide on the INSERT-OR-IGNORE dedup, and one lead would be silently
   discarded as a duplicate. `envelopeFrom`/`headerFrom` = the submitted email so `domainOf`
   (`:456-463`) still feeds the flood guard.
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

**Threat-model honesty (MEDIUM-2 rv2).** The signed embed token is **public and reusable by design**
— it is in Tyler's marketing-page source, so anyone can read it and POST with it. The token and the
timing nonce **RAISE BOT COST**; they do NOT *prevent* spam. The REAL spam ceiling is the CRM flood
guard (`isRateLimited`, §3.5/§4.6) + the per-IP `leadForm` proxy rate kind (§4.5), backed by the
absolute output ceiling (§4.7): the worst case is junk review items, never a junk project. Read the
list below as cost-reducers layered under that ceiling, not as a spam-proof gate.

In order of cost (cheapest first), consistent with the "everything in-house" principle:

1. **Signed embed token (`lead-form-links.ts`, mirrors `questionnaire-links.ts`).** The iframe URL
   carries an HMAC-signed token binding the form identity and a revocation counter
   (`{ v:1, formId:"default", rev:number }`). A drive-by POST with a missing/tampered token is
   rejected **before any DB read** with a fast `403` (constant-time verify, `timingSafeEqual`). No PII
   (I8). **Expiry/revocation (MEDIUM-7):** the token is long-lived and shared-secret-signed
   (`SCHEDULER_LINK_SECRET||AUTH_SECRET`, shared with questionnaire+scheduler links), so rotating the
   secret is a nuclear option that kills every outstanding client link. Instead, `rev` is carried in
   BOTH the token payload AND `LeadFormConfig` (§5); the submit route verifies `token.rev ===
   config.rev`, and "Copy embed snippet" mints the CURRENT `rev`. Revocation of an abused embed URL
   becomes a Settings edit (bump `rev`) — no secret rotation, no collateral damage to other links.
2. **Per-render timing nonce (`formNonce`).** The GET page mints an HMAC over
   `{ issuedAtMs, id: crypto.randomUUID() }` (the `id` MUST be a `crypto.randomUUID()`, MEDIUM-1),
   renders it into a hidden field. The `id` becomes the synthetic `message_id` (§3.3) so replaying one
   nonce dedups to a single row. On POST:
   - `now - issuedAtMs < MIN_FILL_MS` (default 3 s — bots submit instantly): a genuine bot signal →
     **303 to thanks**, no row (I9).
   - `now - issuedAtMs > MAX_AGE_MS`: a **stale** nonce is NOT a bot signal (MAJOR-4) — a couple
     composing a long inquiry with the tab open is expected. **DECISION: lengthen `MAX_AGE_MS` to
     `1000*60*60*8` (8 h)** rather than 30 min. Replay is already fully neutralized by the `nonceId`
     dedup (§3.3), so a long window costs nothing; an 8 h window covers realistic compose times. If a
     nonce is *still* older than 8 h, **303 back to a re-rendered form** with a fresh nonce and a
     "please confirm and resubmit" note — the lead is NEVER silently dropped. No client JS, no
     external service. **PII constraint (MINOR, security):** the redirect URL carries ONLY `?t=<token>`
     + a generic `&error=<code>` — NEVER the submitted `name`/`email`/`message` values as query params
     (they would land in proxy access logs alongside the token). If typed values are to be preserved
     across the re-render, use a short-lived server-side stash keyed by the nonce `id`, not the query
     string; otherwise the re-rendered form starts empty and the user re-enters (acceptable — an 8 h
     stale window makes this near-never).
3. **Honeypot field** (hidden `company_website`, off-screen, `autocomplete="off"`, `tabindex="-1"`).
   Filled ⇒ **303 to thanks** (indistinguishable from success, preserves I9), **no row**. Bots fill
   every field; humans never see it.
4. **Length caps** mirroring the booking form (§0), enforced in `ingestWebFormInquiry` (I5). A missing
   required field or an over-cap/invalid required field (name/email/message) → **303 back to the form**
   with `?error=…` (a validation re-render, NOT a silent drop — the user must be able to correct it).
   The redirect carries only `?t=<token>&error=<code>` — never the submitted PII as query params (same
   constraint as the stale-nonce re-render above).
5. **Per-IP proxy rate limit — a DEDICATED `leadForm` kind** (D3/§6), not `publicMutation`. Form spam
   has a different profile than booking bursts and Tyler should tune it independently; a dedicated
   bucket also stops booking traffic from sharing the ceiling. Default `{ max: 10, windowSeconds: 600 }`.
   A separate **`leadFormPage` GET kind** (default `{ max: 60, windowSeconds: 60 }`, D3/§6, MEDIUM-6)
   bounds the uncached embed-page GET (each GET does origin SSR + an `app_settings` read + an HMAC
   nonce mint, and is explicitly UNCACHED) so per-IP GETs cannot be free origin-load amplification or
   unlimited nonce farming.
6. **CRM-side flood guard** (`isRateLimited`, §3.5) — global 200/hr, per-domain 25/hr → auto-`spam`.
   **Cross-channel coupling tradeoff (MEDIUM-5):** `isRateLimited` (`inbound-inquiry.ts:473-485`)
   counts ALL `inbound_inquiries` rows in the trailing hour REGARDLESS of source. The web form is a
   cheaper flood vector than SMTP, so a web-form flood can push the global count to
   `GLOBAL_HOURLY_INSERT_CAP=200`, after which every genuine EMAIL inquiry is auto-`status:"spam"` with
   no agent task (`:556-562`) — retained but unsurfaced. **DECISION: keep `isRateLimited` reused
   VERBATIM (do not fork it — §3.5), and add a health alert/count** (a `job_runs` heartbeat / structured
   warn + counter) whenever the GLOBAL cap trips, so a cross-channel starvation event is visible instead
   of silent. Per-source scoping of the global cap (using `parsed_json.source`) is noted as a
   FOLLOW-UP if the alert ever fires in practice; v1 does not fork the shared guard.
7. **The output ceiling itself.** Every defense that leaks still only yields a **review item**. There
   is no path from the public POST to a canonical project/client (I2/I3). This is the load-bearing
   guarantee — the other six are cost-reducers, not the safety boundary.

Missing/invalid **embed token** → fast `403` (never loaded the page; no politeness owed; the ONLY
non-redirect POST outcome). Honeypot / sub-`MIN_FILL_MS` → **303 to thanks** + silent drop (I9, don't
tip the bot). Stale nonce / validation error → **303 back to the re-rendered form** (never a silent
drop). Every user-visible outcome is a 303 to a carve-out-matched embed path so it never renders as a
blank frame (D2/BLOCKER-2).

---

## 5. "Customizable" — v1 scope (a fixed field set, NOT a form builder)

**Hard scope: v1 is a fixed field vocabulary with per-field show/hide + required toggles and custom
copy. NO arbitrary field creation, NO drag-and-drop builder.** Config lives in `app_settings` as one
JSON blob (`lead_form_config_json`), normalized against code defaults exactly like
`normalizePaymentSettings` (`settings.ts:115-122`):

```ts
type LeadFormConfig = {
  version: 1;
  rev: number;                  // revocation counter (MEDIUM-7); token.rev must === config.rev
  introText: string;            // capped ~500, sanitized (sanitizeLine/sanitizeBody), rendered ESCAPED
  submitButtonText: string;     // capped ~60, sanitized, rendered ESCAPED
  confirmationMessage: string;  // capped ~500 (shown on the thanks page), sanitized, rendered ESCAPED
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
  referralSource off; `rev: 0`).
- **Config-injection / stored-XSS defense (MEDIUM-3).** `lead_form_config_json` free text (introText,
  submitButtonText, confirmationMessage, field labels) is ADMIN-SET but rendered on a PUBLIC page framed
  into `bythereeses.com`. `normalizePaymentSettings` (`settings.ts:115-122`) only SHAPE-normalizes and
  `cleanText` only trims — neither strips HTML/control chars. Therefore:
  - (a) **All config text is rendered ONLY as escaped JSX text nodes — NEVER via
    `dangerouslySetInnerHTML`** (do not "allow line breaks" by injecting HTML; use `white-space:
    pre-wrap` on an escaped text node if line breaks are wanted).
  - (b) `normalizeLeadFormConfig` runs `sanitizeLine` (short fields, labels, button text) /
    `sanitizeBody` (introText, confirmationMessage) + the field caps on EVERY string field **before
    store**, and the render escapes regardless (defense in depth — a hand-edited DB row is still inert).
  - (c) A test (§9) asserts `<script>` in `introText` renders as inert escaped text.
- Admin edits via the existing Settings surface, but the lead-form config is a **SEPARATE `<form>`
  posting a DEDICATED action** (`updateLeadFormConfigFromForm`), NOT joined into
  `updateAppSettingsFromForm` (`settings.ts:180-220`). Reason (MINOR-9): `updateAppSettingsFromForm`
  unconditionally rewrites the full business/payment column set via `onConflictDoUpdate`
  (`:208-220`), and `normalizeBusinessSettings` defaults empty fields (`:104-113`); a second `<form>`
  posting the shared action WITHOUT the business fields would silently reset business settings to
  defaults. The lead-form editor follows the finance-rate-columns pattern (deliberately its own action,
  writing ONLY `lead_form_config_json`). It includes a **"Copy embed snippet"** action that emits the
  iframe HTML (`?t=<token>`) with a freshly-signed embed token minted at the CURRENT `config.rev`.

A full form builder (arbitrary questions, ordering, types) is explicitly **out of scope** — it would
re-introduce the questionnaire system's untrusted-mapping surface for no v1 benefit.

---

## 6. Classification — EXACTLY (the review-sensitive core)

The single spot this repo's reviews keep catching. All three surfaces, stated precisely:

**D2 — CSP `frame-ancestors` carve-out (the ONLY `_worker.js` header change).** Today
`SECURITY_HEADERS` sets `frame-ancestors 'none'` + `x-frame-options: DENY` on every response
(`_worker.js:18` / `:16`), applied to every proxied response at `:688` and to error/429 responses at
`:383-390`. In the response-finalization block, AFTER `applySecurityHeaders` + `applyAppCsp` (i.e.
after `_worker.js:689`, so it WINS), add a carve-out scoped to the exact embed paths AND the submit
response on the schedule host:

```js
// Phase 19: the lead-form embed PAGE, its thanks page, AND the submit redirect/
// re-render response are the ONLY frameable surfaces, and ONLY by Tyler's
// marketing domains. Scoped to exact paths on the schedule host; every other
// route keeps frame-ancestors 'none' + x-frame-options DENY.
if (incomingUrl.hostname === "schedule.bythereeses.com" && isLeadFormFrameablePath(incomingUrl.pathname)) {
  responseHeaders.set(
    "content-security-policy",
    "base-uri 'self'; object-src 'none'; frame-ancestors 'self' https://bythereeses.com https://www.bythereeses.com; upgrade-insecure-requests",
  );
  responseHeaders.delete("x-frame-options"); // else DENY defeats frame-ancestors in some UAs
}
```

with `isLeadFormFrameablePath(pathname)` matching the EXACT dot-free paths plus the submit path:
```js
pathname === "/embed/lead" || pathname === "/embed/lead/thanks" || pathname === "/api/lead-form/submit"
```
Notes:
- (a) **must drop `x-frame-options`** — a lingering `DENY` blocks framing regardless of
  `frame-ancestors` in browsers that honor XFO.
- (b) the embed page is NOT proxy-cached (`canCachePublicBookingPage` `:515-522` only matches
  `/book/`), so there is no cache-HIT path to mirror. But because it is uncached AND mints a
  per-request nonce, the PAGE routes MUST be dynamically rendered — **§5/§8 mandate
  `export const dynamic = "force-dynamic"` + `cache-control: private, no-store` on BOTH the embed page
  and the thanks page** (MAJOR-2). Minting a nonce with `Date.now()`+`crypto` does NOT by itself opt a
  route out of Next's full-route cache; a cached embed page would freeze one `{issuedAtMs, id}` for all
  visitors → after `MAX_AGE_MS` every genuine submission is silently dropped (I9) and, within the
  window, two visitors share one `nonceId` → `webform:${nonceId}` dedup collision (`:533-537`) → the
  second lead discarded. Every other page in this repo already carries `force-dynamic` (40+ sites,
  e.g. `src/app/book/[slug]/page.tsx:11`); the embed pages MUST follow that convention.
- (c) **All USER-VISIBLE POST outcomes are 303 redirects** (§4/BLOCKER-2): success and bot-signal drop
  → `…/thanks`; validation error / stale nonce → back to `/embed/lead?t=<token>&error=…`. The form
  POSTs same-origin and the POST RESPONSE BECOMES THE FRAMED DOCUMENT (frame-ancestors/XFO apply to
  form-submission navigations), so a non-redirect body would render as a BLANK FRAME. The carve-out
  therefore ALSO covers `/api/lead-form/submit` (MAJOR-3) so the 303 (and any error re-render) carries
  the SAME relaxed `frame-ancestors` — browser handling of framing headers on 3xx inside a frame
  navigation is historically inconsistent, so this is pinned by test, not asserted. The thanks PAGE is
  itself framed and its path is in the carve-out; the only non-framed POST outcome is the raw `403`
  bad-token response (no page was ever legitimately rendered there).
- (d) **MINOR-8:** a `leadForm` `429` inside the iframe would otherwise render as a blocked document
  (`rateLimitResponse` ships `SECURITY_HEADERS` with `frame-ancestors 'none'`, `:383-390`). Because the
  429 is emitted for `/api/lead-form/submit`, the carve-out (which matches that path) relaxes its
  frame-ancestors too, so a rate-limited submit degrades visibly inside the frame rather than blanking.

**Proxy host gate (`isSchedulePublicPath`, `_worker.js:286-298`) — ADD** all three paths (EXACT,
dot-free), else the schedule-host gate 303-redirects them to the discovery-call booking page
(`:554-556`):
```js
pathname === "/embed/lead" ||
pathname === "/embed/lead/thanks" ||
pathname === "/api/lead-form/submit" ||
```
**Do NOT add to `isStudioPublicPath`** (`:224-284`) — that is the admin host; the lead form has no
business there.

**D3 — Rate-limit kinds (`rateLimitKind`, `_worker.js:306-362`) — a DEDICATED `leadForm` kind + a
`leadFormPage` GET kind.** Add to `RATE_LIMITS` (`:21-59`) `leadForm: { max: 10, windowSeconds: 600 }`
and `leadFormPage: { max: 60, windowSeconds: 60 }`, and match them BEFORE the `publicMutation` branch
(`:336-360`):
```js
if (request.method !== "GET" && pathname === "/api/lead-form/submit") return "leadForm";
if (request.method === "GET" && (pathname === "/embed/lead" || pathname === "/embed/lead/thanks")) return "leadFormPage";
```
Rationale (mirrors the twilio/inbound "own kind, not publicMutation" reasoning at `:36-51`): form-spam
volume is unrelated to booking volume, and a shared bucket would let one abuse the other. The embed GET
gets its OWN modest kind rather than `null` (MEDIUM-6): unlike the booking pages (proxy-cached 60s,
`:515-522`), the embed page is explicitly UNCACHED and every GET does origin SSR + an `app_settings`
read + an HMAC nonce mint, so an unmetered GET would be free origin-load amplification + unlimited
nonce farming.

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
if (path === "/embed/lead" || path === "/embed/lead/thanks") return false;
if (path === "/api/lead-form/submit") return false;
```
The signed embed token + nonce are the credentials, not the admin proof (comment it like `:199-221`).
Note these are the EXACT dot-free paths — the same paths the middleware page matcher now actually
matches (I7/BLOCKER-1); a dotted token-in-path would never reach this predicate at all.

Summary table:

| Surface | Setting | Value |
|---|---|---|
| Proxy schedule-host gate | `isSchedulePublicPath` | **ADD** `/embed/lead`, `/embed/lead/thanks`, `/api/lead-form/submit` (exact, dot-free) |
| Proxy admin-host gate | `isStudioPublicPath` | **unchanged** (wrong host) |
| Proxy rate limit | `rateLimitKind` / `RATE_LIMITS` | **ADD** `leadForm` (POST) + `leadFormPage` (GET) kinds (before `publicMutation`) |
| Proxy CSP | response finalize | **ADD** `frame-ancestors` carve-out + drop `x-frame-options` for `/embed/lead`, `/embed/lead/thanks`, AND `/api/lead-form/submit` |
| Origin guard | `PUBLIC_PAGE_PREFIXES` / `PUBLIC_API_PREFIXES` | **unchanged** (proxy-only; adding = dead code + wider surface) |
| Origin guard | in-route | submit route calls `guardDirectWorkerApiRequest` (defense-in-depth) |
| Admin proof | `adminProofRequired` | **ADD** exemptions for all three paths |

---

## 7. Migration — one additive nullable column (3-place mirror)

Migration number: **0097** (0095 = `questionnaire_autofill_review`, the current tail — verified
`migrations/` ends at `0095`). Phases 18, 19, 20 all originally claimed `0096`; by build order they
are assigned **18 → 0096, 19 → 0097, 20 → 0098**. **CAVEAT: the builder MUST confirm the next free
slot at build time (`grep`/`ls migrations/` for the tail) and renumber if 0096 was already taken by
Phase 18 landing first, or if another CR raced a `0097` in — the number is whatever the next free slot
actually is, not a hard-coded constant.**

```sql
-- 0097: Phase 19 embeddable lead-form config. Additive + idempotent. NON-CANONICAL:
-- this column holds a display/config artifact; losing it reverts to code defaults, no business state.
ALTER TABLE app_settings ADD COLUMN lead_form_config_json TEXT;
```

Mirror per repo convention (matches Phase 23 §7):
1. `migrations/0097_lead_form_config.sql` — the file above (renumber if the tail moved; see caveat).
2. `src/db/client.ts` — `addColumnIfMissing(database, "app_settings", "lead_form_config_json", "TEXT");`
3. `src/db/schema.ts` — add `leadFormConfigJson: text("lead_form_config_json")` to `appSettings`
   (`:208-231`).

**No new table. No change to `inbound_inquiries`** (web-form provenance rides in `parsed_json`, D4).
No index (config is read by the single settings row PK).

---

## 8. Task breakdown (ordered; effort / risk)

1. **Migration 0097 + 3-place mirror** (§7; confirm the next free slot at build time). Effort S / Risk L.
   Purely additive.
2. **Lead-form config module** (`src/lib/lead-form.ts`): `LeadFormConfig` type (incl. `rev:number`),
   defaults, `normalizeLeadFormConfig` (forces name/email/message on+required; runs
   `sanitizeLine`/`sanitizeBody` + caps on every string field, MEDIUM-3), `getLeadFormConfig`, and a
   **DEDICATED** settings-write path `updateLeadFormConfigFromForm` (separate action, NOT joined into
   `updateAppSettingsFromForm` — MINOR-9). Effort S / Risk L.
3. **Token module** (`src/lib/lead-form-links.ts`): `createLeadFormEmbedToken` (payload
   `{ v:1, formId, rev }`) / `verifyLeadFormEmbedToken` (verifies `rev` against config, MEDIUM-7)
   + `mintFormNonce` (`id: crypto.randomUUID()`, MEDIUM-1) / `verifyFormNonce` (timing + max-age 8 h,
   MAJOR-4), reusing the `questionnaire-links` HMAC helpers/secret. The token rides in `?t=` (query
   param, dot-free path, BLOCKER-1). Effort S / Risk M.
4. **`ingestWebFormInquiry`** in `src/lib/inbound-inquiry.ts` (§3) + the optional `origin` param on
   `draftFromInquiry` (D5, email path byte-for-byte). Effort M / **Risk H** — the I2/I3 invariant core;
   must reuse (not fork) caps/sanitizers/flood-guard/drafter, and never touch canonical writes.
5. **Embed page route** `/embed/lead` (GET, token in `?t=`) + `/embed/lead/thanks` (GET): verify embed
   token, render configured fields (ESCAPED text nodes only, MEDIUM-3) + honeypot + minted nonce;
   flag-off → `notFound()`. **BOTH pages MUST set `export const dynamic = "force-dynamic"` +
   `cache-control: private, no-store`** (MAJOR-2 — a cached page freezes the nonce → silent lead loss).
   Effort M / Risk M.
6. **Submit route** `/api/lead-form/submit` (POST): flag gate → token (+`rev`) → nonce/timing →
   honeypot → caps → `ingestWebFormInquiry`; ALL user-visible outcomes are **303s**: success/bot-signal
   → `…/thanks`, validation/stale → back to `/embed/lead?t=…&error=…` (BLOCKER-2); ONLY the bad-token
   outcome is a raw `403`. `guardDirectWorkerApiRequest` defense-in-depth. Effort M / **Risk H**.
7. **Proxy classification** (`_worker.js`, §6/D2/D3): `isSchedulePublicPath` += 3 exact paths;
   `leadForm` + `leadFormPage` rate kinds; `frame-ancestors` carve-out + `x-frame-options` drop for the
   two embed pages AND the submit response + `isLeadFormFrameablePath` helper. Effort M / Risk M (the
   review-sensitive one).
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
3. **Honeypot drop (I9, BLOCKER-2).** POST with `company_website` filled → **303 to `…/thanks`**
   (indistinguishable from success, NOT a `200` body), ZERO `inbound_inquiries` rows.
4. **Timing nonce (BLOCKER-2/MAJOR-4).** POST with nonce age `< MIN_FILL_MS` → bot signal → **303 to
   `…/thanks`**, no row; age within window → row created + **303 to `…/thanks`**; age `> MAX_AGE_MS`
   (8 h) → NOT dropped: **303 back to `/embed/lead?t=…&error=…`** re-rendering the form with a fresh
   nonce (assert the response is a 303 to an embed path, a row is NOT created, and NO lead is silently
   lost).
5. **Embed token gate.** POST with missing/tampered token → `403`, no row (the ONLY non-redirect
   outcome); valid token → proceeds. Token whose `rev` ≠ `config.rev` (revoked, MEDIUM-7) → `403`.
6. **Length caps (I5, MINOR-2).** Over-cap non-identity fields (phone/message) stored truncated to the
   inbound-inquiry caps (assert no stored field exceeds its cap). An over-cap/invalid REQUIRED identity
   field (email — `normalizeEmail` `:340-347` REJECTS over-cap by returning `null`, it does NOT
   truncate) → **303 back to the form with `?error=…`** (a validation re-render), NOT a silent
   null-email review row.
7. **Idempotent double-submit (B2 reuse).** Same nonce POSTed twice → single `inbound_inquiries` row
   (INSERT-OR-IGNORE on `webform:${nonceId}`), single agent task.
8. **CRM flood guard reuse.** Exceed `DOMAIN_HOURLY_INSERT_CAP` from one email domain → row
   auto-`status:"spam"`, no agent task. Additionally assert a health alert/count is emitted when the
   GLOBAL cap trips (MEDIUM-5 cross-channel visibility).
9. **Flag-off = no surface (I1).** `LEAD_FORM_ENABLED` unset → embed GET `404`, submit POST `404`,
   thanks GET `404`.
10. **Proxy + middleware classification drift pins (I4/I7).** Predicate pins on the EXACT dot-free
    paths: `isSchedulePublicPath("/embed/lead") === true`, `("/embed/lead/thanks") === true`,
    `("/api/lead-form/submit") === true`; `isStudioPublicPath("/embed/lead") === false`;
    `isPublicOriginBypassPath("/embed/lead") === false`;
    `isPublicOriginBypassApiPath("/api/lead-form/submit") === false` (Phase 24 dead-code trap);
    `rateLimitKind` for POST `/api/lead-form/submit` === `"leadForm"` and for GET `/embed/lead` ===
    `"leadFormPage"`; `adminProofRequired("/embed/lead") === false` and `("/api/lead-form/submit")
    === false`.
    **PLUS a REQUEST-LEVEL middleware-matcher test (BLOCKER-1 — the predicate pins above are false
    coverage otherwise):** assert `/embed/lead` IS matched by the middleware `config.matcher` (it is
    dot-free, so it is NOT excluded by the `.*\\..*` clause), and that a direct-origin request to
    `/embed/lead` lacking `x-reese-origin-secret` is 404'd by `guardDirectWorkerPageRequest` — exercising
    the matcher at request level, NOT just calling the predicate functions. Add a negative pin: a
    dotted path like `/embed/lead/<token-with-dot>` would be EXCLUDED from the matcher (documents why
    the token must be a query param).
11. **CSP framing carve-out pin (I6/MAJOR-3, `proxy-security.test.ts`).** A schedule-host response for
    `/embed/lead`, for `/embed/lead/thanks`, AND for `/api/lead-form/submit` (the 303 + the error
    re-render + a `leadForm` 429, MINOR-8) each has `content-security-policy` containing
    `frame-ancestors 'self' https://bythereeses.com https://www.bythereeses.com` and NO
    `x-frame-options`; a response for any OTHER path (e.g. `/book/...`) still has
    `frame-ancestors 'none'` + `x-frame-options: DENY`. (Drift pin so a future edit cannot silently
    widen — or narrow — framing.)
12. **Config (§5, BLOCKER-2).** `lead_form_config_json` NULL → default field set rendered; a field set
    `enabled:false` → its input absent from the embed HTML and ignored on POST; `name`/`email`/`message`
    forced on+required even if stored otherwise; a missing required field → **303 back to
    `/embed/lead?t=…&error=…`** (a re-render inside the carve-out, NEVER a `400`/blank-frame body).
13. **Rendering mode (MAJOR-2).** Two GETs of the SAME embed URL yield DIFFERENT nonce ids (assert the
    hidden nonce field differs between renders) — proves `force-dynamic` + `no-store` (a cached page
    would freeze one nonce → silent lead loss). Assert the embed and thanks responses carry
    `cache-control: private, no-store`.
14. **Config stored-XSS inert (MEDIUM-3).** A `<script>` (and `"><img onerror=…>`) in `introText`
    renders as ESCAPED text in the embed HTML (no live element/`dangerouslySetInnerHTML`); and
    `normalizeLeadFormConfig` sanitizes it on store.

Gate: `npm run lint` exit 0; `npm run build` EXIT=0 (type errors print after "Compiled successfully");
`npm test` all pass.

---

## 10. Rollout

- **Default:** `LEAD_FORM_ENABLED` unset ⇒ all three routes `404` (I1). No embed possible.
- **Enable:** apply migration 0097, set `LEAD_FORM_ENABLED=true`, configure fields in Settings, copy the
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
- **Framing allowed ONLY for Tyler's domains**, scoped to the exact embed-page paths (`/embed/lead`,
  `/embed/lead/thanks`) AND the submit response (`/api/lead-form/submit`, so the 303/error re-render
  never blanks the frame); every other route keeps `frame-ancestors 'none'` + `x-frame-options DENY`
  (I6). All user-visible POST outcomes are 303s to those paths (BLOCKER-2).
- **No CAPTCHA / no external service** — spam defense is honeypot + signed timing nonce + signed embed
  token (revocable via `rev`) + per-IP `leadForm`/`leadFormPage` limits + CRM flood guard + length
  caps, all in-house (§4). The token/nonce raise bot cost; the CRM flood guard + rate kinds + output
  ceiling are the real spam boundary.
- **No full form builder** — fixed field vocabulary with show/hide + required + copy customization only
  (§5).
- **One additive nullable column; no new tables; `inbound_inquiries` unchanged** — provenance rides in
  `parsed_json` (§3/§7).

---

## 12. Changelog

### Rev 2 — 2026-07-07
Applied two independent adversarial Fable reviews (both APPROVE WITH CHANGES, converged findings).
- **BLOCKER-1 (token-in-path defeats the middleware matcher):** moved the embed token to a `?t=`
  QUERY PARAM so the page paths (`/embed/lead`, `/embed/lead/thanks`) are DOT-FREE and actually matched
  by the Next middleware page matcher (`.*\\..*` excludes dotted paths) — I7 is now deliverable.
  Rewrote all §6 classification predicates to exact-path equality; added a REQUEST-LEVEL
  middleware-matcher test (§9 test 10) so the predicate pins are no longer false coverage. (§1 I7, §2,
  §6, §9.)
- **BLOCKER-2 (non-redirect POST responses blank the frame):** every USER-VISIBLE POST outcome is now
  a 303 to a carve-out-matched embed path (success/bot-signal → thanks; validation/stale → back to the
  form). Only the bad-token `403` is a non-redirect. (§1 I9, §4, §6 note (c), §9 tests 3/4/6/12.)
- **MAJOR-3 (submit 303 carried `frame-ancestors 'none'`):** widened the CSP carve-out to ALSO match
  `/api/lead-form/submit`; extended the §9 framing test to pin the submit path headers. (§1 I6, §6 D2.)
- **MAJOR-2 (rendering mode / cached nonce → silent lead loss):** mandated
  `export const dynamic = "force-dynamic"` + `cache-control: private, no-store` on both pages; added a
  two-GETs-differ nonce test. (§5, §6 D2 note (b), §8, §9 test 13.)
- **MAJOR-4 (30-min expiry misclassifies slow humans):** stale nonce now 303s back to a re-rendered
  form (never a silent drop); lengthened `MAX_AGE_MS` to 8 h (replay already neutralized by the
  `nonceId` dedup). (§4.2.)
- **MEDIUM-1 (`nonceId` entropy):** required `id: crypto.randomUUID()` in the signed nonce. (§3.3, §4.2.)
- **MEDIUM-3 (config stored-XSS):** mandated escaped-text-node rendering only (never
  `dangerouslySetInnerHTML`), `normalizeLeadFormConfig` sanitize+cap on store, and an inert-`<script>`
  test. (§5, §9 test 14.)
- **MEDIUM-5 (flood-guard cross-channel coupling):** documented the tradeoff; kept `isRateLimited`
  reused verbatim and required a health alert/count when the GLOBAL cap trips. (§4.6, §9 test 8.)
- **MEDIUM-6 (embed GET uncached + unmetered):** added a `leadFormPage` GET rate kind
  (`{ max: 60, windowSeconds: 60 }`). (§4.5, §6 D3.)
- **MEDIUM-7 (no token revocation):** added `rev` to the token payload AND `LeadFormConfig`; submit
  verifies `token.rev === config.rev`; "Copy embed snippet" mints the current rev. (§4.1, §5.)
- **MEDIUM-2 (migration collision):** assigned Phase 19 → migration **0097** (18→0096, 20→0098) with a
  build-time confirm-the-next-free-slot caveat. (§7, §8, §10.)
- **MINORs:** honesty on the reusable token / real spam ceiling (§4 threat-model note); over-cap email
  → 400 re-render not a null-email row (§9 test 6); separate dedicated settings action so lead-form
  config does not reset business settings (§5, §8); tightened D2 note (c) prose vs. its own regex;
  `leadForm` 429 exempted in the carve-out (§6 D2 note (d)).

### Rev 1 — 2026-07-07
Initial build-ready spec. Adds an embeddable, customizable lead-capture form that feeds the EXACT
existing inquiry-intake pipeline via a sibling `ingestWebFormInquiry` (review item only; zero new
canonical authority). Iframe embed on `bythereeses.com` with a `frame-ancestors` carve-out scoped to
the one embed page path (+ `x-frame-options` drop). Proxy-only classification on the schedule host
(`isSchedulePublicPath`, dedicated `leadForm` rate kind, `adminProofRequired` exemptions); origin-guard
bypass lists deliberately untouched (Phase 24 dead-code trap). In-house spam defense (signed embed
token + per-render timing nonce + honeypot + caps + CRM flood guard; no CAPTCHA). Config in
`app_settings.lead_form_config_json` (one additive column, migration 0096 — superseded → 0097 in
Rev 2). Dark behind `LEAD_FORM_ENABLED`. Awaiting adversarial Fable spec review.
