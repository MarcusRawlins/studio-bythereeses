# Enablement plan — the ordered flag-flip runbook from "everything dark" to "everything on"

Owner: Tyler (single owner + single admin login). This is the one doc that says, in order, what to
turn on, why that order, what to watch, and how to back out. Written from a full read of
`docs/handoff-build-state.md`, `docs/roadmap-competitive-parity.md`, `docs/change-requests.md`,
`docs/deploy-next.md`, every `docs/specs/phase-*.md`, `docs/studio-agent-access.md`,
`docs/ops-stabilization-checklist.md`, and a grep of every `process.env.<FLAG>` actually read in
`src/`/`workers/` (not from memory — see "Full flag inventory" §6 for the derivation). Last updated
2026-07-07.

**How to use this doc:** work top to bottom. Each wave assumes the previous wave has been live and
watched for its stated window with no red flags. Nothing here is autonomous — every flip below is a
Tyler action (`wrangler secret put NAME`, value `"1"` unless noted). Rollback is always "unset the
var" unless stated otherwise, and is instant (no redeploy, no data loss) for every flag in this doc.

---

## 1. Wave summary (read this first)

| Wave | What | Flags | Risk | Watch | Rollback |
| --- | --- | --- | --- | --- | --- |
| 0 | Deploy the dark backlog (no flags flip) | — | none | — | `npm run deploy:rollback` |
| 1 | Harden + start watching | `CSP_MODE` (report→enforce), `ADMIN_PROOF_ENFORCE` (log→1), `MONITOR_ENABLED`+`ALERT_EMAIL`+`DEADMAN_PING_URL` + monitor Worker | low | 3–5 days | unset each var |
| 2 | Zero-risk admin-only UI | `PROJECT_PROGRESS_TIMELINE`, `SETTINGS_NAV_GROUP` | none (admin-only, no data change) | 2–3 days | unset each var |
| 3 | Let clients in | `PORTAL_MAGIC_LINK_ENABLED`, `PORTAL_GALLERY_ENABLED`, `INQUIRY_INTAKE_ENABLED` (+ intake Worker + Email Routing) | low–med (client-facing, no send) | 3–7 days | unset var(s); Worker `INTAKE_ENABLED=false` |
| 4 | Booking UX | `SCHEDULER_MEET_LINKS` (blocked — build in progress), `UNIFIED_SIGN_PAY` | low (no new money authority) | one live cycle + a few days | unset each var |
| 5 | Two-way client messaging (log→watch→enforce) | `SMS_ENABLED` → `SEQUENCES_ENABLED`+one per-type flag (draft) → one `*_AUTOSEND` → `EMAIL_SENDING_ENABLED` → `INBOUND_PROJECT_EMAIL_ENABLED` | med (real client-facing sends) | staged, days per stage | unset each var independently |
| 6 | Not yet buildable — no action | `QUESTIONNAIRE_AUTOFILL_REVIEW` (spec only), Phase 13 autopay (not built) | n/a | n/a | n/a |
| — | **DO NOT ENABLE YET** | `FINANCE_REFUND_RECORDING=enforce`, `REFUND_INITIATION_ENABLED` | **money movement** | Tyler's explicit go only | kill-switch: unset `REFUND_INITIATION_ENABLED` (does not undo issued refunds) |

Order logic: watch first (wave 1) so every later wave has eyes on it. Then the flags that change
nothing a client can see (wave 2) to build confidence in the flip-and-watch rhythm cheaply. Then the
surfaces that let clients reach the system at all (wave 3) — portal login, galleries, inbound triage
— none of which send anything unprompted. Then booking-flow UX (wave 4). Then the flags that make
the CRM actually talk back to clients, staged log→watch→enforce (wave 5). Money is last and gated
separately, off this sequence entirely, pending Tyler's own decisions.

---

## 2. Wave 0 — Deploy the dark backlog (no behavior change)

Everything below assumes the branch in `docs/deploy-next.md` has already been deployed. If it
hasn't: run that checklist first (migrations `0092`+`0093`, app Worker, Phase 14 inbound-email
Worker, Pages proxy, `node scripts/production-smoke.mjs`, `npm run config:preflight`). Every flag in
this doc ships inert as part of that deploy — flipping is a separate, later action per wave below.

---

## 3. Wave 1 — Harden + start watching

Do this first so every subsequent wave has a witness. Two of these three are Phase-6 hardening flags
that have been sitting dark since the 2026-07-05 deploy (not part of the newer phase backlog, but
found by the flag grep and worth closing now — see §7). The third is the Phase 21 observability
build.

### 1a. `ADMIN_PROOF_ENFORCE` (log → enforce)
- **What turns on:** a second, in-app admin-authorization check independent of the Pages-proxy
  Google session (`admin-proxy-auth.ts`). Currently unset = not evaluated at all.
- **User-visible change:** none when set to `"log"`; none when set to `"1"` either, *unless*
  something was silently relying on a hole this closes (see verification below).
- **Prerequisite:** `wrangler secret put ADMIN_PROOF_SECRET` (Worker) + the same value as a
  Pages-proxy env var, if not already set from the Phase 6 deploy.
- **Flip, staged:**
  1. `wrangler secret put ADMIN_PROOF_ENFORCE` = `"log"` → use the admin app normally for a few
     days.
  2. `wrangler tail` and watch for `[admin-proof] missing/invalid proof` on any *legitimate* admin
     path — each one is a classifier miss to fix before enforcing.
  3. Clean window → `wrangler secret put ADMIN_PROOF_ENFORCE` = `"1"`.
- **Verify:** admin pages still load normally under enforce; `npm run smoke:production` still green
  (`/refund/execute` etc. return 404 unauth as expected).
- **Rollback:** `wrangler secret delete ADMIN_PROOF_ENFORCE` — instant, reverts to session-only gate.
- **Why now, not later:** Phase 9b's money route later requires `ADMIN_PROOF_ENFORCE=1` +
  `ORIGIN_PROXY_SECRET` set as a **hard precondition** before it will be safe to enable (§8 below).
  Doing it here, watched for weeks before money is even considered, is strictly safer than doing it
  as a same-day pre-flight check right before the refund flag.

### 1b. `CSP_MODE` (report → enforce)
- **What turns on:** Content-Security-Policy on Studio + `/book/*`. `report` mode logs violations to
  the browser console without blocking anything; `enforce` actually blocks disallowed script/style.
- **User-visible change:** none in `report`; in `enforce`, any legitimate inline script/style not
  already allow-listed would break — that's exactly what the report window is for.
- **Flip, staged:**
  1. `wrangler secret put CSP_MODE` = `"report"` → load Studio + `/book/*` (twice, once for a cache
     HIT) with the browser console open; fix any violation.
  2. After a clean window → `CSP_MODE` = `"enforce"`.
- **Verify:** no console CSP violations on the core admin + booking pages after enforce.
- **Rollback:** unset `CSP_MODE` → back to baseline CSP (no `script-src`), instant.

### 1c. Observability (Phase 21) — `MONITOR_ENABLED` + `ALERT_EMAIL` + `DEADMAN_PING_URL`
- **What turns on:** an hourly `reese-systems-monitor` Worker that emails Tyler immediately on a
  CRITICAL signal (stuck refund, dead cron, failing webhook) and a daily green/amber digest. Reads
  (`/system-status`, `/api/agent/health`) are already always-on regardless of this flag.
- **User-visible change:** Tyler starts receiving one email/day (+ any CRITICAL alert) from the
  system's own address. No client-visible change at all.
- **Prerequisite:**
  - Apply migration `0093` to D1 if not already done (`docs/deploy-next.md` step 2).
  - Set `ALERT_EMAIL` (Tyler's inbox) as a Worker secret/var.
  - Deploy the monitor Worker: `wrangler deploy --config wrangler.systems-monitor.jsonc`; set its
    `CRON_SECRET`; confirm the cron schedule + `MONITOR_ENDPOINT` point at the **workers.dev origin**
    (never the login-walled `studio.bythereeses.com` host — the exact bug this phase exists to catch).
  - Set `MONITOR_ENABLED=1`.
  - **Recommended, not optional:** create a healthchecks.io (or UptimeRobot) "expect a ping every
    24h" check, set `DEADMAN_PING_URL`. Free, ~5 minutes. This is the only layer that survives the
    whole monitor dying — until it's set, `/system-status` and the digest footer both flag the gap.
- **Verify:** `/system-status` shows a new "Systems health" section, all green; wait for the first
  daily digest email; deliberately stale a job in a test window (pause reminders >6h) to confirm a
  CRITICAL email fires, then re-enable.
- **Rollback:** unset `MONITOR_ENABLED` → route returns `{skipped:'flag_off'}`, no more email. Reads
  stay live either way.
- **Watch:** 3–5 days. Confirm the daily digest actually arrives (an absent digest is itself the
  alarm per §4.3 of the spec — a dead monitor produces silence, not an error).

---

## 4. Wave 2 — Zero-risk admin-only UI flags

Neither of these touches client-visible surfaces, canonical data, or sends anything. Safe to flip
together once wave 1 is watching.

### 2a. `PROJECT_PROGRESS_TIMELINE` (CR-1 / Phase 22)
- **What turns on:** a read-time milestone progress bar/strip on `/projects` (compact) and
  `/projects/:id` (full strip) — derived from existing data, no writes.
- **Verify:** open a few projects at different stages; confirm milestones read as DUE/DONE/OVERDUE
  sensibly (a wedding 10+ days past with no sneak-peek gallery should show amber/overdue, not green).
- **Rollback:** unset the var — page renders exactly as before, zero extra queries when off.

### 2b. `SETTINGS_NAV_GROUP` (CR-2)
- **What turns on:** raises Settings in the left nav; folds Activity / Data Health / System Status
  into a Settings tab strip. All URLs stay unchanged (bookmarks + `app-surface-map.md` still work).
- **Verify:** confirm all three pages are still reachable (now under Settings), and that deep links
  to `/activity`, `/data-health`, `/system-status` still work directly.
- **Rollback:** unset the var — nav renders exactly as today.

**Watch:** 2–3 days of ordinary admin use. Nothing client-facing to monitor.

---

## 5. Wave 3 — Let clients in (portal + inbound triage)

**Note found during this review, not in the task's known-dark list:** `PORTAL_MAGIC_LINK_ENABLED`,
`PORTAL_GALLERY_ENABLED`, and `INQUIRY_INTAKE_ENABLED` are **all still OFF in production** per
`scripts/config-preflight.mjs`'s `ENABLEMENT`-tier catalog — even though the client portal and
inbound-inquiry intake are listed as "built" in `docs/handoff-build-state.md`'s Phase 1–11 summary.
In practice: **no client can log into the portal, no gallery link renders, and no inbound inquiry
email is triaged today** until these three are flipped. See §7.

### 3a. `PORTAL_MAGIC_LINK_ENABLED` (Phase 6.5)
- **What turns on:** `/portal/login` accepts an email, mints a single-use magic-link token per
  active project, emails it. Off today: the login page shows fallback copy and the POST is a no-op.
- **User-visible change:** clients can request a portal login link by email instead of only via a
  link Tyler sends manually.
- **Prerequisite:** none new — reuses `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `PORTAL_BASE_URL`,
  `ADMIN_SESSION_SECRET`. No new secret to generate.
- **Verify:** request a link for a known test client → email arrives → click → lands in `/portal`
  with the right project; request for an unknown email → identical "check your email" response (no
  enumeration); reuse the link → clean expired page.
- **Rollback:** unset `PORTAL_MAGIC_LINK_ENABLED` (or set `0`) — instant, no deploy.

### 3b. `PORTAL_GALLERY_ENABLED` (Phase 7a)
- **What turns on:** the "Your Gallery" section on the client portal, showing admin-pasted external
  gallery links (Pic-Time etc.). Admin CRUD + agent read stay always-on regardless of this flag, so
  Tyler can populate galleries dark first.
- **Prerequisite:** migration `0086` must already be applied (it is, per the Wave 0 deploy). Populate
  at least one project's gallery link via the admin UI *before* flipping, so there's something to see.
- **Verify:** as a test client, `/portal` shows the gallery link and it opens correctly; confirm
  `studio_get_project_context` (agent) still returns `galleries: []`/populated as expected.
- **Rollback:** unset the var — table + admin/agent read stay inert but harmless.

### 3c. `INQUIRY_INTAKE_ENABLED` (Phase 8a) + the intake Worker
- **What turns on:** email sent to `inquiries@bythereeses.com` is parsed into a triage row in
  `/inquiries` instead of just forwarding to a human inbox. Nothing is created (no project, no
  client, no email sent) until Tyler approves an item.
- **Prerequisite:**
  - Cloudflare Email Routing: catch-all rule for `inquiries@bythereeses.com` → Worker
    `reese-inquiry-intake` (dashboard config).
  - `wrangler secret put INBOUND_INTAKE_SECRET` on **both** the intake Worker and the app Worker
    (shared bearer).
  - Deploy the intake Worker with `INTAKE_ENABLED="false"` first (already the shipped default),
    confirm it forwards everything to a **verified** `INTAKE_FALLBACK` address.
  - Then flip `INTAKE_ENABLED="true"` (Worker var) and `INQUIRY_INTAKE_ENABLED="true"` (app var)
    together.
- **Verify:** send a real test inquiry to `inquiries@` from an external address → confirm it shows up
  in `/inquiries` and nothing (no project, no client, no send) happens until you click approve; send
  a garbage/spam email → confirm it lands in triage, not silently dropped, not auto-actioned.
- **Rollback:** flip either flag off → Worker forwards every message to `INTAKE_FALLBACK` again
  (flag-off = forward, never drop). Remove the Email Routing rule to fully revert.

**Also do now, no flag involved:** confirm the Stripe webhook endpoint is subscribed to
`charge.refunded` / `refund.created` / `refund.updated` / `charge.dispute.*`. Per the Phase 9a deploy
record, this was **not yet subscribed** as of the last deploy — meaning any refund/dispute Tyler
issues manually via the Stripe dashboard today is not being recorded in the CRM at all. This is safe
to fix immediately (`FINANCE_REFUND_RECORDING` stays at its default `record_only`; no status flip
happens yet) and removes a real blind spot well before the Phase 9b money wave needs it as a
precondition anyway.

**Watch:** 3–7 days. Check: portal logins succeed for real clients, no client sees another project's
data, gallery links render, inquiry triage rows appear correctly attributed, `/system-status` shows
the `inbound-inquiry` webhook signal green (no repeated failures).

---

## 6. Wave 4 — Booking UX

### 4a. `SCHEDULER_MEET_LINKS` (CR-4) — **not yet flip-ready**
- **Status:** the code exists in the working tree (`src/lib/scheduler.ts`, `src/app/scheduler/page.tsx`,
  `src/db/client.ts`, migration `0094_scheduler_meet_link.sql`) but is **uncommitted and untested** —
  still mid-build as of this writing. Do not flip until it lands with a green build gate + Fable
  diff review, per the standard loop.
- **What it will turn on (once shipped):** auto-generated per-booking Google Meet links (the Google
  Calendar OAuth full-calendar scope is already wired — no new vendor/secret/re-consent needed); Zoom
  stays as a fallback `locationType`. The client sees a working join link on the confirmation/manage
  pages and in reminder emails.
- **Verify (once merged):** book a real test consult, confirm the Meet link appears in the
  confirmation page, the manage page, and the reminder email, and that the calendar invite carries a
  working "Join" button.
- **Rollback:** unset `SCHEDULER_MEET_LINKS` — reverts to the static-Zoom-link behavior.

### 4b. `UNIFIED_SIGN_PAY` (Phase 12)
- **What turns on:** fuses proposal signature + retainer payment into one client flow (sign → pay in
  one pass) instead of sign-then-separately-pay. Reuses the existing checkout — not a new money
  authority, just a UX fusion.
- **User-visible change:** a client accepting a proposal with a retainer due goes straight into
  Stripe Checkout as part of accepting, instead of a separate later step.
- **Prerequisite:** none new.
- **Verify:** sign a live (or Stripe test-mode) proposal end-to-end — confirm exactly one payable
  Checkout session is created even if you double-click accept, confirm the webhook advances the
  project stage, confirm a `$0`/fully-settled proposal routes straight to confirmation with no
  checkout at all.
- **Rollback:** unset `UNIFIED_SIGN_PAY` — instant revert to sign-then-pay, no redeploy.

**Watch:** one full live cycle of each, then a few days of ordinary booking volume.

---

## 7. Wave 5 — Two-way client messaging (log → watch → enforce)

This is the wave with real client-facing sends. Stage it — each step below is independently
reversible, and each is meant to run for a few days before the next.

### 5a. `SMS_ENABLED` (Phase 8b) — start the Twilio provisioning NOW, it has lead time
- **What turns on:** the actual SMS transport. Drafting and `STOP`/`START` consent-handling are
  already live regardless of this flag; only sending is gated.
- **Prerequisite (Tyler, external, has multi-day lead time — start early):**
  1. Twilio account + an SMS-capable number (or Messaging Service).
  2. **US A2P 10DLC brand + campaign registration** — carrier requirement, unregistered traffic gets
     filtered. This step alone can take days; start it before you need the flag.
  3. Configure the number's Messaging webhook → `https://studio.bythereeses.com/api/twilio/inbound`
     and Status Callback → `…/api/twilio/status` (two distinct URLs).
  4. Enable Twilio Advanced Opt-Out on the Messaging Service.
  5. `wrangler secret put` `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`,
     `TWILIO_PUBLIC_WEBHOOK_URL_INBOUND`, `TWILIO_PUBLIC_WEBHOOK_URL_STATUS` — the two URL constants
     must be byte-identical to what's configured in the Twilio console (a mismatch is a designed-in
     403).
  6. `SMS_ENABLED=1`.
- **Verify:** send one consented test SMS to Tyler's own phone; reply `STOP` then `START`; confirm
  the `sms_suppressions` row appears/disappears, `clients.smsOptIn` flips both ways, delivery status
  logs via the status callback, and `/system-status` shows the Twilio webhook signals green.
- **Rollback:** `wrangler secret delete SMS_ENABLED` (or `0`) — transport no-ops instantly, drafts
  remain. Deleting the `TWILIO_*` secrets fails the transport closed as belt-and-suspenders.

### 5b. Sequences — draft-only first (Phase 8c)
- **What turns on:** `SEQUENCES_ENABLED=1` + **one** per-type flag (recommend `SEQUENCES_REVIEW=1`
  first — it's draft-only by design, no auto-send flag exists for it at all). Enrollments start
  evaluating and drafting messages for Tyler to review; nothing sends automatically at this stage.
- **Prerequisite:** confirm `RESEND_API_KEY`/`RESEND_FROM_EMAIL` set (already live). Set
  `UNSUBSCRIBE_SECRET` (app Worker) and `CRON_SECRET` on **both** the app Worker and the
  `reese-sequence-runner` worker. Deploy the runner: `wrangler deploy -c wrangler.sequence-runner.jsonc`,
  confirm `SEQUENCES_ENDPOINT` is the **workers.dev origin**, never the proxy host (pointing it at
  `studio.bythereeses.com` silently no-ops it — the exact class of bug Phase 21 exists to catch).
- **Verify:** enroll a fixture project, POST the cron manually with the bearer, confirm a draft
  appears and a ledger row is written; watch a full cycle of real drafts for correctness.
- **Watch:** several days of drafts before touching any autosend flag.
- **Rollback:** unset `SEQUENCES_ENABLED` (or the per-type flag) — runner no-ops, nothing enrolls or
  drafts.

### 5c. Sequences — flip ONE autosend flag, one type at a time
- Options: `SEQUENCES_DUNNING_AUTOSEND` (money-adjacent — payment reminders), `SEQUENCES_PREEVENT_AUTOSEND`
  (pre-event nudges). `SEQUENCES_REVIEW` has no autosend flag by design (always draft).
- **Only after** drafts from 5b have proven correct for that sequence type. Flip one, watch a full
  cycle, then consider the next.
- **Verify:** a real auto-sent email lands, unsubscribe link works, suppression list updates on
  unsubscribe, per-client weekly cap (`SEQUENCES_MAX_PER_CLIENT_PER_WEEK`, default 3) is respected.
- **Rollback:** unset the specific `*_AUTOSEND` flag — that sequence type reverts to draft-only; other
  sequence types unaffected.

### 5d. Two-way project email (Phase 14)
- **What turns on:** real outbound sends from the project Communications thread (`EMAIL_SENDING_ENABLED`),
  then inbound client replies routed into the same thread via a signed reply token
  (`INBOUND_PROJECT_EMAIL_ENABLED`).
- **Prerequisite:**
  - `wrangler secret put REPLY_TOKEN_SECRET` on the app Worker (fail-closed until set — outbound
    sends fine without it, just no reply-to token attached, so two-way stays dark until this is set).
  - Cloudflare Email Routing: add `inbox.bythereeses.com`, verify `INTAKE_FALLBACK`, add a catch-all
    rule `*@inbox.bythereeses.com` → Worker `reese-project-email-inbound`.
  - `wrangler secret put INBOUND_PROJECT_EMAIL_SECRET` on **both** the inbound Worker and the app
    Worker.
  - Deploy `wrangler.project-email-inbound.jsonc` with `INTAKE_ENABLED="false"` first (ships this
    way by default), confirm it forwards to a verified fallback.
- **Flip order:**
  1. `EMAIL_SENDING_ENABLED=1` → send one real email from a project thread → confirm delivery + the
     `reply_to` header carries a token.
  2. Reply to that email from the client side of a test project → confirm it forwards to
     `INTAKE_FALLBACK` (expected — inbound flag still off).
  3. Flip the Worker `INTAKE_ENABLED="true"` + app `INBOUND_PROJECT_EMAIL_ENABLED="true"` together →
     reply again → confirm it now lands in the right project thread instead of the fallback.
  4. Watch the fallback inbox for a while afterward for any unmatched/forwarded mail (a signal
     something's misrouting).
- **Verify:** unified thread UI shows both directions correctly; "Send email" button behaves per the
  content-hash approval gate (a post-review recipient swap refuses the send, not silently sends to
  the wrong address).
- **Rollback:** unset `EMAIL_SENDING_ENABLED` and/or `INBOUND_PROJECT_EMAIL_ENABLED` independently —
  outbound reverts to log-only "Mark sent"; inbound reverts to forward-to-human. Instant, no data
  loss (the Worker never silent-drops on any flag state).

**Watch, overall for wave 5:** several days per stage; `/system-status` webhook/inbound signals green
throughout; no client complaint of a message going to the wrong place.

---

## 8. Wave 6 — Not yet buildable (no action, informational only)

- **`QUESTIONNAIRE_AUTOFILL_REVIEW` (Phase 23 / CR-5).** Spec only (`docs/specs/phase-23-questionnaire-autofill-review.md`)
  — zero code exists yet (grep confirms no `QUESTIONNAIRE_AUTOFILL_REVIEW` reference in `src/`).
  Do not expect this flag to exist until it's built, Fable-reviewed, and deployed dark first.
  **Also flagged by the CR-5 investigation:** `updateQuestionnaireResponseAnswers` (called from the
  *unauthenticated* public submission route) currently mutates projects directly — a live guardrail
  violation the Phase 23 build is meant to fix. Not something to enable; something to watch land.
- **Phase 13 — autopay/card-on-file.** Not built at all (listed as "MISSING" in the roadmap). Nothing
  to flip; money-gated like 9b when it exists.
- **Phase 16 mini-sessions, 17 kanban, 18 AI daily brief, 19 lead form, 20 meeting notes** — not built.
  Nothing to enable.
- **`PWA_SERVICE_WORKER`** — referenced only in a test-file comment as a future deferred flag; no
  gating code exists yet. The PWA manifest itself (installability) is already live and unflagged.

---

## 9. DO NOT ENABLE YET — money-gated (Phase 9b)

**`FINANCE_REFUND_RECORDING`** (currently defaults to `record_only` in prod — recording of
refund/dispute webhook data is already live and safe; only the *status flip* to `refunded` is gated)
and **`REFUND_INITIATION_ENABLED`** (currently OFF — the only code in the app that can call Stripe's
mutating `POST /v1/refunds`) **stay off pending Tyler's explicit go, per the standing guardrail: any
code that moves real money stops before the first live action.**

### Two open policy questions — restate and confirm before flipping anything here
1. **Is the non-refundable retainer identified by label OR earliest payment (as built), or
   label-only?** As built: a payment is blocked from 9b refund if its label matches
   `/\b(retainer|deposit)\b/i` **or** it is the earliest payment on the invoice — meaning a
   **single-payment (lump-sum) invoice is non-refundable through 9b** even if unlabeled. If Tyler
   wants lump-sum invoices refundable, this predicate needs narrowing to ≥2-payment invoices first.
2. **Are processing fees passed to the client on the service portion only (as built), or the full
   (gross) amount?** As built: the refundable ceiling is the service portion (`paidAmountCents`) —
   a refund never returns the client's card-processing fee. If Tyler actually wants the client made
   whole on the gross amount (fee included), the ceiling formula must change before go.

### Preconditions (all must be true, in this order, before `REFUND_INITIATION_ENABLED=1`)
1. **PRECONDITION AUTH-ARMED.** Confirm `ORIGIN_PROXY_SECRET` is set at the Worker **and**
   `ADMIN_PROOF_ENFORCE=1` (wave 1a above) — both guards fail **open** when unset, so an unauthenticated
   `POST …/refund/execute` on the `*.workers.dev` origin would otherwise be reachable directly. Run
   `npm run smoke:production` and confirm the refund/execute route returns **404** unauthenticated.
2. **PRECONDITION WEBHOOK.** Confirm the Stripe endpoint is subscribed to `charge.refunded`
   specifically (not just "refund events" generally) — this is the load-bearing event; without it,
   money moves but the summary column and status flip never happen. (Do this now anyway — see the
   wave 3 note above, it's a zero-risk fix regardless of 9b timing.)
3. **PRECONDITION ENFORCE.** Set `FINANCE_REFUND_RECORDING=enforce` — otherwise a full refund moves
   real money but the payment still reads `paid` in the app (temporarily wrong books).
4. **PRECONDITION TEST-TARGET.** Pick one small, known-safe Stripe test/real charge Tyler controls
   for the very first refund. Watch it end to end: initiation `succeeded` → `charge.refunded` webhook
   lands → `payment_refunds` row + `refunded_amount_cents` update → (at enforce) status flip.

### Then, and only then
- Flip `REFUND_INITIATION_ENABLED=1`.
- Tyler issues the first real refund, in the admin UI, with the typed-amount confirmation.
- **Refunds are irreversible at Stripe.** The kill-switch (`wrangler secret delete
  REFUND_INITIATION_ENABLED`) stops future refunds only — it cannot claw back money already sent.

---

## 10. Full flag inventory (derived from `process.env.<NAME>` reads in `src/`/`workers/`, cross-checked against `scripts/config-preflight.mjs`'s ENABLEMENT tier)

| Flag | Phase | Wave | Default |
| --- | --- | --- | --- |
| `CSP_MODE` | Phase 6 hardening | 1b | off (baseline CSP) |
| `ADMIN_PROOF_ENFORCE` | Phase 6 hardening | 1a | unset = not evaluated |
| `MONITOR_ENABLED` / `ALERT_EMAIL` / `DEADMAN_PING_URL` | 21 | 1c | off |
| `PROJECT_PROGRESS_TIMELINE` | 22 / CR-1 | 2a | off |
| `SETTINGS_NAV_GROUP` | CR-2 | 2b | off |
| `PORTAL_MAGIC_LINK_ENABLED` | 6.5 | 3a | off |
| `PORTAL_GALLERY_ENABLED` | 7a | 3b | off |
| `INQUIRY_INTAKE_ENABLED` / Worker `INTAKE_ENABLED` | 8a | 3c | off |
| `SCHEDULER_MEET_LINKS` | CR-4 | 4a | off (build in progress, not committed) |
| `UNIFIED_SIGN_PAY` | 12 | 4b | off |
| `SMS_ENABLED` | 8b | 5a | off |
| `SEQUENCES_ENABLED` / `SEQUENCES_DUNNING` / `SEQUENCES_PREEVENT` / `SEQUENCES_REVIEW` | 8c | 5b | off |
| `SEQUENCES_DUNNING_AUTOSEND` / `SEQUENCES_PREEVENT_AUTOSEND` | 8c | 5c | off (draft) |
| `EMAIL_SENDING_ENABLED` / `INBOUND_PROJECT_EMAIL_ENABLED` / `REPLY_TOKEN_SECRET` | 14 | 5d | off |
| `QUESTIONNAIRE_AUTOFILL_REVIEW` | 23 | 6 (not built) | n/a |
| `FINANCE_REFUND_RECORDING` | 9a | money-gated | `record_only` (recording live; `enforce` gated) |
| `REFUND_INITIATION_ENABLED` | 9b | money-gated | off |

Not a feature flag but load-bearing infra already assumed live: `ORIGIN_PROXY_SECRET`,
`ADMIN_SESSION_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`,
`CRON_SECRET`, `SCHEDULER_LINK_SECRET`, `STUDIO_AGENT_API_TOKEN`, `GOOGLE_CLIENT_ID/SECRET` — see
`scripts/config-preflight.mjs`'s `REQUIRED` tier and run `npm run config:preflight` at any point in
this rollout to confirm none of these have drifted.
