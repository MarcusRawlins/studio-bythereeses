# Competitive-parity roadmap (Phases 12+)

Gap analysis vs **HoneyBook**, **Dubsado**, **SwiftBooks** (2026), grounded in a codebase audit
(what we already have) + current competitor research. Phases 1–11 are built/deployed dark; this
doc plans the genuine gaps. Same autonomous loop: spec → Fable review → build → Fable review →
deploy **dark** → Tyler enables.

## Where we already lead (do NOT rebuild)
- **Finance depth** — refund/dispute recording, refund initiation, QBO/Xero export, quarterly tax
  estimate, 1099, mileage (Phase 9a/9b). Competitors' bookkeeping is "basic".
- **Intelligence/forecasting** — revenue forecast, conversion, lead-source, package-value, seasonal,
  weekly AI business review (Phase 10). Beyond competitors' reporting.
- **AI agent + MCP**, automation sequences, contracts + e-sign + audit trail, questionnaires,
  strong per-project client portal, two-way SMS w/ consent, security/compliance rigor.

## The genuine gaps (prioritized)

### Tier 1 — highest leverage
- **Phase 12 — Unified accept-sign-PAY.** ✅ **DEPLOYED dark 2026-07-06** (Worker `f7d81faa`, flag
  `UNIFIED_SIGN_PAY` off). Signature → retainer Stripe checkout fused into one client flow; reuses the
  existing client checkout (not money-movement-gated). Shared `retainer-selection.ts` (factored the
  predicate; 9b now imports it, behavior-identical). Spec Fable-gated ×2 (caught a concurrent
  double-charge race → fixed with a `link_ready` CAS + canonical-URL convergence + expire-and-remint),
  code Fable-gated ×1 (APPROVE + 5 minors fixed). Enable `UNIFIED_SIGN_PAY=1` when ready.
- **Phase 13 — Autopay / card-on-file.** MISSING today: every installment is a manual checkout
  link → dunning. Add a Stripe Customer + SetupIntent (card on file) + **off-session auto-charge**
  of scheduled installments. ⚠️ **MONEY MOVEMENT** (auto-charges a real card) — build dark behind a
  flag; enable + first auto-charge need Tyler's explicit go + a money-math/idempotency Fable gate,
  exactly like Phase 9b. Highest dunning-reduction payoff.

### Tier 2 — high value
- **Phase 14 — Two-way per-project email.** ✅ **BUILT + Fable-reviewed + pushed dark 2026-07-06**
  (branch `claude/reese-crm-production-qa-4caxz0`, commits `cbba1d5` + `bff7fac`). Outbound
  project-thread send (Resend, "agents draft, Tyler sends", recipient-bound content-hash approval) +
  inbound client-reply routing via a project-bound reply token (envelope-recipient-only, append-only,
  thread-scoped dedupe) → unified email+SMS inbox. Reuses `project_communications` + email infra.
  Adversarial Fable security review of the inbound boundary: **APPROVE WITH FIXES** — no BLOCKER/MAJOR
  (could not forge a token, cross projects, override the envelope via a header, bypass auth, or force a
  silent drop); M1 (subject HTML-neutralization) + m2 (byte-length gate) applied. Build gate green
  (lint/build/209 tests exit 0). Flags **off**: `EMAIL_SENDING_ENABLED`, `INBOUND_PROJECT_EMAIL_ENABLED`,
  Worker `INTAKE_ENABLED="false"`.
  **Dark-deploy runbook (run where the Cloudflare token lives — NOT this remote env, which has no CF
  creds):** (1) apply migration `0092_inbound_project_email.sql` to D1; (2) `npm run deploy` (app Worker
  via OpenNext); (3) `wrangler deploy --config wrangler.project-email-inbound.jsonc` (the Email Routing
  Worker) + set `INBOUND_PROJECT_EMAIL_SECRET` via `wrangler secret put`; (4) `npm run deploy:pages-proxy`
  (proxy composition). All four ship inert while the flags stay off. Enablement (set `REPLY_TOKEN_SECRET`,
  a VERIFIED `INTAKE_FALLBACK`, then flip the flags) stays with Tyler.
- **Phase 15 — PWA / installable mobile.** ✅ **DEPLOYED 2026-07-06** (Worker `16f5e766`, proxy
  `76d552af`) — manifest v1 is LIVE + installable (Add-to-Home-Screen works on iPhone now; inert static
  metadata, zero behavior change). Icons + apple meta + `Viewport`; `/manifest.webmanifest` reachable
  unauthenticated (200, `application/manifest+json`) while `/clients`/`/api/*` stay walled. Spec + code
  Fable-gated ×2 (APPROVE). The **service worker is deferred** behind `PWA_SERVICE_WORKER` (a later
  phase — its default-deny cache policy needs its own build+gate; the spec's unimplementable SW guards
  were corrected). Offline shell + web push = future.
- **Phase 16 — Mini-session day booking.** MISSING: scheduler is strictly 1:1. Add capacity-based
  session-day slots (publish a day, N bookable slots, clients grab distinct times, optional
  deposit-at-booking). New revenue line for portrait mini-sessions. **Business-dependent — confirm
  Tyler runs mini-sessions before enabling; cheap to ship dark.**

### Tier 3 — UX / reach
- **Phase 17 — Kanban pipeline board.** ✅ **BUILT + Fable-reviewed + pushed dark** behind
  `PROJECTS_BOARD_VIEW`. Visual drag-and-drop lead→booked board over the existing stage data
  (`listProjectBoardIndex`: count(distinct) + `BOARD_MAX_ROWS` cap + dedupe; login-bounce success
  predicate). UI-only, no migration.
- **Phase 18 — AI daily brief.** ✅ **BUILT + Fable-reviewed (APPROVE WITH FIXES, MAJOR-1 applied) +
  pushed dark 2026-07-07** (commit `19438a2`) behind `DAILY_BRIEF_ENABLED` (a sub-toggle under
  `MONITOR_ENABLED`). An AI-narrated "what needs you today" folded into the Phase 21 systems digest —
  no second cron/Worker/email. Narration arrives out-of-band via a bearer-authed
  `/api/agent/daily-brief-narrative` (control-char-strip → secret-redact → cap, so a self-narrated
  secret can't reach the email); milestone signal pages `listProjectIndex` in full (no truncation);
  zero canonical writes (guard-tested). Migration `0096_daily_brief_narration.sql`.
- **Phase 19 — Embeddable lead-capture form.** ✅ **BUILT + two Fable spec reviews + Fable diff
  review (APPROVE, MINORs applied) + pushed dark 2026-07-07** (commit `688a8b9`) behind
  `LEAD_FORM_ENABLED`. A public, iframe-embeddable inquiry form on the schedule host feeding the exact
  existing intake pipeline via `ingestWebFormInquiry` — staging row + authority-less review task only,
  never a canonical project. Token in a `?t=` query param (dot-free paths so the middleware matcher
  isn't bypassed); every user-visible POST outcome is a 303 to a carve-out-matched embed path (nothing
  blanks the iframe); escaped-only config render; `rev`-counter revocation. Migration
  `0097_lead_form_config.sql`. **Highest-risk surface in the backlog — built on Opus, reviewed hardest.**
- **Phase 20 — Structured meeting/consult notes.** ✅ **BUILT + Fable-reviewed (APPROVE, MINORs
  applied) + pushed dark 2026-07-07** (commit `bad0717`) behind `MEETING_NOTES_ENABLED`. Per-consult
  notes tied to the specific `scheduler_bookings` row, on both the project and booking pages, reusing
  `project_communications` "note" rows + one nullable `booking_id` link column. The linkage authority
  is never agent-writable at create OR update (a shared-core guard blocks an agent from forging a
  booking-linked note). Migration `0098_meeting_notes_booking_link.sql`.

## Confidence foundation (cross-cutting, not a parity feature)
- **Phase 21 — Observability + failure alerting.** ✅ **BUILT + Fable-reviewed + pushed dark 2026-07-07**
  (branch `claude/reese-crm-production-qa-4caxz0`, commits `462c4b2` + `e46f129`). The motivating
  incident: the reminders cron silently sent nothing for ~2 months because it read a login-wall `200`
  as success. This adds an in-DB heartbeat (`job_runs`), a `computeSystemHealth` catalog, a daily
  digest + immediate-critical email, an hourly `reese-systems-monitor` Worker, `/api/agent/health`,
  and a `/system-status` health section — so a silent job failure surfaces within a day, not two
  months. Adds no attack surface, moves no money, mutates no canonical row, emails only the owner's
  own address. Adversarial Fable review: **APPROVE WITH FIXES** — no BLOCKER/invariant violation; 2
  MAJOR + 4 MEDIUM fixed (all in the "the alerting layer must not fail silently itself" class: a
  failed critical email no longer gets permanently deduped away; a dead Resend key now trips the
  fail-loud path + dead-man switch instead of reading green). Build gate green (lint/build/216 tests
  exit 0). Off by default: `MONITOR_ENABLED` gates every autonomous email; the monitor Worker ships
  un-wired. Migration `0093_observability_heartbeat.sql` (renumbered — the spec's `0092` was taken by
  Phase 14).
  **Dark-deploy runbook (run where the Cloudflare token lives — not this remote env):** (1) apply
  migration `0093` to D1 (idempotent `CREATE TABLE IF NOT EXISTS`); (2) `npm run deploy` (app Worker —
  ships `recordJobRun` heartbeats, `system-health`, `/api/agent/health`, `/system-status` section, all
  inert while `MONITOR_ENABLED` is off). The monitor Worker + digest stay **un-wired** until the Tyler
  enablement runbook (spec §6): set `ALERT_EMAIL` + `MONITOR_ENABLED=1`, deploy
  `wrangler.systems-monitor.jsonc`, and (recommended) create a healthchecks.io dead-man check + set
  `DEADMAN_PING_URL`. Note: once required-job crons are enabled, `/system-status` will show them red
  until their first successful run — that is the intended "never ran" surfacing, not a bug.

## Sequencing
12 (convert) → 15 (PWA, quick win) → 14 (email) → 13 (autopay, money-gated) → 16 (mini-sessions) →
17 (kanban) → 18 (daily brief) → 19 (lead form) → 20 (notes). Each independently shippable + dark.
Money-movement (13, and any deposit-at-booking in 16) pauses at first live charge for Tyler's go.

## Change requests (Tyler's live edits — see docs/change-requests.md)
- **CR-1 / Phase 22 — Project progress / milestone timeline.** ✅ BUILT + Fable spec-review (REVISE
  → rev 2) + Fable diff-review (APPROVE WITH FIXES, all applied) + pushed dark 2026-07-07 behind
  `PROJECT_PROGRESS_TIMELINE`. Read-time milestone projection (detail strip + list bar); dates mark
  DUE, data marks DONE, date-passed-without-data = OVERDUE. Void/draft invoices excluded from the
  overdue scan (a voided-and-reissued invoice can't falsely amber a healthy project); flag-off adds
  zero queries. Gate green (220 tests). Enable = set the var.
- **CR-3 — Quick-find dialog rendered under the nav.** ✅ FIXED + pushed 2026-07-07 (unflagged bug
  repair): dialog portals to document.body; ⌘K bound to the single desktop instance. Live on deploy.
- **CR-2 — Left-nav: raise Settings, fold Activity/Data Health/System Status under it.** In build
  (dark behind `SETTINGS_NAV_GROUP`).
