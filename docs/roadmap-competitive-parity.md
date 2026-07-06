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
- **Phase 12 — Unified accept-sign-PAY.** Today the client link combines review + sign, but the
  retainer is a separate click. Fuse signature → retainer Stripe checkout into one continuous flow
  (HoneyBook/SwiftBooks "accept, sign & pay"). Client-initiated payment (Stripe checkout) — **not**
  autonomous money movement, so not money-gated. Biggest booking-conversion win. Reuses proposal +
  contract + `stripe-checkout` + the `retainer_paid` stage. **Build first.**
- **Phase 13 — Autopay / card-on-file.** MISSING today: every installment is a manual checkout
  link → dunning. Add a Stripe Customer + SetupIntent (card on file) + **off-session auto-charge**
  of scheduled installments. ⚠️ **MONEY MOVEMENT** (auto-charges a real card) — build dark behind a
  flag; enable + first auto-charge need Tyler's explicit go + a money-math/idempotency Fable gate,
  exactly like Phase 9b. Highest dunning-reduction payoff.

### Tier 2 — high value
- **Phase 14 — Two-way per-project email.** Email is log-only today; inbound is inquiry-intake only.
  Add: send email from the project thread (Resend, with the "agents draft, Tyler sends" guard) +
  route inbound client email into the existing project thread (extend Phase 8a routing) → a unified
  email+SMS inbox. Reuses `project_communications` + email infra.
- **Phase 15 — PWA / installable mobile.** MISSING: no manifest/service worker. Add an installable
  PWA (manifest + offline app-shell + optional web push) so Tyler runs the business from his phone on
  location — HoneyBook's #1 differentiator. Cheap, low-risk, high daily value.
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
