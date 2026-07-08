# Handoff & build state — read this first

This is the **operating manual** for continuing the Reese Photography CRM build. It is written so an
agent of any capability level can pick up the work without breaking the standing guarantees. If you
read only one doc before acting, read this one, then `docs/crm-source-of-truth-sop.md` and
`AGENTS.md`.

Owner: Tyler (single owner + single admin login). Clients get per-project portals only.
Last updated: 2026-07-07.

---

## 1. The non-negotiable guardrails (never violate these)

1. **Everything ships DARK.** Every new capability goes behind an **off-by-default** flag (strict
   `=== "1"` to enable). A dark deploy must be a zero-behavior-change no-op. **Only Tyler flips a flag
   on.** You never enable anything.
2. **Money movement pauses for Tyler.** Any code that moves real money (refunds, charges, autopay) or
   sends outbound email/SMS **stops before the first live action** and waits for Tyler's explicit "go."
   These get an Opus/Fable money-math + idempotency review. Refund/autopay flags stay OFF until then.
3. **Fable review gate.** Every spec and every code diff gets an adversarial **Fable review** before it
   lands. Security/money boundaries get the hardest, most adversarial review.
4. **Never write a secret into the repo.** Especially the Cloudflare API token. No secret in any file,
   commit, log, PR body, or doc. Secrets live in Worker/env config on Tyler's machine only.
5. **No canonical mutation from untrusted input.** Inbound email/SMS/webhooks may only append
   operational rows; they never mutate business records without a verified, project-bound token +
   idempotent convergence. Agents draft; Tyler sends.
6. **Green build gate, always.** `npm run lint` (exit 0), `npm run build` (**check EXIT CODE is 0** — a
   type error prints *after* "Compiled successfully" and exits 1), `npm test` (all pass). Never commit
   red.
7. **D1 has no usable transactions.** Never use `db.transaction()` / `db.batch()` — D1 rejects them at
   runtime. Use `INSERT ... ON CONFLICT` per-object convergence and single-statement CAS updates.
8. **This is NOT stock Next.js.** Read the relevant guide in `node_modules/next/dist/docs/` before
   using an App-Router API you're unsure about. Heed deprecation notices.

---

## 2. The build loop (how every feature gets made)

```
spec  →  Fable review of spec  →  build (dark, behind a flag)  →  independent build gate
      →  adversarial Fable review of the diff  →  fix findings  →  commit + push
      →  record status + dark-deploy runbook in docs/roadmap-competitive-parity.md
      →  Tyler deploys (his machine) + enables the flag when ready
```

- Specs live in `docs/specs/phase-NN-*.md`. The roadmap + per-phase status lives in
  `docs/roadmap-competitive-parity.md`.
- Change requests from Tyler live in `docs/change-requests.md`; each becomes a spec then follows the
  loop above.
- Commit messages are descriptive; end with the repo's `Co-Authored-By` / `Claude-Session` trailers.
  Never put a model identifier in a commit/PR/code artifact.

---

## 3. Model-tiering policy (cost-effective delegation)

Delegate to the **cheapest model that can do the job correctly**. Reserve the expensive tiers for
work where a subtle miss is costly (security, money, spec design, adversarial review).

| Work | Model | Why |
|---|---|---|
| Mechanical extraction, inventories, doc formatting, rote edits, search/summarize | **Haiku** | Cheapest; no deep reasoning needed |
| Standard feature builds, UI work, non-money libs, ordinary tests | **Sonnet** | Solid build quality at lower cost |
| Spec design for money/security; money-math; the hardest reasoning | **Opus** | Correctness matters most here |
| Every adversarial review (spec + diff) | **Fable** | The review gate; independent skeptical read |

Rules: prefer one well-scoped background agent over many; don't spin an agent for a 2-line lookup you
can do directly; run independent agents in parallel; always **independently re-verify the build gate**
in the main loop before committing an agent's work (don't trust "it's green" — run it).

**Commit discipline while background agents run (learned the hard way):** when one or more build
agents are editing the working tree in parallel, NEVER `git add -A` / `git add .` — it will sweep an
in-progress agent's half-written files into an unrelated commit. Stage the exact paths for the change
you're committing (`git add <path1> <path2> …`). (Phase 17's kanban files were accidentally bundled
into the Phase 23 fix commit `dce88bf` this way — code was correct and gate-green, but the history is
mixed. No history rewrite was done since it was pushed; the lesson is the fix.)

---

## 4. What's built (all DARK, flags OFF, on branch `claude/reese-crm-production-qa-4caxz0`)

The authoritative, always-current list is `docs/roadmap-competitive-parity.md`. Summary as of
2026-07-07:

- **Phases 1–11** — core CRM: booking/scheduler, projects, invoices, proposals/contracts + e-sign,
  questionnaires, client portal (magic-link), R2 private assets, inbound inquiry-email intake, gallery
  delivery-link (Pic-Time, in-house), two-way SMS (Twilio, consent), automated sequences, finance
  depth (refund/dispute recording, QBO/Xero export, tax/1099/mileage), intelligence/forecasting.
- **Phase 9b** — refund *initiation* (money movement). **Money-gated: OFF until Tyler's go.**
- **Phase 12** — unified accept-sign-PAY booking conversion. Dark (`UNIFIED_SIGN_PAY`).
- **Phase 14** — two-way per-project email (outbound send + inbound client-reply routing). Dark
  (`EMAIL_SENDING_ENABLED`, `INBOUND_PROJECT_EMAIL_ENABLED`, Worker `INTAKE_ENABLED=false`).
- **Phase 15** — PWA / installable (manifest live; service worker deferred).
- **Phase 21** — observability + failure alerting (heartbeat, digest, critical email, monitor Worker,
  `/api/agent/health`, `/system-status` health section). Dark (`MONITOR_ENABLED`), monitor Worker
  un-wired.
- **Phase 22 / CR-1** — project progress / milestone timeline (detail strip + list bar). Dark
  (`PROJECT_PROGRESS_TIMELINE`); spec + diff Fable-reviewed, fixes applied.
- **CR-2** — settings nav group (Settings raised; Activity/Data Health/System Status folded into a
  Settings tab strip, URLs unchanged). Dark (`SETTINGS_NAV_GROUP`).
- **CR-3** — quick-find under-nav bug FIXED (unflagged repair; live on next deploy).
- **Phase 22/CR-1, CR-2, CR-4 (SCHEDULER_MEET_LINKS), CR-5/Phase 23 (QUESTIONNAIRE_AUTOFILL_REVIEW)** —
  all built dark + Fable-reviewed + pushed. Migrations 0094 (meet link) + 0095 (autofill review).
- **Phase 17 kanban board** — built dark (`PROJECTS_BOARD_VIEW`); landed in commit `dce88bf`
  (bundled with Phase 23 fixes — see the commit-discipline note above); Fable diff review pending.
- **CR-4** — scheduler auto-generated Google Meet links. Dark (`SCHEDULER_MEET_LINKS`).
- **Phase 23 / CR-5** — questionnaire autofill review-and-apply: closes the untrusted-input →
  canonical-write channel (public submissions produce a review proposal instead of direct writes to
  projects/clients/locations/events) and adds the missing "Apply timeline draft" step. Dark
  (`QUESTIONNAIRE_AUTOFILL_REVIEW`); migration 0095 applied ahead of the flag flip (additive,
  inert while off). See `docs/specs/phase-23-questionnaire-autofill-review.md`.
- **Phase 19 — embeddable lead form** — a customizable inquiry form Tyler embeds (iframe) on
  `bythereeses.com` that feeds the EXACT existing inquiry-intake pipeline via a sibling
  `ingestWebFormInquiry` (staging `inbound_inquiries` row + authority-less review task only; zero new
  canonical authority — the sole path to a canonical project stays `approveInquiryProjectCreation`).
  New PUBLIC, unauthenticated, iframe-framed surface on the schedule host: `/embed/lead`,
  `/embed/lead/thanks` (dot-free paths; the signed embed token rides in `?t=`), and
  `/api/lead-form/submit` (every user-visible POST outcome is a 303; only a bad token is a raw 403).
  In-house spam defense (signed revocable embed token + per-render timing nonce + honeypot + length
  caps + CRM flood guard + dedicated `leadForm`/`leadFormPage` proxy rate kinds; no CAPTCHA). Config
  in `app_settings.lead_form_config_json` (one additive column, migration **0097**). Dark
  (**`LEAD_FORM_ENABLED`**, read `=== "true"` to match the intake-family sibling
  `isInquiryIntakeEnabled`, NOT the `=== "1"` idiom used by the monitor/finance/portal flags — flag
  off ⇒ all three routes 404). See `docs/specs/phase-19-embeddable-lead-form.md`.

**Also built dark since (per-entry runbooks in `docs/roadmap-competitive-parity.md`):** 17 kanban
(`PROJECTS_BOARD_VIEW`), 18 AI daily brief (`DAILY_BRIEF_ENABLED`, mig 0096), 20 meeting notes
(`MEETING_NOTES_ENABLED`, mig 0098), 24 Resend bounce/complaint suppression webhook
(`RESEND_WEBHOOK_SECRET`, no migration), **13 autopay/card-on-file (`AUTOPAY_ENABLED` +
`AUTOPAY_CHARGE_MODE=log_only` default, mig 0099 — MONEY-GATED: five-round review chain; the first
live charge waits for Tyler's explicit go per spec §7)**, 25 email deliverability hardening
(`SEQUENCES_DAILY_SEND_CAP_ENABLED`, no migration; DMARC check now in config-preflight).

**Not yet built (parity backlog):** 16 mini-sessions only — business-dependent; confirm Tyler runs
mini-session days before building.

**Confidence backlog: COMPLETE.** Golden-path E2E (**built**), config-verification preflight
(**built**, now incl. the Phase 25 DMARC DoH check), email deliverability hardening (**built dark**,
Phase 25). Staged log→enforce enablement is realized as per-feature runbook practice (log_only
modes, one-flag-at-a-time enablement), not a separate build item.

---

## 5. Deploy reality (important)

The remote build environment (Claude Code on the web) has **no Cloudflare credentials** and cannot
deploy. It delivers reviewed, gate-green, pushed dark builds to the branch. **Tyler deploys from his
machine** (canonical working copy `/Volumes/reeseai-memory/04_Code/reese-photography-crm`), where the
CF token lives. Each phase's dark-deploy runbook is written into `docs/roadmap-competitive-parity.md`.
General shape: apply the migration to D1 → `npm run deploy` (app Worker via OpenNext) → deploy any
new Worker + set its secret → `npm run deploy:pages-proxy` (if proxy composition changed). All ship
inert while flags stay off. Ops/rollback: `docs/ops-stabilization-checklist.md`.

---

## 6. Open decisions waiting on Tyler (don't guess these)

- **Refund policy — CONFIRMED 2026-07-07 (as-built stands; no longer open).** Tyler's policy:
  *"refunds only ever issued if service isn't rendered; no refunds on the initial retainer; all
  processing fees passed to the client."* The as-built implements this: the non-refundable retainer
  is identified by *label ∪ earliest payment* (a safe superset that always catches the retainer),
  and processing fees are passed to the client. The two implementation micro-questions previously
  parked here (retainer = label-only vs label∪earliest; fee ceiling service-only vs full) are
  resolved to the as-built readings — do not re-ask. Money movement (a live refund) still pauses for
  Tyler's explicit go per Guardrail 2; confirming the *policy* is not enabling the *flag*.
- **Mini-sessions (Phase 16):** does Tyler run mini-session days? If not, deprioritize.
- **Reminders cron** (task #29): confirm the hourly reminders cron returns 200 on a live tick after the
  `CRON_SECRET` fix (the original silent-failure incident — Phase 21 exists to catch its recurrence).
- **Deploy + enable timing** for the dark backlog (12/14/15/21).

---

## 7. Where everything lives

- `AGENTS.md` / `CLAUDE.md` — repo conventions (this-is-not-stock-Next.js warning; source-of-truth
  pointers).
- `docs/crm-source-of-truth-sop.md` — working-copy / drift-guard / layer hierarchy.
- `docs/studio-agent-access.md` — agent/MCP auth, tools, finance approval guard, smoke.
- `docs/ops-stabilization-checklist.md` — deploy gate, rollback, backup/MCP drills.
- `docs/roadmap-competitive-parity.md` — the roadmap + per-phase status + dark-deploy runbooks.
- `docs/specs/phase-NN-*.md` — per-phase build specs.
- `docs/change-requests.md` — Tyler's change intake (walk the site, note what to change).
- `docs/app-surface-map.md` — every screen by host (the walk-through checklist).
