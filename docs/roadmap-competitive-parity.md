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
- **Phase 17 — Kanban pipeline board.** Data model + stage-count strip exist; add a visual
  drag-and-drop lead→booked board. UI-only, low risk.
- **Phase 18 — AI daily brief.** A rule-based daily "what needs you" exists; add an AI-narrated daily
  digest (priority leads to answer, overdue, upcoming shoots, stuck items) + optional push. Builds on
  the dashboard action items + Phase 10; the deferred daily-brief Worker.
- **Phase 19 — Embeddable lead-capture form.** Booking page + email intake exist; add a customizable
  inquiry form the photographer embeds on their own site (→ inquiry intake pipeline).
- **Phase 20 — Structured meeting/consult notes.** Per-booking/consult notes surface distinct from
  questionnaires (today: single `project.notes` + note-channel rows).

## Sequencing
12 (convert) → 15 (PWA, quick win) → 14 (email) → 13 (autopay, money-gated) → 16 (mini-sessions) →
17 (kanban) → 18 (daily brief) → 19 (lead form) → 20 (notes). Each independently shippable + dark.
Money-movement (13, and any deposit-at-booking in 16) pauses at first live charge for Tyler's go.
