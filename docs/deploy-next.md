# Deploy checklist — pending dark work (run on Tyler's machine)

Copy-paste runbook for deploying everything currently built-but-undeployed on branch
`claude/reese-crm-production-qa-4caxz0`. All of it ships **inert** — every flag is off, so this
deploy is a zero-behavior-change no-op until you flip flags later. Run from the canonical working
copy (`/Volumes/reeseai-memory/04_Code/reese-photography-crm`), where the Cloudflare token lives.

**What this deploys:** Phase 14 (two-way project email, dark) + Phase 21 (observability, dark) +
Phase 22 / CR-1 (project progress timeline, dark) + CR-2 (settings nav group, dark) + the CR-3
quick-find fix (unflagged bug repair — live on deploy) + the golden-path E2E test, config preflight,
and docs. Phases 12/15 are already live-dark from the previous deploy.

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
```

All four are additive + idempotent (`IF NOT EXISTS` / new columns + indexes): 0092 inbound-email
column, 0093 observability tables, 0094 `scheduler_bookings.meeting_join_url` (CR-4), 0095
`questionnaire_questions.semantic_key` + `questionnaire_responses.suggested_changes_json`/
`computed_at`/`content_hash` (Phase 23). Order: migrations BEFORE the Worker deploy so the new code
never sees a missing column.

## 3. Deploy the app Worker (OpenNext)

```bash
npm run deploy
```

Ships (all inert while flags are off): Phase 14 send/inbound endpoints + UI, Phase 21 heartbeats +
`/api/agent/health` + `/system-status` health section.

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

## 5. Deploy the Pages proxy (Phase 14 touched proxy composition)

```bash
npm run deploy:pages-proxy
```

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
- Any flag flips. Everything stays dark: `EMAIL_SENDING_ENABLED`, `INBOUND_PROJECT_EMAIL_ENABLED`,
  `MONITOR_ENABLED`, `UNIFIED_SIGN_PAY`, `PROJECT_PROGRESS_TIMELINE`, `SETTINGS_NAV_GROUP`,
  `SCHEDULER_MEET_LINKS`, `QUESTIONNAIRE_AUTOFILL_REVIEW`, `PROJECTS_BOARD_VIEW`,
  refund/9b flags — all off. (The CR-3 quick-find fix is the one unflagged change: a bug repair
  that goes live with the deploy.)

## Rollback

`npm run deploy:rollback` restores the Worker versions captured in step 1. Migrations are additive
and safe to leave in place.

---

*After this deploy, the enablement runbooks (flag flips, secrets like `REPLY_TOKEN_SECRET`, the
Email Routing rule, the monitor Worker) are listed per-phase in `docs/roadmap-competitive-parity.md`.
Enable one thing at a time, watch, then the next.*
