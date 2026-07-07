# Deploy checklist — pending dark work (run on Tyler's machine)

Copy-paste runbook for deploying everything currently built-but-undeployed on branch
`claude/reese-crm-production-qa-4caxz0`. All of it ships **inert** — every flag is off, so this
deploy is a zero-behavior-change no-op until you flip flags later. Run from the canonical working
copy (`/Volumes/reeseai-memory/04_Code/reese-photography-crm`), where the Cloudflare token lives.

**What this deploys (all dark unless noted):** Phase 14 (two-way project email) + Phase 21
(observability) + Phase 22 / CR-1 (project progress timeline) + CR-2 (settings nav group) +
CR-4 (scheduler Google Meet links) + CR-5 / Phase 23 (questionnaire autofill review) + Phase 17
(kanban pipeline board) + CR-6 / Phase 24 (Resend bounce/complaint webhook → suppressions) +
Phase 18 (AI daily brief) + Phase 19 (embeddable lead form) + Phase 20 (structured meeting notes) +
the CR-3 quick-find fix (unflagged bug repair — live on deploy) + the golden-path E2E test, config
preflight, and docs. Phases 12/15 are already live-dark from the previous deploy.

Every flag below is **off**, so this remains a zero-behavior-change no-op until you flip flags. The
only visible change on deploy is the CR-3 quick-find repair.

---

## 0. Pull the branch

```bash
cd /Volumes/reeseai-memory/04_Code/reese-photography-crm
git fetch origin claude/reese-crm-production-qa-4caxz0
git checkout claude/reese-crm-production-qa-4caxz0
git pull origin claude/reese-crm-production-qa-4caxz0
npm install
```

## 0.5 Mirror the docs to your local folder

```bash
npm run docs:local-sync
```

One-way mirror of `docs/` + `AGENTS.md`/`CLAUDE.md` to **`~/Documents/CLAUDE/Reeses-Studio`**
(override with `DOCS_SYNC_TARGET=/path`). Stamps `_SYNC-INFO.md` with the commit it came from.
Your own notes in that folder are untouched; only the mirrored `docs/` tree is kept exact. Run it
after every pull so the local copy never goes stale.

## 1. Preflight (backup freshness + drift gate)

```bash
npm run deploy:preflight        # fails if backup is stale (>36h) or source drift detected
npm run deploy:capture-versions # snapshot current Worker versions for rollback
```

If preflight fails on backup freshness, run your backup first (see
`docs/ops-stabilization-checklist.md`), then re-run.

## 2. Apply the new migrations to production D1 (additive, safe while dark)

```bash
npx wrangler d1 execute studio-bythereeses --remote --file migrations/0092_inbound_project_email.sql
npx wrangler d1 execute studio-bythereeses --remote --file migrations/0093_observability_heartbeat.sql
npx wrangler d1 execute studio-bythereeses --remote --file migrations/0094_scheduler_meet_link.sql
npx wrangler d1 execute studio-bythereeses --remote --file migrations/0095_questionnaire_autofill_review.sql
npx wrangler d1 execute studio-bythereeses --remote --file migrations/0096_daily_brief_narration.sql
npx wrangler d1 execute studio-bythereeses --remote --file migrations/0097_lead_form_config.sql
npx wrangler d1 execute studio-bythereeses --remote --file migrations/0098_meeting_notes_booking_link.sql
```

All seven are additive + safe while dark: 0092 inbound-email column, 0093 observability tables,
0094 `scheduler_bookings.meeting_join_url` (CR-4), 0095 `questionnaire_questions.semantic_key` +
`questionnaire_responses.suggested_changes_json`/`computed_at`/`content_hash` (Phase 23), 0096
`daily_brief_narrations` table (Phase 18), 0097 `app_settings.lead_form_config_json` (Phase 19),
0098 `project_communications.booking_id` + index (Phase 20). Order: migrations BEFORE the Worker
deploy so the new code never sees a missing column. (Phase 17 kanban and Phase 24 Resend webhook add
NO migration — they ship in the app-Worker deploy below.)

## 3. Deploy the app Worker (OpenNext)

```bash
npm run deploy
```

Ships (all inert while flags are off): Phase 14 send/inbound endpoints + UI, Phase 21 heartbeats +
`/api/agent/health` + `/system-status` health section, Phase 17 kanban board, Phase 18 daily-brief
section + `/api/agent/daily-brief-narrative`, Phase 19 `/embed/lead*` + `/api/lead-form/*` routes,
Phase 20 meeting-note composers, and the Phase 24 `/api/resend/webhook` route (no migration).

## 4. Deploy the Phase 14 inbound-email Worker (ships disabled)

```bash
npx wrangler deploy --config wrangler.project-email-inbound.jsonc
npx wrangler secret put INBOUND_PROJECT_EMAIL_SECRET --config wrangler.project-email-inbound.jsonc
# Generate the secret value with e.g.:  openssl rand -base64 32
# The SAME value must also be set on the app Worker:
npx wrangler secret put INBOUND_PROJECT_EMAIL_SECRET
```

Its `INTAKE_ENABLED` var is `"false"` — it forwards nothing and ingests nothing until enabled.
(The Email Routing rule in the Cloudflare dashboard is an enablement step, NOT part of this deploy.)

## 5. Deploy the Pages proxy (Phase 14 AND Phase 19 touched proxy composition)

```bash
npm run deploy:pages-proxy
```

Required this round: **Phase 19** adds the lead-form classification to `pages-proxy/_worker.js` —
three exact paths in `isSchedulePublicPath` (`/embed/lead`, `/embed/lead/thanks`,
`/api/lead-form/submit`), the `leadForm` + `leadFormPage` rate kinds, and the `frame-ancestors`
carve-out (self + `bythereeses.com` only) that lets the embed pages be iframed on Tyler's marketing
site. All inert until `LEAD_FORM_ENABLED` is set, but the proxy must ship so the routing/headers are
in place before the flag flips.

## 6. Smoke

```bash
node scripts/production-smoke.mjs
```

Expect green. The new `/api/agent/health` check needs `STUDIO_AGENT_API_TOKEN` in your env for the
smoke to exercise it.

## 7. Config-verification preflight (config-at-rest, not surface reachability)

```bash
npm run config:preflight
```

This is a **different question** than the smoke above: smoke proves the surfaces answer; this
proves every provider is actually *wired* — secrets present, Stripe/Resend/Twilio keys still
valid, the Stripe webhook endpoint subscribed at the right URL with the right events, and every
cron `*_ENDPOINT` pointed at the workers.dev origin (not the login-walled `studio.bythereeses.com`
host — the exact class of bug that silently no-oped the reminders cron for two months). It is
read-only (GET/HEAD only) and reads secrets from your local env, so run it on your machine where
`.env.local` / exported secrets live. It never prints a secret value. Exit code fails only when a
`REQUIRED` secret is missing or a provider check fails; dark-phase (`ENABLEMENT`-tier) secrets
render as "not yet enabled", not a failure. See
`docs/specs/phase-21-observability-alerting.md` §7 for how this relates to the Phase 21 runtime
heartbeats (this checks config-at-rest; Phase 21 checks whether jobs actually ran).

## 8. Do NOT deploy (these stay parked until you choose to enable)

- `wrangler.systems-monitor.jsonc` — the Phase 21 monitor cron Worker ships **un-wired** by design.
  Deploying it is step 2 of the Phase 21 enablement runbook (`docs/specs/phase-21-observability-alerting.md`
  §6), after you set `ALERT_EMAIL` + `MONITOR_ENABLED=1`.
- Any flag flips. Everything stays dark. Full off-by-default flag list as of this deploy:
  - `EMAIL_SENDING_ENABLED`, `INBOUND_PROJECT_EMAIL_ENABLED` (Phase 14) — read as `=== "true"`
  - `MONITOR_ENABLED` (Phase 21), `DAILY_BRIEF_ENABLED` (Phase 18, sub-toggle under MONITOR) — `=== "1"`
  - `UNIFIED_SIGN_PAY` (Phase 12), `PROJECT_PROGRESS_TIMELINE` (Phase 22/CR-1),
    `SETTINGS_NAV_GROUP` (CR-2), `SCHEDULER_MEET_LINKS` (CR-4),
    `QUESTIONNAIRE_AUTOFILL_REVIEW` (Phase 23/CR-5), `PROJECTS_BOARD_VIEW` (Phase 17),
    `MEETING_NOTES_ENABLED` (Phase 20) — all `=== "1"`
  - `LEAD_FORM_ENABLED` (Phase 19) — read as `=== "true"` (intake-family idiom, sibling of
    `isInquiryIntakeEnabled`); flag off ⇒ `/embed/lead*` + `/api/lead-form/submit` all 404
  - refund / Phase 9b money flags — all off (money-gated; first live refund waits for your go)
  - **Note the two idioms:** the intake family (`EMAIL_SENDING_ENABLED`,
    `INBOUND_PROJECT_EMAIL_ENABLED`, `LEAD_FORM_ENABLED`, Worker `INTAKE_ENABLED`) reads `"true"`;
    everything else reads `"1"`. This is pre-existing and intentional, not a typo.
  - (The CR-3 quick-find fix is the one unflagged change: a bug repair that goes live with the deploy.)

- **Phase 24 (Resend bounce/complaint webhook) is dark by config, not a flag.** It ships with the
  app Worker (no migration). To enable: (1) `wrangler secret put RESEND_WEBHOOK_SECRET` (the
  `whsec_…` signing secret from the Resend dashboard) on the app Worker; (2) in the Resend dashboard,
  subscribe a webhook for `email.bounced` + `email.complained` pointed at
  `https://studio.bythereeses.com/api/resend/webhook` (the proxied studio host, NOT the workers.dev
  origin). Until the secret is set the route 503s (recorded under the non-alerting
  `resend-webhook-unconfigured` key) — surfaced by `npm run config:preflight`, never a false alert.

## Rollback

`npm run deploy:rollback` restores the Worker versions captured in step 1. Migrations are additive
and safe to leave in place.

---

*After this deploy, the enablement runbooks (flag flips, secrets like `REPLY_TOKEN_SECRET`, the
Email Routing rule, the monitor Worker) are listed per-phase in `docs/roadmap-competitive-parity.md`.
Enable one thing at a time, watch, then the next.*
