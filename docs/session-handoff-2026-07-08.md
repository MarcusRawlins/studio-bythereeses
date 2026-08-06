# Session handoff — autonomous build session ending 2026-07-08

The session that built Phases 13/17/18/19/20/24/25 + CR-1..CR-6 is being deleted. This file captures
everything from that session that is NOT already in the standing docs, plus pointers to where
everything else lives. Read `docs/handoff-build-state.md` FIRST — it is the operating manual; this
file is the session-specific residue.

## 1. Exact state at session end

- **Branch:** `claude/reese-crm-production-qa-4caxz0` at `e1e5f80`, fully pushed, working tree clean.
  Nothing uncommitted, nothing in-flight. Final gate: **240/240 tests, lint 0 errors, build exit 0.**
- **Migrations tail:** `0099_autopay_card_on_file.sql`. The next free slot is **0100** — always
  re-verify with `ls migrations/ | tail` before claiming a number (three specs once collided on 0096;
  the fix is assignment + a build-time free-slot check, now standard practice).
- **Nothing has been deployed from this session.** The remote build env has no Cloudflare
  credentials by design. Every deploy happens on Tyler's mac-mini (canonical working copy
  `/Volumes/reeseai-memory/04_Code/reese-photography-crm`) via `docs/deploy-next.md` — currently a
  one-pass runbook covering migrations 0092–0099 and everything built since the last deploy.

## 2. What Tyler must do next (in order)

1. Pull the branch on the mac, `npm install`, `npm run docs:local-sync` (mirrors docs to
   `~/Documents/CLAUDE/Reeses-Studio`).
2. Run `docs/deploy-next.md` top to bottom (preflight → migrations 0092–0099 → app Worker →
   inbound-email Worker → pages-proxy → smoke → `npm run config:preflight`). Everything ships inert;
   the only visible change is the CR-3 quick-find fix.
3. Flip flags **one at a time**, watching between each — per-feature enablement runbooks live in
   `docs/roadmap-competitive-parity.md`.
4. **Autopay go-live is special** (spec §7 runbook): deploy dark → `AUTOPAY_ENABLED=1` with the
   default `log_only` mode → watch a full dry billing cycle (would-charge rows, zero Stripe calls)
   → explicit go → `AUTOPAY_CHARGE_MODE=live` with a low `AUTOPAY_MAX_CHARGE_CENTS` + one-project
   `AUTOPAY_PILOT_ALLOWLIST`. The autopay cron Worker (`wrangler.autopay-charge.jsonc`) is an
   ENABLEMENT step, not part of the dark deploy.
5. Answer the one open business question: **does Tyler run mini-session days?** (Phase 16 is the
   only unbuilt parity item; cheap to build if yes, deprioritize if no.)
6. Confirm the reminders cron returns 200 on a live tick (the original silent-failure incident —
   pre-existing open item).

## 3. Post-merge follow-ups the reviewers flagged (small, non-blocking — good first tasks)

- **Autopay tripwire-4 age** (`src/lib/autopay-charge.ts` reconciliation): the "paid at Stripe,
  unrecorded" CRITICAL ages off `updatedAt`, which the hourly settle-retry loop refreshes — under a
  persistent partial Stripe outage the signal can hover under threshold. Age it off first-abort
  time/`createdAt` instead.
- **Autopay module cycle**: `autopay-charge.ts` ⇄ `autopay-webhook.ts` cross-import
  (function-body-only, verified safe under ESM). Optional hygiene: extract the shared
  `runManualFallbackSideEffects` into a third `autopay-fallback.ts`.
- **Autopay rollback runbook line**: flipping `AUTOPAY_ENABLED` off mid-flight also hides in-flight
  `charging` tripwires and drops autopay webhooks — reconcile in-flight rows BEFORE a full revert.
- **Deliverability nits** (accepted, not fixed): `assertNoListUnsubscribe` doesn't also assert
  `List-Unsubscribe-Post` absence; the generic WEBHOOK_JOBS template phrases a tripped cap as
  "failing" (the detail string carries the real message).
- **Phase 6 deferred follow-ups** — pre-existing task, see `docs/specs/phase-6-*` deferred list.

## 4. Hard-won process rules (verified by incidents this session — do not relearn)

- **The review gate catches real money bugs.** Autopay's five-round chain caught: a cross-channel
  double-charge (manual link + autopay racing), a dry-run/live ledger contradiction, a session-read
  fail-open, amount-drift overcharge, a cap bypass via the `aborted_ineligible` re-claim, and an
  unreachable cron. Every finding had a concrete money scenario. NEVER skip the chain for
  money/security code: spec → Fable review → revise → verify → build → independent gate →
  money-grade diff review → fix → re-verify by the SAME reviewer (SendMessage keeps its context).
- **Independent gate always**: re-run lint/build/tests in the main loop; check `npm run build`'s
  EXIT CODE (type errors print after "Compiled successfully" and exit 1). `npm test` (not bare
  `node scripts/run-tests.mjs` — tsx needs npm's bin path).
- **Commit discipline**: never `git add -A` while a build agent is editing; stage exact paths.
  Serialize builds that share `migrations/`, `src/db/schema.ts`, `src/db/client.ts`,
  `src/lib/job-runs.ts`, `src/lib/system-health.ts`, `src/lib/sequences.ts` — parallel specs/reviews
  are fine, parallel builds on shared files are not.
- **Model tiering** (`handoff-build-state.md` §3): Haiku mechanical, Sonnet standard builds +
  spec revisions, Opus money/security specs + builds + fix passes, Fable every adversarial review.
- **Two flag idioms coexist** (intentional): the intake family (`EMAIL_SENDING_ENABLED`,
  `INBOUND_PROJECT_EMAIL_ENABLED`, `LEAD_FORM_ENABLED`, Worker `INTAKE_ENABLED`) reads `"true"`;
  everything else reads strict `"1"`. Match the sibling family; never "fix" the split.
- **Classification traps** (repeat offenders): `PUBLIC_API_PREFIXES` feeds ONLY the page guard
  (adding proxy-only routes there is dead code — Phase 24 trap); every NEW cron route needs its own
  `PUBLIC_API_PREFIXES` entry + worker pair (autopay almost shipped unreachable); dotted URL paths
  are EXCLUDED by the middleware page matcher (tokens ride in query params — Phase 19 BLOCKER);
  `adminProofRequired` falls through to `true` (new public paths need explicit exemptions).
- **Remote env facts**: no CF creds (deploys are Tyler's), Chromium cannot reach external hosts
  through the egress proxy (curl works), background agents' "it's green" is a claim to re-verify.

## 5. Standing guardrails (unchanged — see handoff-build-state.md §1 for the canonical list)

Everything dark by default, only Tyler flips flags; money movement pauses for Tyler's explicit go
(refund initiation Phase 9b AND autopay Phase 13 both built + held); never a secret in the repo
(especially the Cloudflare token); no canonical mutation from untrusted input (agents draft, Tyler
sends); refund policy CONFIRMED as-built 2026-07-07 (service-not-rendered only, retainer
non-refundable, fees passed to client — do NOT re-ask); "no Zapier, everything in-house."

## 6. Where everything lives

- **Operating manual:** `docs/handoff-build-state.md` (read first, always).
- **Deploy runbook:** `docs/deploy-next.md`. **Ops/rollback:** `docs/ops-stabilization-checklist.md`.
- **Roadmap + per-phase status + enablement runbooks:** `docs/roadmap-competitive-parity.md`.
- **Specs (each with full review changelogs):** `docs/specs/phase-NN-*.md` — the autopay spec
  (`phase-13-autopay-card-on-file.md`) is the reference example of the money-grade process.
- **Change-request intake:** `docs/change-requests.md`. **Surface map:** `docs/app-surface-map.md` +
  `docs/route-access-audit.md`.
- **Local mirror:** `~/Documents/CLAUDE/Reeses-Studio` via `npm run docs:local-sync` (run after
  every pull). **Durable business context:** the Obsidian vault (pointers in `AGENTS.md`).
- **Progress board artifact (survives the session, Tyler's account):**
  https://claude.ai/code/artifact/bdc306ba-54ff-4853-a9bc-102c291d67d6 — a future session can update
  it in place by passing that URL to the Artifact tool. Data source: this repo's roadmap docs.
