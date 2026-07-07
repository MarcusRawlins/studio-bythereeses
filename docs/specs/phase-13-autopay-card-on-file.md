# Phase 13 — Autopay / card-on-file (off-session installment auto-charge)

Status: **SPEC (build-ready, Fable rev-2 applied).** Roadmap Tier 1 (`docs/roadmap-competitive-parity.md`).
No application code, no migration SQL in this document — spec text only.

> ⚠️ **THIS IS MONEY MOVEMENT.** This is the single most safety-critical unbuilt feature in the CRM.
> It autonomously charges a real, saved card off-session on a schedule. It ships **DARK**, stays
> **log-only** even after the master flag is on, and the **first live charge waits for Tyler's
> explicit go** (Guardrail 2, `docs/handoff-build-state.md §1`). Every money-math and idempotency
> claim in this doc gets the hardest, most adversarial Fable review — the same gate Phase 9b
> (`stripe-refund-initiation.ts`) passed.

All cited line numbers are current as of this commit; **re-verify if a cited file changes shape
before build.**

---

## 0. Problem & goal

Today every installment on a payment schedule is collected **manually**: an admin/agent mints a
per-installment Stripe Checkout link (`createInvoicePaymentCheckoutSession`,
`stripe-checkout.ts:216`), the client hunts for it in `/portal` (`portal/page.tsx:270-272`,
gated on `stripeCheckoutStatus === "link_ready"`), pays on-session, and the webhook records it
(`settleInvoicePaymentCheckoutSession`, `stripe-checkout.ts:433`). If the client never pays, the
only recourse is dunning (reminders). HoneyBook/Dubsado/SwiftBooks all let a client **save a card at
booking** and then **auto-charge each scheduled installment on its due date**. That is the gap.

**Goal:** let a client **consent once** to autopay in the portal (a Stripe **SetupIntent** saves a
card on file — the card never touches the CRM), then have a cron engine **off-session auto-charge**
each qualifying scheduled installment on its due date via a Stripe **PaymentIntent**
(`off_session: true`, `confirm: true`), recording the result through the **existing** webhook
convergence path. Exactly-once per installment under crash / retry / concurrent-cron. Ships dark;
stays log-only until Tyler watches a full cycle; first live charge is Tyler-gated.

---

## 1. Invariants (the non-negotiables — a violation is a BLOCKER)

- **I1 — Dark by default, strict flag.** With `AUTOPAY_ENABLED !== "1"` the entire feature is a
  zero-behavior-change no-op: the consent UI is hidden, the SetupIntent route 404/no-ops, the cron
  engine selects nothing and calls no Stripe endpoint, no schema is read for autopay. A dark deploy
  changes nothing. Strict `=== "1"` (unset/`""`/`"0"`/`"true"`/typo → OFF), read in the body — the
  `refundInitiationEnabled` idiom (`finance-flags.ts:47`). **Only Tyler flips it** (Guardrail 1).

- **I2 — Money movement pauses for Tyler, twice.** (a) The master flag stays OFF until Tyler's go.
  (b) Even with the master flag ON, the charge engine defaults to **`log_only`**
  (`AUTOPAY_CHARGE_MODE`, §7) — it computes *exactly what it would charge* and records a would-charge
  ledger row, but issues **zero** Stripe charge calls — so Tyler can watch a full billing cycle before
  a single real dollar moves. `live` mode (real charges) is a second, separate, deliberate Tyler flip.
  A per-charge hard cap (`AUTOPAY_MAX_CHARGE_CENTS`) and an optional pilot allowlist
  (`AUTOPAY_PILOT_ALLOWLIST`) bound the blast radius of the first live charges. (Guardrail 2.)

- **I3 — Exactly-once per installment.** A given installment (`invoice_payments` row) is charged
  **at most once** across crash, retry, redeploy, and concurrent cron ticks. Enforced by a **layered**
  guarantee (§6): (1) a partial `UNIQUE(invoice_payment_id) WHERE dry_run = 0` autopay-charge ledger
  row (one *real* charge row per installment, ever; `log_only` dry-run rows sit outside the index —
  §3.2); (2) a single-statement **CAS claim** with a per-attempt claim token (D1 has no
  transactions — `INSERT … ON CONFLICT` convergence + single-statement CAS, exactly like
  `stripe-refund-initiation.ts:439-465` and `sequences.ts` claim-first `insertLedger:324`); (3) a
  **Stripe idempotency key** pinned *before* the network call; (4) the existing
  `UNIQUE(external_payment_id)` index (`migrations/0029_unique_external_payment_ids.sql`) as the final
  DB backstop against double-recording a PaymentIntent. **An ambiguous in-flight charge is
  TERMINAL-UNKNOWN and is NEVER blind-retried** — recovery is reconcile-against-Stripe (§6.4), the
  exact posture of the refund `submitting` state (`stripe-refund-initiation.ts:370-380`) and the
  sequence `claimed` state (`sequences.ts:634-636,671`).

- **I4 — Card data NEVER touches the CRM.** Stripe tokenizes via SetupIntent. The CRM stores at most:
  the Stripe **customer id** (`cus_…`), the **payment_method id** (`pm_…`), and display-only
  `card_brand` + `card_last4` (+ optional `exp_month`/`exp_year`). Never a PAN, never a CVC, never a
  full card number. The card is entered on Stripe-hosted UI (Checkout in `setup` mode or Stripe
  Elements), never on a CRM form.

- **I5 — No canonical mutation from untrusted input; verify-before-act on every webhook.** The
  autopay webhook events (`setup_intent.succeeded`, `payment_intent.succeeded`,
  `payment_intent.payment_failed`) flow through the **existing** signature-verified route
  (`verifyStripeWebhookPayload` → `handleStripeCheckoutWebhook`, `stripe/webhook/route.ts:21,45`),
  reusing the Phase 21/24 signature-reject carve-out (`stripe-webhook` vs `stripe-webhook-rejected`,
  `stripe/webhook/route.ts:13-38`). Untrusted input never picks which installment to charge — the
  engine derives everything server-side from consented rows.

- **I6 — Secrets never in the repo.** `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `CRON_SECRET`
  stay in Worker env only, fail-closed when unset (`stripe-checkout.ts:17-27`,
  `cron/sequences/route.ts:17-20`), never logged (`redactSecretEnvValues`, `job-runs.ts:48`).

- **I7 — Off-session recording reuses the reviewed convergence, adds no new money-state math.**
  Marking an installment `paid`, recomputing the invoice, and advancing the stage are done by a
  sibling of `settleInvoicePaymentCheckoutSession` that reuses the **same** convergence shape
  (set-to-paid, `reconciledInvoicePaymentStatus`, `autoAdvanceProjectStageForRetainerPayment`,
  `stripe-checkout.ts:526-585`). No new fee/amount arithmetic is invented; the charge amount is the
  installment's own `invoicePaymentClientPayableOpenCents` (`invoice-balances.ts`), the identical
  basis the manual checkout already uses (`stripe-checkout.ts:341-345`).

- **I8 — Never infinite-retry; always a manual fallback.** A declined off-session charge retries on a
  bounded schedule (`AUTOPAY_MAX_ATTEMPTS`, default 3). After the cap — or immediately on
  `authentication_required` (SCA, which off-session cannot satisfy) — the engine **stops
  auto-charging that installment**, falls back to the existing manual checkout link + dunning, and
  alerts Tyler. It never loops.

- **I9 — Consent is explicit, versioned, audited, and revocable.** Autopay charges only a payment
  whose project has an **active** consent whose recorded `consent_version` matches the current text.
  The client can revoke in the portal at any time; revocation stops all future auto-charges
  immediately (a charge already `charging` is TERMINAL-UNKNOWN and out of scope of revoke — it
  reconciles normally). Every consent grant/revoke is `logActivity`-audited.

---

## 2. Ground truth — what already exists (reuse map, cite before you reuse)

| Concern | Existing symbol | File:line | How Phase 13 reuses it |
| --- | --- | --- | --- |
| Stripe HTTP pattern (raw `fetch`, **no SDK**), pinned API version | `createStripeCheckoutSession`, `STRIPE_API_VERSION = "2026-02-25.clover"` | `stripe-checkout.ts:11,57-79` | Mirror **verbatim** for the new `POST /v1/setup_intents`, `POST /v1/customers`, `POST /v1/payment_intents` calls: same auth header, same `stripe-version`, same `x-www-form-urlencoded` body, same `stripeErrorMessage` cleanup. **Raw fetch, not `stripe` SDK.** |
| Fail-closed secret, never logged | `stripeSecretKey()` | `stripe-checkout.ts:17-21` | Reuse the exact helper (throws if unset). |
| Webhook signature verify + typed reject | `verifyStripeWebhookPayload`, `StripeWebhookSignatureError` | `stripe-checkout.ts:132-188` | Autopay events ride the **same** verified path; the reject carve-out already classifies to `stripe-webhook-rejected` (`stripe/webhook/route.ts:28,55-59`). |
| Webhook route (verify-first, heartbeat, carve-out) | `POST /api/stripe/webhook` | `stripe/webhook/route.ts` | **Extend `handleStripeCheckoutWebhook`'s dispatch** (`stripe-checkout.ts:704-727`) to route the 3 new event types to autopay handlers — do **not** add a second webhook endpoint (mirrors how Phase 9a folded refund events into the same route, `stripe-checkout.ts:716`). |
| The one existing money-MUTATION module (POST to a Stripe money endpoint) + its full safety kit | `initiateInvoicePaymentRefund` (CAS claim token, pinned amount, idempotency key = row id, submitting=terminal-unknown, ~1h reconcile tripwire) | `stripe-refund-initiation.ts:318-552,564-614` | **This is the direct architectural precedent** for the charge engine. Copy its state machine shape: flag-gate first, single-statement CAS claim with a per-execute claim token, pin the amount + idempotency key in the claiming UPDATE *before* the network call, re-read to confirm ownership, terminal-unknown on ambiguity, reconciliation tripwire. |
| Claim-first ledger for autonomous background sends (crash-safe exactly-once) | `insertLedger` (`INSERT … ON CONFLICT DO NOTHING`, returns true iff this call claimed), `claimed`=terminal-unknown never-retry, `failed`=provably-not-done retryable | `sequences.ts:324-346,614-672` | The autopay-charge ledger's claim + status semantics mirror this exactly (claim before the side effect; ambiguous → leave claimed, never auto-retry; provable failure → retryable). |
| Anti-double-charge CAS precedent (studied per the brief) | Phase 12 `link_ready` conditional single-statement CAS + canonical re-read | `docs/specs/phase-12-unified-sign-pay.md §4.3(b)`, `stripe-checkout.ts:376-394` | Same technique — a single `UPDATE … WHERE <status guard>` is atomic in D1; re-read the row and treat the **stored** value as canonical, never the local in-flight value. Applied here to the `pending → charging` claim. |
| Installment payment recording + invoice recompute + stage advance | `settleInvoicePaymentCheckoutSession` → `reconciledInvoicePaymentStatus` → `autoAdvanceProjectStageForRetainerPayment` | `stripe-checkout.ts:433-604`, `sales.ts:120` | Build a sibling `recordAutopayPaymentIntentSucceeded` that reuses this **exact** convergence (set-to-paid, recompute, advance). Do not fork the math. |
| Client-payable amount (service + passed-through card fee) | `invoicePaymentClientPayableOpenCents`, `invoicePaymentOpenCents`, `isSettledInvoicePaymentStatus` | `invoice-balances.ts:66,75` | The charge amount is exactly `invoicePaymentClientPayableOpenCents(payment, …)` — the same basis the manual link uses (`stripe-checkout.ts:341-345`). No new amount math. |
| Retainer identity (to skip / classify the first installment) | `isRetainerPayment`, `resolveRetainerPayment`, `isRetainerPaymentLabel` | `retainer-selection.ts:54,62,26` | Reuse to classify installments (e.g. the retainer is normally collected on-session at booking; autopay targets the **later** installments — §5.1). Never fork the predicate. |
| Unique external payment id (double-record backstop) | `idx_invoice_payments_external_payment_unique` | `migrations/0029_unique_external_payment_ids.sql` | The final DB layer of I3: a PaymentIntent id can be recorded against at most one installment. |
| Cron pattern (CRON_SECRET, fail-closed, timing-safe, heartbeat, fail-loud) | `POST /api/cron/sequences`, `POST /api/cron/scheduler-reminders` | `cron/sequences/route.ts`, `cron/scheduler-reminders/route.ts` | The autopay engine's cron route is a **direct structural clone**: `CRON_SECRET` (or `SCHEDULER_LINK_SECRET`) 503-if-unset / 401-if-mismatch (`sequences/route.ts:16-25`), flag-off = record ok + skip (`:30-33`), heartbeat via `recordJobRun`, throw records failure + returns 500 (fail-loud, `:37-44`). |
| Heartbeat + alerting catalog | `recordJobRun`, `JobName` union, `WEBHOOK_JOBS`, CRITICAL `alertKey` | `job-runs.ts:69-172`, `system-health.ts:117-118,404` | Add `autopay-charger` (staleness-alertable, CRITICAL) + `autopay-webhook` folded into the existing `stripe-webhook` key. Add a reconcile tripwire signal mirroring the refund `critical:refund_stuck` one (`system-health.ts:404`). |
| Refund reconciliation tripwire (the model for the charge tripwire) | `getRefundInitiationReconciliation` (succeeded-not-recorded ≥24h; stuck submitting ≥1h) | `stripe-refund-initiation.ts:564-614` | Mirror for autopay: a `charging` row older than ~1h → "charge stuck in-flight, reconcile against Stripe"; a `charged` row with no recorded `invoice_payments.paid` after ~24h → "charge not reconciled". |
| Outbound email master gate (for notices/receipts) | `EMAIL_SENDING_ENABLED` (`emailSendingEnabled()`), `sendSequenceEmail`, `isEmailSuppressed` | `project-communications.ts:552-554`, `email.ts` (see `email-send-guard.test.ts`) | ⚠️ **The transport does NOT enforce this gate.** `emailSendingEnabled()` is checked **only** inside the Phase 14 admin approved-send path (`sendApprovedProjectEmail`, `project-communications.ts:552-554`); the sequence transport `sendSequenceEmail` does **not** consult it. Therefore the **new autopay email helper must call `emailSendingEnabled()` itself** (fail-closed) before it ever hands a message to `sendSequenceEmail`, and must also honor `isEmailSuppressed` and the `log_only` suppression (§8). Test 29 asserts the gate **at the autopay-helper layer**, not at the transport. |
| Flag helpers home | `refundInitiationEnabled`, `unifiedSignPayEnabled`, `financeRefundRecordingMode` (three-state) | `finance-flags.ts:21-59` | Add the autopay flag helpers here (§7), modeled on these. |

**Stripe integration style confirmed:** the repo uses **raw `fetch`** against `api.stripe.com` with a
pinned `stripe-version` header (`stripe-checkout.ts:57-66`, `stripe-refund-initiation.ts:91-100`) —
**not** the `stripe` npm SDK. Phase 13 follows this exactly (SetupIntent, Customer, PaymentIntent are
all form-encoded raw `fetch`).

---

## 3. Data boundary & schema (migration `0099`, additive, inert while dark)

> **Migration number.** The highest applied migration is `0098_meeting_notes_booking_link.sql`, so the
> next free number is **`0099`**. **Build-time free-slot caveat** (per Phase 21's `0092→0093` and
> Phase 24's note): another in-flight phase may claim `0099` before this lands — **at build time, take
> the next actually-free number** and update every reference in this spec. All new tables use
> `CREATE TABLE IF NOT EXISTS`; the migration is purely additive and **inert while `AUTOPAY_ENABLED`
> is off** (no existing table is altered; nothing reads these tables until the flag is on).

Two new tables. **No new column on `invoice_payments`** — autopay state lives in its own tables so the
canonical installment row is never mutated by autopay except through the *existing, reviewed* settle
path (I7). Card data is Stripe-tokenized (I4).

### 3.1 `autopay_consents` — one active consent per project

Columns (names illustrative; match repo snake_case + the canon-guard trigger style of
`0080`/`0091`):

- `id TEXT PRIMARY KEY`
- `project_id TEXT NOT NULL` (FK → `projects.id`) — autopay is scoped to a project's schedule.
- `client_id TEXT` (FK → `clients.id`, the primary contact who consented).
- `stripe_customer_id TEXT NOT NULL` (`cus_…`).
- `stripe_payment_method_id TEXT` (`pm_…`; NULL until the SetupIntent succeeds and the webhook
  attaches it).
- `card_brand TEXT`, `card_last4 TEXT`, `card_exp_month INTEGER`, `card_exp_year INTEGER` —
  **display-only**, from the webhook's `payment_method.card`. **Never a PAN/CVC** (I4).
- `consent_version TEXT NOT NULL` — the version string of the consent text the client agreed to (§4.2).
- `consent_text_hash TEXT` — hash of the exact rendered consent copy at grant time (audit; proves
  *what* they agreed to even if the copy later changes).
- `status TEXT NOT NULL DEFAULT 'pending'` — `pending` (SetupIntent created, card not yet confirmed) |
  `active` (card attached, autopay live) | `revoked` (client turned it off) | `failed` (SetupIntent
  failed/expired). Constrained by a canon-guard trigger (mirror `0080`'s status CHECK trigger).
- `setup_intent_id TEXT` (`seti_…`; idempotency + reconcile join key).
- `consented_at TEXT`, `revoked_at TEXT`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`.
- **`UNIQUE` partial index** on `project_id WHERE status = 'active'` — at most **one active** autopay
  consent per project (a re-consent supersedes the prior via CAS, §4).

### 3.2 `autopay_charges` — the exactly-once charge ledger (I3 backbone)

**One *real* (`dry_run = 0`) row per installment, ever** (dry-run audit rows are unbounded and sit
outside the partial unique index — §3.2 `dry_run`). This table IS the idempotency/CAS state machine.

- `id TEXT PRIMARY KEY` — also the base of the Stripe idempotency key (§6.3).
- `invoice_payment_id TEXT NOT NULL` (FK → `invoice_payments.id`).
  **`UNIQUE(invoice_payment_id) WHERE dry_run = 0`** — a **PARTIAL** unique index (SQLite/D1
  support partial indexes). The hard guarantee that an installment gets **at most one** *real*
  (non-dry-run) charge ledger row (I3 layer 1). The partial predicate is load-bearing: it keeps
  `dry_run = 1` rows entirely **outside** the exactly-once ledger so `log_only` audit rows can be
  written freely (potentially many, one per observed tick) and can **never** collide with, block, or
  be promoted into the single real row an eventual `live` charge inserts. Claim (live path) =
  `INSERT … (dry_run = 0) ON CONFLICT DO NOTHING` (returns true iff this cron tick created it — the
  `insertLedger` pattern, `sequences.ts:324-346`). **A dry-run row is never on the conflict target**,
  so it never suppresses the real INSERT. (This resolves the rev-1 incoherence where a total
  `UNIQUE(invoice_payment_id)` made "going live creates a fresh row" impossible — see rev-2 changelog
  BLOCKER-2.)
- `invoice_id TEXT NOT NULL`, `project_id TEXT NOT NULL`, `consent_id TEXT NOT NULL` (which consent
  authorized it), `stripe_customer_id TEXT NOT NULL`, `stripe_payment_method_id TEXT NOT NULL`
  (pinned at claim time — the card that was authorized, so a later card swap can't retroactively
  redirect an in-flight charge).
- `amount_cents INTEGER NOT NULL` — pinned at claim time = `invoicePaymentClientPayableOpenCents`
  (I7). The charge sends **this pinned value**, never a re-computed one (mirrors the refund's pinned
  `amountCents`, `stripe-refund-initiation.ts:494`). This is the PaymentIntent `amount`
  (`amount_total`-equivalent: service + passed-through card fee).
- `service_amount_cents INTEGER NOT NULL`, `client_fee_cents INTEGER NOT NULL` — **the split, also
  pinned at claim time** (MAJOR-2). `service_amount_cents = invoicePaymentOpenCents(payment)` at
  claim; `client_fee_cents = amount_cents − service_amount_cents`. These are what the manual checkout
  pins into `metadata[service_open_cents]` at mint (`stripe-checkout.ts:364`) and what the settle
  recorder consumes to split `paidAmountCents` (service) vs `clientFeeCents`
  (`stripe-checkout.ts:506-520`). Pinning them **here at claim** — and mirroring them into the PI
  metadata (§6.3) — means the webhook recorder reads the split from the row/metadata frozen at charge
  time and **never re-derives it at webhook time**. Without this pin, an installment edited between
  charge and a delayed webhook would make the recorder recompute a *different* split → wrong
  `paidAmountCents`, wrong books.
- `currency TEXT NOT NULL DEFAULT 'usd'`.
- `status TEXT NOT NULL DEFAULT 'pending'` — the state machine (§6.1):
  `pending → charging → charged | failed_retryable | failed_terminal | needs_action | skipped_capped
  | aborted_ineligible`. Constrained by a canon-guard trigger.
  - `aborted_ineligible` (MAJOR-1) is a **provably-not-charged state**: the post-claim
    re-verification (§6.2a) or cross-channel resolution (§6.2b) found a §5.1 condition no longer
    held — or the recomputed payable drifted from the pinned amount — *after* the claim won but
    *before* any PI POST, so the row was CAS'd here and **no network call was made**.
    **Rev-2.1 R-4 — it is conditionally RE-CLAIMABLE, not a dead terminal:** rev-2 called its
    triggers "permanently disqualifying," but revoked consent and a stale `consent_version` are both
    **curable** (the client re-consents), and with a total-blocking `aborted_ineligible` + the partial
    unique index, a re-consented installment would be silently excluded from autopay **forever**
    (fail-safe for money, wrong for the product). Instead it follows the `skipped_capped` pattern:
    the CAS claimable set (§6.2) includes `aborted_ineligible` **only when the full §5.1 eligibility
    re-qualifies on the fresh tick** (collectible invoice + open payable + active current-version
    consent). Genuinely permanent triggers (invoice void, installment paid) simply never re-qualify —
    they stay blocked by §5.1 itself, not by the state; curable ones (re-consent, amount re-pin)
    re-enter cleanly on the next tick with freshly pinned values.
  - `skipped_capped` (M3): written when the pinned payable exceeded `AUTOPAY_MAX_CHARGE_CENTS` at
    claim time (§5.1 rule 7). It is **re-claimable** iff a *freshly re-pinned* payable is now
    `<= AUTOPAY_MAX_CHARGE_CENTS` (e.g. Tyler raised the cap, or the installment was partially paid
    down) — the CAS claimable set (§6.2) includes `skipped_capped` **only under that condition**, so a
    cap raise lets the next tick charge it without a manual step, and an unchanged over-cap row is
    simply re-skipped (no state churn, but it must NOT alert-storm — see §7 cap note). Absent that
    condition it stays a benign terminal.
- `dry_run INTEGER NOT NULL DEFAULT 0` — `1` iff this row was created in `log_only` mode (a
  would-charge record; **no Stripe call was made, ever**). A dry-run row is a **pure audit artifact
  that lives entirely outside the exactly-once ledger** (it is excluded from the partial
  `UNIQUE(invoice_payment_id) WHERE dry_run = 0` index above). It is **never** claimed, **never**
  promoted, and **never** transitions to `charging`/`charged` (BLOCKER-2). When Tyler flips to `live`,
  the engine INSERTs a **fresh** `dry_run = 0` row for the installment — the partial index makes that
  INSERT succeed regardless of dry-run rows existing for the same installment, and the
  §6.2 CAS carries `AND dry_run = 0` so it can only ever claim the real row. Dry-run rows are left in
  place as history (no "reconcile/clear" step is required or defined — they are simply inert).
  **Dry-run rows are BOUNDED — one per installment, upserted (rev-2.1 R-8):** a second partial index
  `UNIQUE(invoice_payment_id) WHERE dry_run = 1` with the log-only tick doing
  `INSERT … ON CONFLICT … DO UPDATE SET amount_cents/service_amount_cents/client_fee_cents=<fresh>,
  updated_at=now` — refreshing the would-charge amounts on each observation instead of appending. A
  multi-week `log_only` cycle on an hourly cron would otherwise write hundreds of rows per
  installment, burying the exact ledger Tyler must human-review at runbook step 3 (no money risk,
  pure reviewability). Net: at most **two** rows per installment ever — one dry-run audit row, one
  real ledger row.
- `attempt_count INTEGER NOT NULL DEFAULT 0`, `max_attempts INTEGER NOT NULL`.
- `idempotency_key TEXT` — the exact key sent to Stripe for the **current** attempt, **materialized
  by the claiming UPDATE itself** (§6.3, M1): the key's attempt component is derived from the row's
  own `attempt_count` **as a SQL expression in the same statement that increments it** (or the
  pre-read `attempt_count` is pinned in that statement's `WHERE`), so the key can never be computed in
  JS from a value that has drifted from the SQL-incremented one. Regenerated only for a *new* attempt
  after a **confirmed** decline.
- `claim_token TEXT` — per-attempt CAS ownership token (the refund pattern,
  `stripe-refund-initiation.ts:438`).
- `stripe_payment_intent_id TEXT` (`pi_…`), `stripe_status TEXT`, `decline_code TEXT`,
  `last_error TEXT` (sanitized ≤500, `sanitizeJobRunError`-style).
- `next_attempt_at TEXT` — when `failed_retryable`, the earliest next cron tick may re-attempt.
- `created_at`, `updated_at`, `charged_at`, `reconciled_at`.

> **Why a dedicated ledger, not columns on `invoice_payments`:** it keeps the canonical installment
> row untouched by the autopay engine (only the *existing* settle path writes `status='paid'`), gives
> the CAS/claim its own row to own, and lets a dry-run leave a full audit trail without ever risking a
> canonical mutation. Mirrors how Phase 9b kept refund state in `refund_initiations`, never in
> `invoice_payments` (`stripe-refund-initiation.ts:5-8`).

---

## 4. Consent + card capture (SetupIntent)

### 4.1 Who initiates, where

**The client initiates, in the portal.** On `/portal` (and, when Phase 12 is on, optionally offered
right after the first retainer is paid), a project with a payment schedule that still has future
installments shows an **"Turn on autopay"** affordance — visible **only** when `AUTOPAY_ENABLED` is on
(I1) and the project has ≥1 unsettled future installment. The admin/agent surface **never** initiates
consent on the client's behalf (consent must be the client's own act; agents draft, they never
consent for a client).

Flow (all Stripe-hosted card entry — I4):

1. Client clicks "Turn on autopay" → `POST /api/portal/autopay/setup` (a new **portal-token-authed**
   route, in the same public-but-token-bound family as the existing portal actions; it reads the
   project **only** from the portal token, never from request body — no IDOR, mirroring
   `resolveProposalRetainerCheckout`'s token-only sourcing, `phase-12 §7`).
2. Server **finds-or-creates** a Stripe **Customer** for the project's primary client
   (`POST /v1/customers`, idempotency-key = `autopay-cus:${projectId}` so a double-click makes one
   customer), stores `stripe_customer_id`, and creates a **SetupIntent**
   (`POST /v1/setup_intents`, `usage=off_session`, `customer=cus_…`,
   `metadata[project_id]`/`metadata[consent_id]`). It writes a `pending` `autopay_consents` row
   (CAS: supersede any prior non-active row for the project) capturing `consent_version` +
   `consent_text_hash` at this moment.
3. The client completes card entry on **Stripe-hosted UI** — either a Checkout Session in **`setup`
   mode** (`mode=setup`, reuses the existing hosted-checkout return-URL machinery of
   `createStripeCheckoutSession`, `stripe-checkout.ts:57`) or Stripe Elements with the SetupIntent
   client secret. **v1 uses Checkout `mode=setup`** — it reuses the reviewed hosted flow, keeps all
   card fields off every CRM surface, and needs no client-side Stripe JS beyond the redirect.
4. Stripe → `setup_intent.succeeded` webhook (via the existing verified route) → attach. Because
   `UNIQUE(project_id) WHERE status = 'active'` allows **at most one** active consent per project, a
   re-consent (card update) must **not** flip a second row to `active` while the prior one is still
   active — that would violate the unique index, throw inside the webhook handler, and (I5/§6.5) poison
   the `stripe-webhook` money-drift counter. So the activation is **two single-statement CAS writes,
   in this order** (M6):
   1. **First, supersede any prior active row:** `UPDATE autopay_consents SET status='revoked',
      revoked_at=now WHERE project_id=? AND status='active' AND id != <this consent id>` (a card update
      revokes the old card-on-file).
   2. **Then activate this row:** `UPDATE autopay_consents SET status='active',
      stripe_payment_method_id=<pm>, card_brand/last4/exp=<display>, consented_at=now WHERE id=? AND
      status='pending'`.
   These are two independent single statements (D1 has no transactions). A crash **between** them
   leaves the project with **zero** active consents — the fail-safe direction: autopay simply does not
   charge until the client (or a webhook replay) re-activates, never a double-active or an
   index-violation loop. `logActivity("autopay.consent_granted")` after step 2. A
   `setup_intent.setup_failed` → consent `status='failed'` (client can retry).

**Consent is recorded as active only by the webhook**, never optimistically on redirect (mirrors the
Phase 12 async-settle discipline, `phase-12 §5.3`): the card-on-file must be provably attached before
we consider autopay live.

### 4.2 Consent text — where it lives, how it's audited

- The **consent copy** is a single source-of-truth constant (e.g. `src/lib/autopay-consent.ts`
  exporting `AUTOPAY_CONSENT_VERSION` + `AUTOPAY_CONSENT_TEXT`), rendered verbatim on the portal
  before the client proceeds. Copy states plainly: *what* card will be saved, *what* will be charged
  (each scheduled installment), *when* (on each due date), *how much* (the scheduled amount, incl.
  the passed-through card fee), *how to cancel* (revoke in the portal anytime), and that a receipt is
  emailed per charge.
- The agreed `consent_version` **and** a `consent_text_hash` of the exact rendered copy are persisted
  on the consent row (§3.1). If the copy later changes, `AUTOPAY_CONSENT_VERSION` bumps; **the engine
  only auto-charges under a consent whose `consent_version` equals the current version** (I9) — a
  stale-version consent is treated as revoked-for-charging and the client is re-prompted. This is the
  "consent is versioned" guarantee: we never charge under terms the client didn't see.
- Every grant + revoke is `logActivity`-audited with the version + (non-secret) card display fields.

### 4.3 Revocation

- The portal shows, for an active consent, the saved card (`Visa •••• 4242`) and a **"Turn off
  autopay"** button → `POST /api/portal/autopay/revoke` (portal-token-authed, project-from-token).
- Revoke = single-statement CAS `UPDATE autopay_consents SET status='revoked', revoked_at=now
  WHERE project_id=? AND status='active'`, then (best-effort) `POST /v1/payment_methods/{pm}/detach`
  at Stripe so the token is gone provider-side too. `logActivity("autopay.consent_revoked")`.
- **Effect is immediate for all *future* charges**: the engine's selection (§5) requires an `active`
  consent, so a revoked project is skipped from the next tick onward. An installment already in
  `charging` (claimed, in-flight) is TERMINAL-UNKNOWN and reconciles normally — revoke does not, and
  cannot, claw back an authorized in-flight charge (that would be a refund, out of scope).

---

## 5. The auto-charge engine (cron)

### 5.1 Which installments qualify (all conditions AND-ed, derived server-side)

An `invoice_payments` row `P` qualifies for an autopay attempt on a given tick iff **all** hold:

1. `AUTOPAY_ENABLED` is on (I1) — else the engine no-ops entirely.
2. `P.dueDate` is non-null and `<= now` (due date arrived). A null-due installment never autopays.
3. `P`'s invoice status is on the **collectible ALLOWLIST** — `invoice.status IN ('sent',
   'partially_paid', 'overdue')` — the exact precedent of the invoice-reminder / dunning scan
   (`sequences.ts:506`), **not** a `void`/`draft` blocklist. An allowlist **fails closed**: any
   present-or-future status not explicitly listed (`draft`, `void`, `paid`, a status added later)
   never triggers a charge, whereas a blocklist would silently start auto-charging any new status
   nobody remembered to exclude. (Rev-1 cited "the Phase 22 overdue scan" and a void/draft blocklist —
   both corrected here per MINOR-3 / MINOR-8.)
4. `P` is **unsettled and payable**: `invoicePaymentOpenCents(P) > 0` (which is `0` for
   `paid`/`waived`/`refunded` via `isSettledInvoicePaymentStatus`, `invoice-balances.ts:66`) **and**
   `invoicePaymentClientPayableOpenCents(P, …) > 0`.
5. `P`'s project has an **`active` `autopay_consents`** row with `consent_version` == current
   `AUTOPAY_CONSENT_VERSION` and a non-null `stripe_payment_method_id` (I9).
6. **No blocking *real* (`dry_run = 0`) `autopay_charges` row** for `P`. This evaluation, and the
   Layer-2 claim CAS (§6.2), **ignore `dry_run = 1` rows entirely** (`AND dry_run = 0` in every
   status predicate) — dry-run audit rows never block or get claimed (BLOCKER-2). Among the real rows:
   a row in `charged`, `charging`, `needs_action`, or `failed_terminal` is **blocking**; a
   `failed_retryable` row qualifies **only** if `attempt_count < max_attempts` **and**
   `now >= next_attempt_at`; a `skipped_capped` row qualifies **only** if the freshly re-pinned
   payable is now `<= AUTOPAY_MAX_CHARGE_CENTS` (M3 — a raised cap or a paid-down balance re-opens it;
   otherwise it stays blocking); an `aborted_ineligible` row qualifies **only** if the full rule set
   1–5 + 7–8 re-qualifies on this fresh tick (rev-2.1 R-4 — e.g. the client re-consented, or the
   pinned amount drifted and is now re-pinnable; a void/paid trigger never re-qualifies and stays
   blocked by the rules themselves).
7. `AUTOPAY_MAX_CHARGE_CENTS` gate: if the payable amount `> AUTOPAY_MAX_CHARGE_CENTS`, the engine does
   **not** charge — it writes (or leaves) a `skipped_capped` ledger row and alerts Tyler **once**
   (§7). A fat-fingered large installment can never be silently auto-drained. **The transition INTO
   `skipped_capped` is defined (rev-2.1 R-6):** for a **fresh** over-cap installment (no real row yet),
   the Layer-1 INSERT writes the row **directly with `status='skipped_capped'`** (never `pending` —
   a pending over-cap row would sit in the claimable set with only the cap guard between it and a
   charge); for an **existing** claimable row (`pending`/`failed_retryable`) whose payable has grown
   over-cap, the engine issues a plain status-guarded single-statement CAS
   `UPDATE … SET status='skipped_capped' WHERE id=? AND status IN ('pending','failed_retryable')`
   (no claim token needed — no money moves on this transition; a lost race just means another worker
   claimed it first and ITS §6.2a/cap re-check governs). **Alert-storm guard
   (M3):** the alert fires on the *transition into* `skipped_capped` (first observation), not on every
   hourly re-select of an already-capped row — an already-`skipped_capped` row that is still over-cap
   is re-skipped silently. Once the cap is raised (or the balance drops) so the payable is `<= cap`,
   rule 6 makes the row re-claimable and the next tick charges it normally.
8. `AUTOPAY_PILOT_ALLOWLIST` (if set, §7): `P.project_id` must be in the allowlist. Empty/unset ⇒ all
   consented projects (only relevant once Tyler is past the pilot).

**Retainer note:** the first installment (the retainer) is normally collected **on-session** at
booking (manual link / Phase 12 sign-&-pay). Autopay targets the **remaining scheduled installments**.
The engine does not special-case the retainer beyond the qualification rules above — if a retainer is
somehow still open past its due date under an active consent, it qualifies like any installment — but
in practice the retainer is `paid` before autopay ever looks, so it's skipped by rule 4.
Classification uses the shared `isRetainerPayment`/`resolveRetainerPayment` predicate
(`retainer-selection.ts`) if the UI needs to label "retainer vs installment"; the engine itself keys
only on due-date + open-balance + consent.

### 5.2 When it runs (cron)

- New route `POST /api/cron/autopay-charge`, a **structural clone** of `cron/sequences/route.ts`:
  `export const runtime = "nodejs"; export const dynamic = "force-dynamic";`
  `CRON_SECRET` (fallback `SCHEDULER_LINK_SECRET`) — 503 if unset, timing-safe 401 if mismatch
  (`sequences/route.ts:16-25`). Flag-off ⇒ `recordJobRun("autopay-charger", true)` + `{skipped:
  "flag_off"}` (a flag-off run is a **successful** run so staleness never alarms — `sequences/route.ts:30-33`).
- **Cadence: hourly** (matches the existing reminders/sequences crons), but each installment is
  effectively charged once (I3) regardless of how many ticks see it. Hourly gives prompt due-date
  pickup and natural retry cadence via `next_attempt_at`. Wire it in the same cron config as the other
  jobs.
- Heartbeat + fail-loud exactly like `sequences`/`scheduler-reminders`: on throw, `recordJobRun
  ("autopay-charger", false, msg)` then return 500 (never mask a failure into a 2xx —
  `sequences/route.ts:41-44`). `autopay-charger` is a **staleness-alertable, CRITICAL** job
  (`system-health.ts` `REQUIRED_JOBS`-style entry with `alertKey: "critical:autopay_charger_stale"`)
  — a silently-dead autopay cron is a money-relevant outage.

### 5.3 Per-installment processing (bounded batch)

Each tick: select qualifying installments (§5.1), cap the batch (e.g. `AUTOPAY_BATCH_MAX`, default
50, so one tick can't fan out unboundedly), and process each independently (one bad installment never
blocks the rest — per-row try/catch, like the sequence runner). For each, run the §6 state machine.

---

## 6. Idempotency & the exactly-once CAS state machine (the hardest part — read literally)

> A Sonnet-tier builder MUST implement this section verbatim. Every step's ordering is load-bearing.
> The model is `initiateInvoicePaymentRefund` (`stripe-refund-initiation.ts:318-552`) + the
> `sequences.ts` claim-first ledger + the Phase 12 CAS. Do not "simplify" it.

### 6.1 States

> **Mode is read ONCE per tick.** At the top of each tick the engine reads `AUTOPAY_CHARGE_MODE`
> **exactly once** (BLOCKER-2). Every row processed in that tick uses that single pinned value: a
> `log_only` tick inserts `dry_run = 1` rows only; a `live` tick inserts `dry_run = 0` rows only. The
> `dry_run` value is decided **at INSERT** and is **never** re-evaluated per-row mid-tick and **never**
> mutated afterward.

```
        (cron selects a qualifying installment P; tick-mode = AUTOPAY_CHARGE_MODE read ONCE at tick start)
                        │
   log_only tick? → INSERT autopay_charges (…, dry_run=1) — a pure audit row OUTSIDE the partial
        │            unique index; NO Stripe call, EVER; log "WOULD charge $X on installment Y"; done.
        │            (dry_run rows are never claimed, never promoted — BLOCKER-2)
        │  live tick:
        ▼
          INSERT autopay_charges (…, dry_run=0) ON CONFLICT(invoice_payment_id) WHERE dry_run=0 DO NOTHING
                        │  claimed = (this INSERT created the row)?
        ┌───────────────┴───────────────┐
       no (a real row already exists)   yes → status='pending', dry_run=0
        │                                        │
   re-evaluate that row's status (M2: an        │
    orphaned 'pending' non-dry-run row          │
    PROCEEDS to the CAS claim below;            │
    retry a 'failed_retryable' only if          │
    attempt<max & now>=next_attempt_at;         │
    a 'skipped_capped' only if payable<=cap;    │
    an 'aborted_ineligible' only if §5.1        │
    fully re-qualifies this tick — R-4)         │
        └───────────────┬────────────────────────┘
                        ▼
     CAS claim:  UPDATE … SET status='charging', attempt_count = attempt_count + 1,
                 claim_token=NEW, idempotency_key = <id> || ':' || (attempt_count + 1)  ← SQL expr, same stmt (M1)
                 stripe_payment_method_id=<pinned>, amount_cents=<pinned open>,
                 service_amount_cents=<pinned>, client_fee_cents=<pinned>, updated_at=now
                 WHERE id=? AND dry_run=0 AND status IN ('pending','failed_retryable','skipped_capped','aborted_ineligible')
                       AND (retry / cap / re-qualification guards)     ← single statement, atomic in D1
                        │
     re-read row; proceed ONLY IF status='charging' AND claim_token=OURS  (else another worker owns it → no-op)
                        │
     ┌──────────────────┴─ §6.2a POST-CLAIM RE-VERIFICATION (MAJOR-1) ──────────────────┐
     │  re-read installment + invoice + consent; if ANY §5.1 condition no longer holds   │
     │  (invoice voided, installment manually recorded 'paid', consent revoked, etc.)    │
     │  OR the freshly-recomputed payable ≠ the pinned amount_cents (rev-2.1 R-2 —       │
     │  amount drift after claim = an overcharge waiting to happen):                     │
     │    CAS  UPDATE … SET status='aborted_ineligible' WHERE id=? AND status='charging'  │
     │         AND claim_token=OURS   → a provable non-charged terminal; DO NOT POST.     │
     └──────────────────┬────────────────────────────────────────────────────────────────┘
                        │  (all conditions still hold AND recomputed payable == pinned)
     ┌──────────────────┴─ §6.2b CROSS-CHANNEL RESOLUTION (BLOCKER-1) ─────────────────────┐
     │  if payment.stripeCheckoutSessionId set AND stripeCheckoutStatus='link_ready':      │
     │    GET the session at Stripe (fetchStripeCheckoutSessionReturnUrls,                 │
     │        stripe-checkout.ts:87-106 → {status}):                                        │
     │      • status='complete' → the client already paid the manual link. DO NOT charge;  │
     │        CAS row → 'aborted_ineligible', then synchronously settle (§6.2b prose).     │
     │      • status='open'     → EXPIRE it first (expireStripeCheckoutSessionById,         │
     │        stripe-checkout.ts:112-125) so the hosted tab can never be completed later,   │
     │        THEN proceed to POST. Expire REJECTED → re-GET; complete → abort as above;    │
     │        anything else → DO NOT POST this tick (rev-2.1 R-3).                          │
     │      • status='expired' → already uncompletable; proceed to POST.                    │
     │      • read returns NULL → a session id EXISTS, so null = THE READ FAILED (the       │
     │        helper returns null on any network throw / non-OK, stripe-checkout.ts:95,105) │
     │        → FAIL CLOSED: DO NOT POST; CAS row back to 'pending' (token-guarded — a      │
     │        provable nothing-was-sent) so the next tick retries resolution (rev-2.1 R-1). │
     └──────────────────┬─────────────────────────────────────────────────────────────────┘
                        │
     POST /v1/payment_intents  (off_session:true, confirm:true, customer, payment_method,
                 amount=<pinned amount_cents>, currency,
                 metadata[autopay_charge_id/invoice_payment_id/invoice_id/project_id],
                 metadata[service_amount_cents]=<pinned>, metadata[client_fee_cents]=<pinned>,  ← MAJOR-2
                 Idempotency-Key: <pinned idempotency_key>)
                        │
     (persist stripe_payment_intent_id on the row, token-guarded, the moment the POST returns ANY
      PI object — including an error body that carries one — MAJOR-3)
                        │
        ┌───────────────┼───────────────────────────┬─────────────────────────┐
   succeeded          requires_action        card declined (provable)     network throw / 5xx / timeout
   (or webhook)       (SCA)                  (card_declined, etc.)         (AMBIGUOUS — money may have moved)
        │                │                          │                          │
  status='charged'  status='needs_action'    attempt<max?                 LEAVE status='charging'
  charged_at=now    fall back to manual      ├ yes → failed_retryable,     (TERMINAL-UNKNOWN)
  (invoice_payments  link + notify; NO        │       next_attempt_at=+backoff   NEVER auto-retry;
   recorded by the   off-session retry        └ no  → failed_terminal,      reconcile-against-Stripe
   webkook path)     (would just re-fail)             manual fallback + alert     tripwire (§6.4)
```

### 6.2 The claim (D1 has no transactions — single-statement CAS)

- **Layer 1 — one *real* row per installment, ever.** `INSERT INTO autopay_charges (…, status,
  dry_run) VALUES (…, 'pending', 0) ON CONFLICT(invoice_payment_id) WHERE dry_run = 0 DO NOTHING` and
  check whether the row was created (drizzle `.returning()` length, like `insertLedger`,
  `sequences.ts:344-345`). The conflict target is the **partial** index `WHERE dry_run = 0`, so
  pre-existing `dry_run = 1` audit rows are **invisible** to it and never suppress the real INSERT
  (BLOCKER-2). Two concurrent *live* cron ticks racing the same fresh installment: **exactly one**
  INSERT wins; the loser sees the existing real row and re-evaluates it. **M2 — orphaned-pending
  resolution:** on INSERT-conflict, if the existing real row is `pending` (a prior tick claimed the
  row's existence but crashed before the Layer-2 CAS), the loser **proceeds to the Layer-2 CAS claim
  below** — a `pending` non-dry-run row is claimable, not a dead end. (Only `charging`/`charged`/
  terminal rows short-circuit to skip.) This alone prevents two *first* charges while never stranding
  a half-claimed row.
- **Layer 2 — per-attempt CAS claim with a claim token.** To move `pending` (or a retry-eligible
  `failed_retryable`, a now-under-cap `skipped_capped`, or a now-re-qualified `aborted_ineligible` —
  rev-2.1 R-4) → `charging`, issue **one**
  `UPDATE … SET status='charging', claim_token=<new uuid>, idempotency_key=<id> || ':' ||
  (attempt_count + 1), amount_cents=<pinned>, service_amount_cents=<pinned>, client_fee_cents=<pinned>,
  stripe_payment_method_id=<pinned>, attempt_count = attempt_count + 1
  WHERE id=? AND dry_run = 0 AND status IN ('pending','failed_retryable','skipped_capped',
  'aborted_ineligible') AND <retry / cap guards>`. (`aborted_ineligible` reaches this CAS only when
  the tick's §5.1 rule-6 evaluation re-qualified it; §6.2a then re-verifies everything again
  post-claim with fresh pins, so a row that only *looked* re-qualified aborts right back without a
  POST — the re-claim path is self-guarding.) The `AND dry_run = 0` is mandatory (BLOCKER-2) — the CAS can **never** claim a dry-run
  audit row. The `idempotency_key` and `attempt_count` are computed **in this one statement** so the
  key's attempt suffix always matches the incremented count (M1) — never JS-computed from a pre-read
  that could drift. Then **re-read** and proceed **only if** `status='charging' AND claim_token` equals
  ours. A loser's UPDATE matches 0 rows (status already `charging`) → its re-read shows a foreign
  token → it does **not** POST. This is the exact winner-detection the refund path uses
  (`stripe-refund-initiation.ts:438-465`) — a plain status re-read is insufficient because both racers
  would read `charging`; the **token** is what identifies the single winner.

#### 6.2a Post-claim re-verification (MAJOR-1 — close the TOCTOU window)

The Layer-2 CAS guards **only** `autopay_charges.status`. Between the §5.1 eligibility SELECT and the
PI POST the world can change: the installment can be **manually recorded `paid`**, the invoice
**voided/reissued**, or **consent revoked** — none of which the status-only CAS notices. The refund
precedent re-checks after winning the claim (`stripe-refund-initiation.ts:467-489`, step 8b); rev-1
cited the pattern but dropped the step. **Mandate:** after the re-read confirms `status='charging' AND
claim_token=OURS`, and **before** the POST, **re-read the installment + its invoice + the consent** and
re-evaluate every §5.1 condition (invoice on the collectible allowlist, installment still open/payable,
active consent with current `consent_version` + a `pm_…`). **AND re-verify the AMOUNT (rev-2.1 R-2):**
recompute `invoicePaymentClientPayableOpenCents(P, …)` from the fresh read and require it to **equal
the pinned `amount_cents`** (and the recomputed `invoicePaymentOpenCents` to equal the pinned
`service_amount_cents`). The eligibility booleans alone don't catch an installment *edited/paid-down*
in the window — `payable > 0` still holds while the pinned number is now an **overcharge**. This is
the refund precedent's own 8b move applied to the number, not just the flags
(`stripe-refund-initiation.ts:467-489` re-reads and reverts token-guarded). If **any** condition no
longer holds **or the recomputed payable ≠ the pinned amount**, CAS the row to a **provably
non-charged terminal**:
`UPDATE … SET status='aborted_ineligible', last_error=<reason>, updated_at=now WHERE id=? AND
status='charging' AND claim_token=<ours>` — and **do not POST**. (An amount-drift abort is not a
dead end: `aborted_ineligible` is conditionally re-claimable on full §5.1 re-qualification — see
§3.2 — so the next tick re-claims with a freshly pinned, correct amount.) Only when every condition
still holds does the engine continue to §6.2b.

#### 6.2b Cross-channel resolution — the manual checkout link stays live (BLOCKER-1)

The manual per-installment checkout channel is **not** torn down when autopay is on, so the **same
installment** has two live payment paths. Two double-charge hazards, both real:

1. **Manual pays first, autopay claims before the webhook lands.** Client pays the manual Stripe link
   at T0; the `checkout.session.completed` webhook is delayed (minutes–hours); the hourly cron at
   T0+1h still sees the installment `open`/`pending` in the CRM → claims it → issues a **second real
   charge**.
2. **Autopay charges while a hosted checkout tab is still open.** Autopay charges at the due date while
   the client has a still-open Stripe-hosted checkout page (sessions live ~24h; merely hiding the
   `/portal` link post-settle does **not** invalidate the hosted page) → the client later completes it
   → a **second charge**.

`UNIQUE(external_payment_id)` (`migrations/0029`) prevents double-**recording**, not double-**charging**
— the second webhook hits the already-paid ignore branch (`stripe-checkout.ts:487-499`) and today is
**silently swallowed**. Two mandated fixes:

- **Pre-POST session resolution (in §6.2b of the state machine, after §6.2a passes):** if
  `payment.stripeCheckoutSessionId` is set **and** `payment.stripeCheckoutStatus === "link_ready"`,
  **GET the session at Stripe** using the existing read helper `fetchStripeCheckoutSessionReturnUrls`
  (`stripe-checkout.ts:87-106`, which returns `status ∈ {"open","complete","expired"}`):
  - `status === "complete"` → the client already paid via the manual link. **Do NOT charge.** CAS the
    row to `aborted_ineligible` (release the claim to a non-charged terminal), then **synchronously
    settle (rev-2.1 R-7)**: perform a **full session GET** (`GET /v1/checkout/sessions/:id` — the
    return-urls helper's `{successUrl, cancelUrl, status}` shape is NOT enough to drive settlement)
    and invoke `settleInvoicePaymentCheckoutSession` with it so the manual payment is recorded
    immediately rather than waiting on the delayed webhook. If that synchronous settle fails, the
    delayed webhook remains the recorder of record — and a **tripwire covers the gap** (§6.4 signal 4:
    an `aborted_ineligible` row whose abort reason is `session_complete` with the installment still
    unpaid after ~1h ⇒ CRITICAL "paid at Stripe, unrecorded").
  - `status === "open"` → **expire it first** via the existing `expireStripeCheckoutSessionById`
    (`stripe-checkout.ts:112-125`) so the hosted tab becomes uncompletable, **then** POST the
    PaymentIntent. No residual completion path can fire a second charge afterward. **Expire REJECTED
    (rev-2.1 R-3):** Stripe's `/expire` fails on a session that completed in the window between the
    GET returning `open` and the expire call, and the helper **throws** on non-OK — this rejection is
    a *signal*, not noise. On any expire failure: **re-GET the session**; if now `complete` → the
    complete-branch above (abort + settle); anything else (including a second failure) → **do NOT
    POST this tick**; CAS the row back to `pending` (token-guarded) and let the next tick re-resolve.
    Never import §6.6's "cancel is benign, proceed regardless" posture here — an unresolved expire
    followed by a POST is exactly the double-charge this section exists to prevent.
  - `status === "expired"` → already uncompletable; proceed to POST.
  - **The read returns `null` → FAIL CLOSED (rev-2.1 R-1).** When `stripeCheckoutSessionId` is
    non-null a session provably exists, so `null` can only mean **the read failed** —
    `fetchStripeCheckoutSessionReturnUrls` returns null on ANY failure (network throw, timeout,
    non-OK: `stripe-checkout.ts:95,105`), and Stripe flakiness correlates with exactly the delayed-
    webhook danger window. **Do NOT POST.** CAS the row back to `pending` (token-guarded — provably
    nothing was sent) so the next tick retries resolution. Rev-2's "null → proceed" read is
    superseded: proceeding on a failed read charges with a possibly-complete session outstanding.
- **Settle-path already-paid branch must distinguish replay from a real second charge (§6.5).** The
  branch at `stripe-checkout.ts:487-499` currently treats *every* event for an already-`paid`
  installment as a silent no-op. The autopay sibling recorder MUST instead compare the incoming
  `pi_…`/`external_payment_id` against the one already recorded on the installment: **same** id → a
  true idempotent replay (no-op, as today); **different** id arriving for an already-paid installment →
  **money moved twice** → raise a **CRITICAL** alert and flag the row as a **Phase 9b refund
  candidate** (the second charge must be refunded) — never silently ignored.

### 6.3 The Stripe idempotency key strategy

- The key for the current attempt = **`${autopay_charges.id}:${attempt_count}`**, **materialized by
  the claiming UPDATE itself** — the statement sets `idempotency_key = id || ':' || (attempt_count +
  1)` in the **same** UPDATE that increments `attempt_count`, so the stored key's suffix is always the
  post-increment count and can never drift from a stale JS pre-read (M1). It is pinned **before** the
  network call and never regenerated for the same attempt. Stripe idempotency keys dedupe for ~24h.
- **Within one attempt** (crash between claim and terminal update, a retried cron tick, a duplicated
  request): re-sending with the **same** pinned key returns Stripe's original result — no second
  charge. This is the crash/retry guarantee.
- **Across attempts** (a *confirmed* decline → a deliberate new attempt hours/days later): a **new**
  key `${id}:${attempt_count+1}` is used, because the prior attempt provably did **not** charge (a
  confirmed decline is not money movement) and Stripe would reject reusing the old key with different
  parameters anyway.
- The PaymentIntent carries `metadata[autopay_charge_id]`, `metadata[invoice_payment_id]`,
  `metadata[invoice_id]`, `metadata[project_id]` so the webhook reconciles precisely, **plus
  `metadata[service_amount_cents]` and `metadata[client_fee_cents]` — the split frozen at claim time**
  (MAJOR-2), mirroring exactly how the manual checkout pins `metadata[service_open_cents]` at mint
  (`stripe-checkout.ts:364`). The recorder (§6.5) consumes these pinned values and **never re-derives
  the split at webhook time.** `off_session: true` + `confirm: true` so it charges without the
  customer present.
- **Persist the PI id immediately (MAJOR-3).** The synchronous POST handler writes
  `stripe_payment_intent_id` onto the row **token-guarded** (`WHERE id=? AND claim_token=<ours>`) the
  moment the POST returns **any** PI object — including a decline/error body that still carries a
  `pi_…`. Without this, a later webhook (or reconcile) for that PI cannot be matched to its row, and
  the out-of-order CAS guards in §6.5 (which key on `stripe_payment_intent_id`) have nothing to match.
- **Final DB backstop (I3 layer 4):** the webhook recorder writes `invoice_payments.externalPaymentId
  = pi_…`, and `idx_invoice_payments_external_payment_unique`
  (`migrations/0029_unique_external_payment_ids.sql`) makes recording the same PI against two
  installments impossible — a defense even if every higher layer were bypassed (exactly the guard
  `settleInvoicePaymentCheckoutSession` already leans on, `stripe-checkout.ts:479-484`).

### 6.4 TERMINAL-UNKNOWN & reconciliation (never blind-retry money)

- If the PaymentIntent POST **throws** (network error, timeout, 5xx) the charge state is **ambiguous**
  — Stripe may have created and confirmed the PI. The row is **left `charging`**; the engine **never**
  auto-retries a `charging` row (a blind retry after the ~24h key window could double-charge). This is
  the refund `submitting` posture (`stripe-refund-initiation.ts:370-380`) and the sequence `claimed`
  posture (`sequences.ts:634-636,671`) applied to a charge.
- **Recovery = reconcile-against-Stripe** (human-in-the-loop, surfaced by a tripwire — never a
  re-POST): a new `getAutopayChargeReconciliation()` mirroring
  `getRefundInitiationReconciliation` (`stripe-refund-initiation.ts:564-614`) surfaces:
  (1) a `charging` row older than ~1h → **"autopay charge stuck in-flight — reconcile against
  Stripe"**; (2) a `charged` row with no matching recorded `invoice_payments` (webhook never landed)
  older than ~24h → **"autopay charge not reconciled"**; (3) **MINOR-5 — a `pending` consent row with
  a non-null `setup_intent_id` (`seti_…`) older than ~1h → a WARN "autopay consent stuck pending"
  tripwire** (the SetupIntent likely succeeded/failed but no webhook attached it; a card may be
  saved-but-unlinked or the client is stranded mid-flow). WARN, not CRITICAL — no money is at risk, but
  it must not sit silently; (4) **rev-2.1 R-7 — an `aborted_ineligible` row whose abort reason is
  `session_complete` (§6.2b found the manual session paid) with the installment still unsettled after
  ~1h → CRITICAL "paid at Stripe, unrecorded"** — covers a complete-session whose synchronous settle
  failed AND whose `checkout.session.completed` webhook never landed (signal 2 covers only `charged`
  rows, so without this the client's real payment would sit unrecorded with no signal).
- **How to query Stripe for a stuck `charging` row (MINOR-1):** Stripe has **no** "get by idempotency
  key" API, so **do not** attempt one. Reconcile by either (a) the row's `stripe_payment_intent_id`
  (persisted per MAJOR-3) via `GET /v1/payment_intents/:id` if present, or (b)
  `GET /v1/payment_intents/search?query=metadata['autopay_charge_id']:'<id>'` to discover whether a PI
  was created and its status. **Search is eventually consistent — up to ~1 minute of indexing lag
  (rev-2.1 build caution)** — so a "no PI exists at all" conclusion must NEVER rest on a search miss
  alone for a young row. The ≥1h tripwire age makes this moot in the normal flow; a *manual* reconcile
  attempted sooner must corroborate a search miss (re-search after a delay, and check the row's
  persisted `pi_…` from any captured POST response) before concluding no charge exists. Then
  **hand-resolve** the row along one of the **enumerated legal manual
  transitions** (no other transition is permitted from `charging`):
  - PI found `succeeded` → CAS `charging → charged` and re-drive the settle recorder (records the
    installment `paid`).
  - PI found `requires_action` → CAS `charging → needs_action` (manual on-session fallback, §6.6).
  - PI found `canceled` / a confirmed decline / **no PI exists at all** (POST never reached Stripe) →
    CAS `charging → failed_retryable` (if under the attempt cap) or `failed_terminal` (manual
    fallback). "No PI exists" is the only case where re-charging is safe, and even then it goes through
    a fresh claim/attempt, never a blind re-POST of the stuck row.
  Both money-relevant signals (1) and (2) feed `computeSystemHealth` as CRITICAL with per-row
  `alertKey`s (mirror `critical:refund_stuck:${id}`, `system-health.ts:404`); signal (3) feeds a WARN
  key. A stuck charge pages Tyler.

### 6.5 Webhook reconciliation → converge invoice state (reuse the existing path)

Extend `handleStripeCheckoutWebhook`'s dispatch (`stripe-checkout.ts:704-727`) to route:

- **A `payment_intent.succeeded` (or `payment_intent.payment_failed`) WITHOUT
  `metadata.autopay_charge_id` is IGNORED (test (c)).** Once the Dashboard subscribes PI events,
  ordinary manual-checkout PIs also emit `payment_intent.succeeded`; the autopay handlers key **only**
  on `metadata.autopay_charge_id` and treat a non-autopay PI as out of scope — it is neither a
  `stripe-webhook` failure nor an autopay success (the manual checkout path continues to record via
  `checkout.session.completed` as today). No canonical write, no heartbeat drift.
- **`payment_intent.succeeded`** where `metadata.autopay_charge_id` is present →
  `recordAutopayPaymentIntentSucceeded(pi)`. Every row transition here is a **single-statement CAS**
  (MAJOR-3). **Success is convergent-idempotent:** move the row to `charged`
  `UPDATE … SET status='charged', charged_at=now WHERE id=? AND status IN ('charging','charged')` (so
  a replay or an out-of-order arrival converges rather than throws), then record the installment
  through the **same convergence as the checkout settle** (`stripe-checkout.ts:526-585`): set
  `invoice_payments.status='paid'`, `paidAmountCents = service_amount_cents` and `clientFeeCents =
  client_fee_cents` **read from the pinned values (MAJOR-2), never re-derived at webhook time** —
  **the `autopay_charges` ROW is canonical (rev-2.1 R-9); the PI-metadata mirror is a cross-check
  only.** The recorder consumes the row's pinned split; if the PI metadata disagrees with the row
  (should be impossible — both were written by the same claiming statement — but Murphy) it records
  from the ROW and raises a WARN health signal ("autopay split mirror mismatch") so silent
  divergence is logged, never guessed at. Then `externalPaymentId = pi.id`, recompute the invoice
  with `reconciledInvoicePaymentStatus`, and `autoAdvanceProjectStageForRetainerPayment`. **Idempotent
  replay of the SAME `pi_…`** = no-op on an already-`paid` installment. **A DIFFERENT `pi_…` for an
  already-`paid` installment (BLOCKER-1)** = money moved twice → **CRITICAL** alert + flag as a Phase
  9b refund candidate, **not** the silent ignore of `stripe-checkout.ts:487-499`. Reuse — do not
  re-derive — the amount/fee arithmetic (I7).
- **`payment_intent.payment_failed`** with `metadata.autopay_charge_id` → read the failure code and
  apply a **token/PI-guarded single-statement CAS** so a stale, out-of-order failure can never regress
  a superseded attempt (MAJOR-3):
  `UPDATE … SET status=<failed_retryable|failed_terminal|needs_action>, … WHERE id=? AND
  status='charging' AND stripe_payment_intent_id=<this event's pi id>`. Because the guard pins **both**
  `status='charging'` **and** the specific `stripe_payment_intent_id`, a late `payment_failed` for a
  **superseded** attempt (e.g. attempt-1 PI-A declines days later, after attempt-2 PI-B already carried
  the row to `charged`) matches **0 rows → a no-op** — it cannot regress `charged → failed_retryable`
  and trigger a third charge. A provable decline (`card_declined`, `insufficient_funds`,
  `expired_card`, …) → `failed_retryable` (schedule `next_attempt_at`) or `failed_terminal` at the cap
  (§6.6); `authentication_required` → `needs_action` (§6.6). The `payment_intent.succeeded` path is
  authoritative for money-recording even if the synchronous POST response was ambiguous — a `charging`
  row that later receives `payment_intent.succeeded` converges to `charged`+recorded (the ambiguity
  resolves itself the moment the webhook lands; reconciliation only fires if it doesn't).
- These events ride the **already-verified** `stripe-webhook` heartbeat key (money-state-drift ⇒
  CRITICAL, `system-health.ts:118`); pre-verification rejects stay on `stripe-webhook-rejected`
  (`stripe/webhook/route.ts:28,55-59`). No new webhook endpoint, no new bypass-list entry (I5).

### 6.6 Off-session failure handling (I8 — decline / SCA / never-infinite)

- **Provable decline** (`card_declined`, `insufficient_funds`, `expired_card`, `processing_error`):
  `failed_retryable`, `next_attempt_at = now + backoff` (e.g. +1d, +3d, +5d), up to
  `AUTOPAY_MAX_ATTEMPTS` (default **3**). At the cap → `failed_terminal`: **stop auto-charging this
  installment**, mint/surface the existing **manual checkout link** (`createInvoicePaymentCheckoutSession`,
  unchanged) so the client can pay on-session, and **notify Tyler** (a CRITICAL/ WARN alert +
  dunning re-enters via the existing reminders). Never a 4th silent retry.
- **`authentication_required` (SCA / 3-D Secure):** an off-session charge **cannot** complete SCA
  (the customer isn't present). Mark `needs_action` **immediately** (no off-session retry — it would
  deterministically re-fail), fall back to the **manual on-session checkout link** (where the client
  *can* authenticate), and notify. This is the standard Stripe off-session→on-session recovery.
- **Cancel the residual PI before the manual fallback (MINOR-2).** Whenever the engine gives up
  off-session and hands the installment back to the manual checkout link (`needs_action` /
  `failed_terminal`), it MUST first **cancel any still-cancelable PaymentIntent**
  (`POST /v1/payment_intents/:id/cancel`, using the row's `stripe_payment_intent_id`) so there is
  **no residual completion path**: an `authentication_required` PI left open could otherwise later be
  confirmed by the client *and* charged via the fresh manual link → a double charge. Cancel of an
  already-terminal (`canceled`/failed) PI is a benign error and the mint proceeds. **BUT (rev-2.1
  R-5): if the cancel is rejected because the PI just SUCCEEDED** (the slow-confirm race — money
  moved between our decision to fall back and the cancel call), "proceed regardless" would mint a
  manual link **on top of a succeeded charge**. Mandate: on any cancel rejection, **GET the PI**
  (`GET /v1/payment_intents/:id`); if `status === "succeeded"` → **do NOT mint the manual link**;
  converge the row `charging/needs_action → charged` and drive the settle recorder (the §6.5 success
  path) instead. Only a confirmed non-succeeded PI proceeds to the manual fallback. (Near-unreachable
  in practice — the off-session PI's client secret is never handed to anyone — but a literal reading
  of "proceed regardless" ships the fail-open, so the spec closes it.)
- **`insufficient_funds`** is treated as retryable (transient) up to the cap; a hard decline
  (`card_declined` with a terminal `decline_code` like `stolen_card`/`lost_card`) short-circuits to
  `failed_terminal` + manual fallback (no point retrying a dead card).
- In **every** terminal-fallback case the installment reverts to the *pre-autopay* world: a manual
  link + dunning. Autopay never leaves an installment in a state with **no** way to collect.

---

## 7. Flags, dark mechanism & the enablement runbook (the money gate)

All helpers in `src/lib/finance-flags.ts` (or a sibling `autopay-flags.ts`), each **read in the body,
strict**, modeled on `refundInitiationEnabled` / `financeRefundRecordingMode` (`finance-flags.ts`):

| Flag | Type | Default | Meaning |
| --- | --- | --- | --- |
| `AUTOPAY_ENABLED` | strict `=== "1"` | **off** | Master. Off ⇒ total no-op (I1): no consent UI, SetupIntent route no-ops, cron selects nothing, schema unread. **Tyler-only flip #1.** |
| `AUTOPAY_CHARGE_MODE` | **two-state** (`log_only` \| `live`), read like `financeRefundRecordingMode` | **`log_only`** | `log_only`: engine runs, selects, writes `dry_run=1` would-charge ledger rows + logs "WOULD charge $X on installment Y" — **zero Stripe charge calls, zero client emails**. `live`: real off-session charges. Any unset/typo → `log_only` (fail-safe). **Read exactly ONCE at tick start** and pinned into every row's `dry_run` at INSERT (§6.1, BLOCKER-2) — never re-read per row mid-tick. **Tyler-only flip #2 — the first live charge.** |
| `AUTOPAY_MAX_CHARGE_CENTS` | integer cents | e.g. `100000` ($1,000) | Per-charge hard ceiling. Payable above it ⇒ `skipped_capped` + alert, never charged (§5.1 rule 7). |
| `AUTOPAY_PILOT_ALLOWLIST` | comma-sep project ids | unset (= all) | When set, only listed projects auto-charge — a controlled first-live pilot on one friendly client. |
| `AUTOPAY_MAX_ATTEMPTS` | integer | `3` | Retry cap (I8). |
| `AUTOPAY_BATCH_MAX` | integer | `50` | Max installments charged per tick (§5.3). |

**Why `log_only` is the design's spine (Guardrail 2):** the master flag ON + `log_only` gives Tyler a
**full observation cycle** — he watches the digest / `/system-status` show *exactly which installments
would be charged, for how much, on what date* — with **no money moving and no client emailed**. Only
after a clean cycle does he flip `AUTOPAY_CHARGE_MODE=live`, initially with a low
`AUTOPAY_MAX_CHARGE_CENTS` and a one-project `AUTOPAY_PILOT_ALLOWLIST`. This is the money-math gate,
directly analogous to Phase 9a's `record_only → enforce` observation window (`finance-flags.ts:1-13`).

**The money-gate ordering is load-bearing (M5).** The **Fable money-math + idempotency review of the
diff (Guardrail 3) gates the MERGE/DEPLOY** — it happens **before** any migration, deploy, or flag
flip, so no code that could move money ever ships, and the review **never sits after real-client
consent has been captured**. The sequence is therefore, strictly in order:

**Step 0 — Fable diff review (Guardrail 3), the MERGE/DEPLOY gate.** The hardest money-math +
idempotency review runs against the diff **before** it is merged/deployed. Only a passing review
unlocks the dark deploy below. (Rev-1 placed this review as runbook step 4 — *after* consent capture
and a `log_only` cycle; corrected here.)

**Dark deploy (Tyler's machine — the remote env has no Cloudflare creds, `handoff §5`; only after Step
0 passes):**
1. Apply migration `0099` to D1 (additive, `CREATE TABLE IF NOT EXISTS`; inert while dark).
2. `npm run deploy` (app Worker via OpenNext) — ships the routes/engine **inert** (`AUTOPAY_ENABLED`
   off ⇒ every path no-ops).
3. Register the `autopay-charge` cron trigger — with the flag off it records `ok` + skips, so wiring
   it early is safe and starts the heartbeat.

**Enablement runbook (Tyler, in order — do NOT skip a step):**
1. Confirm `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` are set; confirm the Stripe Dashboard webhook
   subscribes `setup_intent.succeeded`, `setup_intent.setup_failed`, `payment_intent.succeeded`,
   `payment_intent.payment_failed` (in addition to the existing checkout events).
2. **Flag on, `log_only`.** Set `AUTOPAY_ENABLED=1` (charge engine stays `log_only` by default).
   **Consent capture goes live.** Have a test/friendly client turn on autopay; confirm the SetupIntent
   succeeds, the card shows on the consent row (last4/brand only — I4), and `autopay.consent_granted`
   is logged.
3. **Observe a full billing cycle in `log_only`.** Confirm the engine writes `dry_run` would-charge
   rows for the right installments, right amounts, right dates; confirm **no** Stripe charge and **no**
   client email fired. Reconcile the dry-run ledger against what a human would have charged.
4. **Tyler's explicit go.** Only after a clean observation cycle does Tyler authorize the first live
   charge (Guardrail 2 — money movement pauses for Tyler).
5. **First live charge:** set a low `AUTOPAY_MAX_CHARGE_CENTS`, set `AUTOPAY_PILOT_ALLOWLIST` to one
   project, then flip `AUTOPAY_CHARGE_MODE=live`. Watch the single charge end-to-end: PI succeeds →
   `payment_intent.succeeded` → installment `paid` → invoice recomputed → receipt emailed. Confirm the
   `autopay_charges` row is `charged` + reconciled and `/system-status` shows no stuck tripwire.
6. Gradually widen the allowlist / raise the cap. **Rollback at any point = set `AUTOPAY_CHARGE_MODE=
   log_only`** (instant, no redeploy — stops all real charges while consent/observation continue) or
   `AUTOPAY_ENABLED` unset (full revert).

**`AUTOPAY_CONSENT_VERSION` bumps are money-halting — pair every bump with a health signal (MINOR-7).**
Bumping `AUTOPAY_CONSENT_VERSION` (§4.2) **silently disqualifies every existing active consent** from
charging (I9 requires an exact version match) until each client re-consents — i.e. a bump **halts all
autopay charging**. So a bump is a deliberate, announced operation, and the health surface MUST expose a
signal: **count of active consents whose `consent_version` != the current `AUTOPAY_CONSENT_VERSION`**
(WARN when non-zero) so a bump can never quietly stop the money. Runbook note: never bump the version
without first confirming this signal is watched and planning the re-consent prompt.

---

## 8. Client-facing transparency (emails — gated + justified)

**Decision: every autopay client email is gated on BOTH `EMAIL_SENDING_ENABLED` AND `AUTOPAY_ENABLED`,
respects `isEmailSuppressed`, and is SUPPRESSED ENTIRELY in `log_only` mode.** Justification: these are
autonomous outbound emails, so they fall under the same email-pause guardrail (Guardrail 2) as every
other outbound send — `EMAIL_SENDING_ENABLED` is the existing master gate and must not be bypassed. And
in `log_only` mode **nothing is actually charged**, so sending "we charged your card" (a lie) or "we'll
charge you in 3 days" (also untrue) would be wrong — client emails only fire in `live` mode.

> ⚠️ **The gate must be enforced INSIDE the new autopay email helper (M4).** The canonical sequence
> transport `sendSequenceEmail` does **not** consult `EMAIL_SENDING_ENABLED` — only the Phase 14 admin
> approved-send path checks it (`emailSendingEnabled()`, `project-communications.ts:552-554`). So it is
> **wrong** to assume "runs through `sendSequenceEmail` ⇒ gated." The autopay email helper MUST itself
> call `emailSendingEnabled()` (fail-closed) **and** check `AUTOPAY_ENABLED`, the `log_only`
> suppression, and `isEmailSuppressed` **before** it hands anything to `sendSequenceEmail`. Test 29
> asserts the gate **at this helper layer** (not at the transport).

Two emails, both reusing the sequence/transport infra (Resend, suppression-checked):

1. **Upcoming-charge notice** (competitor parity — "we'll charge your card in 3 days"). N days before
   an installment's due date (e.g. **3 days**, `AUTOPAY_NOTICE_LEAD_DAYS`), for a qualifying
   installment under active consent: *"Your scheduled payment of $X for <project> will be charged to
   your Visa •••• 4242 on <date>. Questions? Reply here. To cancel autopay, visit your portal."*
   Idempotent (one notice per installment — a `dedupeKey` in the sequence-send ledger style,
   `sequences.ts:300-304`, so a re-tick never double-sends). Emitted by the same hourly engine (or the
   existing sequence runner) — **only in `live` mode**.
2. **Charge receipt** — on each successful auto-charge (driven off `payment_intent.succeeded`, so it
   fires exactly once per real charge, idempotent on the `autopay_charges.charged` transition):
   *"We charged $X to your Visa •••• 4242 for <installment> on <project>. Balance remaining: $Y."*
   with amount, date, last4/brand (I4 — display only), and the portal link.

A **failed** terminal charge (I8) also notifies the client (via the existing dunning/manual-link path)
*and* Tyler — but that reuses the current reminder machinery, not a new autopay email.

---

## 9. What is explicitly OUT of scope for v1

- **ACH / bank debits.** Card only. (ACH has different SetupIntent/mandate + settlement semantics.)
- **Variable / metered / usage-based amounts.** Only fixed, pre-scheduled installment amounts.
- **Partial autopay / client-chosen amounts.** The engine charges the installment's full payable open
  balance or nothing.
- **Multiple saved cards / card-picker.** One active card-on-file per project; a new card supersedes.
- **Autopay for scheduler-booking deposits** (`scheduler_bookings` ledger) — invoice installments only.
- **Automatic refund / clawback on overcharge or dispute.** Refunds remain the manual, Tyler-gated
  Phase 9b path (`stripe-refund-initiation.ts`). Revoking consent does **not** refund anything.
- **An admin "charge now" / "un-charge" / void-charge UI.** v1 is autonomous-schedule-only; a stuck
  row is hand-reconciled per §6.4. A guarded admin control is a named follow-up, not this phase.
- **Retry beyond `AUTOPAY_MAX_ATTEMPTS`, or dunning redesign.** After the cap it falls back to the
  existing manual-link + reminders unchanged.
- **Soft-decline machine-learning / smart-retry timing.** Fixed backoff schedule only.
- **Migrating existing unpaid installments into autopay retroactively without fresh consent.** Consent
  is forward-looking; only installments due *after* an active consent are eligible.

---

## 10. Test plan (tsx; `npm run test` via `scripts/run-tests.mjs`; build-exit-code gate)

All tests are `*.test.ts`, `assert/strict`, **stub `globalThis.fetch`** so any hit to
`api.stripe.com` is counted (like `email-send-guard.test.ts` / `stripe` tests), and seed a temp
D1/SQLite (`DATABASE_PATH`). **Build gate:** `npm run build` asserting **exit code 0** (a type error
prints after "Compiled successfully" and exits 1), `npm run lint` clean, then `npm run test`.

### 10.1 Flags (dark + fail-safe)
1. `AUTOPAY_ENABLED` unset/`""`/`"0"`/`"true"`/`"on"` → `autopayEnabled()` false; only `"1"` → true.
2. `AUTOPAY_CHARGE_MODE` unset/typo → `log_only`; only literal `"live"` → live; `"log_only"` → log_only.
3. **Master dark no-op:** with `AUTOPAY_ENABLED` off, the cron route records `ok`+skips and makes
   **zero** `api.stripe.com` calls; the SetupIntent route no-ops; the selector returns empty.

### 10.2 Consent / SetupIntent
4. `POST /api/portal/autopay/setup` with a valid portal token → creates one Stripe Customer
   (idempotent on double-call — one `cus`), one SetupIntent, one `pending` consent row with the
   current `consent_version` + a `consent_text_hash`. **No card data stored** (assert no PAN/CVC field
   exists on the row).
5. `setup_intent.succeeded` webhook → consent flips `active`, stores `pm_…` + last4/brand only,
   `autopay.consent_granted` logged. `setup_intent.setup_failed` → `failed`.
6. **IDOR:** the setup/revoke routes derive `project_id` only from the token — a body-supplied
   project/invoice/payment id is ignored; token A can never consent/charge project B.
7. Revoke → single-statement CAS flips `active`→`revoked`, best-effort detach called, audit logged;
   the engine skips that project on the next tick.
8. **Stale consent version:** an `active` consent whose `consent_version` != current version does
   **not** qualify any installment (I9) — assert zero charges.

### 10.3 Selection (§5.1) — each condition in isolation
9. Due-date not arrived / null due → not selected. Due arrived → selected.
10. `void` invoice / `draft` invoice → excluded. `paid`/`waived`/`refunded` installment → excluded
    (open == 0). Payable == 0 → excluded.
11. No active consent → excluded. Active consent + no `pm` → excluded.
12. Amount `> AUTOPAY_MAX_CHARGE_CENTS` → `skipped_capped` row + alert, **zero** Stripe charge.
13. `AUTOPAY_PILOT_ALLOWLIST` set → only listed projects selected; unset → all consented projects.

### 10.4 Idempotency & exactly-once (I3 — the money core)
14. **`log_only` mode:** a fully-qualifying installment → writes a `dry_run=1` `pending` ledger row,
    logs "WOULD charge", makes **zero** `api.stripe.com` charge calls, sends **zero** client emails;
    the installment stays unpaid.
15. **Single happy path (live):** qualifying installment → one `POST /v1/payment_intents` with
    `off_session:true`, `confirm:true`, `Idempotency-Key = ${chargeId}:1`, pinned amount; row →
    `charging`. Then `payment_intent.succeeded` webhook → installment `paid`, invoice recomputed,
    stage advanced, row → `charged`, one receipt email.
16. **Concurrent cron (two ticks, same fresh installment):** exactly **one** *real* (`dry_run=0`)
    `autopay_charges` row exists (the partial `UNIQUE(invoice_payment_id) WHERE dry_run=0`); exactly
    **one** `POST /v1/payment_intents`; the losing tick's claim UPDATE matches 0 rows / foreign token
    and makes no charge call.
17. **Crash/retry within an attempt:** simulate the POST resolving but the terminal UPDATE never
    running (row stuck `charging`); a later tick does **NOT** re-POST (never auto-retry a `charging`
    row); the reconcile tripwire surfaces it after ~1h.
18. **Idempotency key is pinned once per attempt, and a `charging` row is never re-POSTed
    (reframed — MINOR-4).** The rev-1 wording ("re-invoke the charge for the same `charging` row")
    contradicted the invariant that *a `charging` row is NEVER re-POSTed*. Instead assert: (a) the
    claiming UPDATE sets `idempotency_key = ${chargeId}:${attempt_count+1}` and the column is **not**
    mutated again for that attempt; (b) the engine, encountering an existing `charging` row on a later
    tick, makes **zero** `api.stripe.com` calls (no re-POST — it defers to §6.4 reconcile); (c) the
    key's *stability* is what makes Stripe dedupe a genuine transport-level retry **within** the single
    claim window, so no second distinct charge can be created for one attempt.
19. **Double-record backstop:** attempting to record the same `pi_…` against a second installment is
    rejected by `idx_invoice_payments_external_payment_unique` — assert the second record throws /
    no-ops, no double `paid`.
20. **Replayed `payment_intent.succeeded`** on an already-`paid`/`charged` installment → idempotent
    no-op (no second payment, no second receipt).

### 10.5 Failure handling (I8)
21. **Provable decline** (`card_declined`) with `attempt_count < max` → `failed_retryable`,
    `next_attempt_at` set to the backoff; a tick before `next_attempt_at` does NOT retry; a tick after
    retries with a **new** idempotency key `${chargeId}:2`.
22. **At the attempt cap** → `failed_terminal`, manual checkout link surfaced, Tyler alerted, **no**
    further off-session retry ever.
23. **`authentication_required` (SCA)** → `needs_action` **immediately** (no off-session retry),
    manual on-session link surfaced, notify. Assert zero off-session re-POST.
24. **Ambiguous network throw** on the PI POST → row left `charging` (terminal-unknown), no retry,
    reconcile tripwire fires after ~1h; if a later `payment_intent.succeeded` lands, it converges to
    `charged`+recorded (self-heals).

### 10.6 Webhook & security
25. Autopay events ride the **existing** verified route: a bad-signature autopay event is rejected and
    recorded under `stripe-webhook-rejected`, **not** `stripe-webhook` (carve-out preserved).
26. A verified `payment_intent.payment_failed` processing throw records `stripe-webhook` failure +
    returns non-2xx (money-state-drift stays alertable).
27. **Zero canonical mutation from the webhook beyond the reviewed settle path** (mirror
    `observability-guard` zero-write style): the only canonical writes are those
    `settleInvoicePaymentCheckoutSession`'s sibling already makes (installment `paid`, invoice
    recompute, stage) — no other table mutated by untrusted input.

### 10.7 Money-math parity (I7)
28. The auto-charged installment records **byte-identical** `paidAmountCents` / `clientFeeCents` /
    `processingFeeCents` / invoice `amountPaidCents` / stage transition as the **same installment paid
    via the existing manual checkout** would — assert the two paths converge to the identical ledger
    (proves no forked money math).

### 10.8 Email gating (§8)
29. **Gate asserted at the autopay-helper layer (M4).** With `EMAIL_SENDING_ENABLED` off → **zero**
    autopay emails regardless of charges — assert the *autopay email helper itself* short-circuits
    (i.e. it calls `emailSendingEnabled()` and returns before invoking `sendSequenceEmail`), **not**
    that the transport blocked it (the transport does not enforce the gate). `log_only` mode → **zero**
    emails even with `EMAIL_SENDING_ENABLED` on. `live` + `EMAIL_SENDING_ENABLED` on → upcoming-notice
    (once per installment, idempotent) + receipt (once per charge, idempotent); suppressed recipient →
    no send.

### 10.9 Reconciliation tripwires
30. `getAutopayChargeReconciliation`: a `charging` row > ~1h old → "stuck in-flight" signal with a
    per-row CRITICAL `alertKey`; a `charged` row with no recorded `paid` installment > ~24h → "not
    reconciled" signal; a `pending` consent with a `seti_…` > ~1h old → a WARN "consent stuck pending"
    signal (MINOR-5). Fresh rows → no signal.

### 10.10 Rev-2 review additions (cross-channel, TOCTOU, out-of-order, log_only→live)
31. **Cross-channel double charge — both orderings (BLOCKER-1, test (a)).**
    (i) *Manual pays first, webhook delayed:* the installment has a `link_ready` session whose Stripe
    status is `complete`; the tick's §6.2b GET sees `complete` → the row is CAS'd `aborted_ineligible`,
    **zero** `POST /v1/payment_intents`, and the settle path records the manual payment.
    (ii) *Open hosted tab at charge time:* the session status is `open`; the tick calls
    `expireStripeCheckoutSessionById` **before** the PI POST (assert the expire call precedes the
    charge call); a subsequent attempt to complete the (now expired) session settles nothing.
    (iii) *Different-PI after paid:* a `payment_intent.succeeded` carrying a **different** `pi_…` for an
    already-`paid` installment → **CRITICAL** alert + refund-candidate flag, **not** a silent no-op;
    a **same**-`pi_…` replay → silent no-op.
32. **Post-claim ineligibility before POST (MAJOR-1, test (b)).** For each of: invoice **voided**
    after claim; installment **manually recorded `paid`** after claim; **consent revoked** after claim
    — the §6.2a re-verification CASes the row to `aborted_ineligible` and makes **zero**
    `POST /v1/payment_intents` calls.
33. **Non-autopay PI event ignored (test (c)).** A `payment_intent.succeeded` (ordinary manual-checkout
    PI, once the Dashboard subscribes PI events) **without** `metadata.autopay_charge_id` → the autopay
    handler no-ops: no `autopay_charges` write, and it is recorded as **neither** a `stripe-webhook`
    failure **nor** an autopay success (heartbeat unchanged).
34. **`log_only` cycle then live flip with pre-existing dry-run rows (BLOCKER-2, test (d)).** Run a
    full `log_only` cycle (writes one-or-more `dry_run=1` rows for installment P), then flip to `live`:
    the live tick INSERTs **exactly one** `dry_run=0` row for P (partial index does not collide),
    issues **exactly one** real charge, and **zero** `dry_run=1` rows are mutated/claimed/promoted.
35. **Re-consent while an active consent exists (M6, test (e)).** A second `setup_intent.succeeded` for
    a project that already has an `active` consent → the handler first CAS-revokes the prior active row,
    then activates the new one; assert the partial `UNIQUE(project_id) WHERE status='active'` never
    throws and exactly one active consent remains. Simulate a crash **between** the two statements →
    **zero** active consents (fail-safe), no index violation loop.
36. **Late `payment_failed` for a superseded PI vs a `charged` row → no-op (MAJOR-3, test (f)).** A row
    is `charged` via PI-B; a late `payment_intent.payment_failed` for PI-A (a superseded earlier
    attempt) arrives → the PI-guarded CAS matches **0 rows**, the row stays `charged`, and **no** new
    charge/claim is triggered.
37. **`skipped_capped` then cap raised (M3, test (g)).** An over-cap installment → `skipped_capped` +
    one alert; a later tick with the **same** cap re-skips it **silently** (no second alert, no state
    churn); after `AUTOPAY_MAX_CHARGE_CENTS` is raised above the payable, the next tick re-claims the
    `skipped_capped` row and charges it exactly once.

### 10.11 Rev-2.1 verification-pass additions (the fixes' own failure modes)
38. **§6.2b session read FAILS → no charge (R-1).** `stripeCheckoutSessionId` is set and the Stripe
    session GET returns null (stubbed network failure / non-OK) → **zero** `POST /v1/payment_intents`;
    the row is CAS'd back to `pending` (token-guarded); the next tick (read now succeeding) resolves
    and proceeds normally. Assert the fail direction is NOT-charge, never charge-anyway.
39. **Expire rejected because the session completed in the window (R-3).** The §6.2b GET returns
    `open`; the expire call is stubbed to fail (session completed in between); the engine re-GETs,
    sees `complete`, CASes to `aborted_ineligible`, drives settle — **zero** PI POST. A second stub
    (expire fails, re-GET still `open`) → **zero** PI POST this tick, row back to `pending`.
40. **Amount drift after claim → abort, then correct re-charge (R-2).** Claim pins `amount_cents`;
    the installment is edited down before the POST; §6.2a's recomputed payable ≠ pinned → CAS
    `aborted_ineligible`, **zero** POST. The NEXT tick re-qualifies (R-4), re-claims with the fresh
    lower pin, and charges exactly the corrected amount once.
41. **`aborted_ineligible` is re-claimable after cure (R-4).** Consent revoked after claim →
    `aborted_ineligible`; the client re-consents (new active row); the next tick re-claims and
    charges exactly once. Counter-case: invoice **voided** → `aborted_ineligible` stays blocked
    forever (rule 3 never re-qualifies) — no charge, no alert-storm.
42. **Cancel-rejected-because-succeeded → converge, never double-collect (R-5).** The §6.6 fallback's
    PI cancel is stubbed to reject; the follow-up PI GET returns `succeeded` → **no manual link is
    minted**, the row converges to `charged`, the settle recorder runs. Assert a manual link is
    minted ONLY when the post-rejection GET shows a non-succeeded PI.
43. **Dry-run rows are bounded (R-8).** N log-only ticks over the same installment leave exactly
    **one** `dry_run=1` row (upserted, amounts refreshed to the latest observation), not N rows.

---

## 11. Ordered task breakdown (effort / risk)

| # | Task | Effort | Risk | Notes |
| --- | --- | --- | --- | --- |
| 1 | Flag helpers (`autopayEnabled`, `autopayChargeMode`, cap/allowlist/attempts/batch readers) + tests (§10.1) | XS | Low | Copy `refundInitiationEnabled` + `financeRefundRecordingMode` shapes; strict, body-read. |
| 2 | Migration `0099`: `autopay_consents` + `autopay_charges` (+ canon-guard triggers, UNIQUE indexes) | S | Med | Additive, `IF NOT EXISTS`; mirror `0080`/`0091` trigger style. Re-check free number at build. |
| 3 | Schema + Drizzle models for the two tables; `autopay-consent.ts` (version + text + hash) | S | Low | Card display fields only (I4). |
| 4 | Stripe wrappers (raw `fetch`): `createStripeCustomer`, `createSetupIntent` (or Checkout `mode=setup`), `createOffSessionPaymentIntent`, `detachPaymentMethod` — mirror `stripe-checkout.ts:57-79` exactly (auth, version, form body, error cleanup, Idempotency-Key). **Build caution (rev-2.1): `fetchStripeCheckoutSessionReturnUrls` and `expireStripeCheckoutSessionById` are module-PRIVATE in `stripe-checkout.ts` — export them (or exported wrappers) before §6.2b can use them; §6.2b also needs a FULL session GET (the return-urls shape can't drive settle).** | M | **High** | New money-mutation surface (`POST /v1/payment_intents`) — the hardest reuse-verification; assert byte-identical header/version to existing calls. |
| 5 | Consent routes: `POST /api/portal/autopay/setup` + `/revoke` (portal-token-authed, project-from-token, CAS supersede) + tests (§10.2) | M | Med | No IDOR; consent active only via webhook. |
| 6 | Webhook handlers: `setup_intent.*`, `payment_intent.succeeded/payment_failed`; `recordAutopayPaymentIntentSucceeded` reusing the settle convergence; wire into `handleStripeCheckoutWebhook` dispatch + tests (§10.6/10.7) | M | **High** | Reuse — do NOT fork — the settle math (I7). Idempotent replay + external-id backstop. |
| 7 | **The charge engine + CAS state machine** (`autopay-charge.ts`): selection (§5.1), claim-first ledger, per-attempt CAS + claim token, pinned idempotency key, terminal-unknown, decline/SCA handling (§6) + tests (§10.3/10.4/10.5) | **L** | **Highest** | The money core. Model verbatim on `stripe-refund-initiation.ts` + `sequences.ts` claim-first. Gets the hardest Fable review. |
| 8 | Cron route `POST /api/cron/autopay-charge` (clone `cron/sequences/route.ts`) + heartbeat + `log_only` short-circuit | S | Med | Fail-closed secret, fail-loud, `autopay-charger` heartbeat. |
| 9 | Reconciliation tripwires (`getAutopayChargeReconciliation`) + `computeSystemHealth` CRITICAL signals (`autopay-charger` staleness + stuck-charge) + `JobName` union entry | S | Med | Mirror the refund tripwire + `critical:refund_stuck` alertKey. |
| 10 | Client emails: upcoming-charge notice + receipt, gated on `EMAIL_SENDING_ENABLED` ∧ `live`, idempotent, suppression-checked (§8) + tests (§10.8) | M | Med | Reuse sequence/transport infra + dedupe-key idempotency. |
| 11 | Portal UI: "Turn on / off autopay" affordance + saved-card display (flag-gated, hidden when off) | M | Low | Unreachable with `AUTOPAY_ENABLED` off (I1). |
| 12 | Verify: build **exit-code 0**, lint, full test run; dark walkthrough (flag off = unchanged); `log_only` walkthrough (no money, no email) | S | Low | Build-exit-code gate is the hard pass/fail. |

**Highest-risk items are #7 (the CAS money core), #4 (the new PI money-mutation call), and #6 (webhook
recording).** All three carry the money-math + idempotency Fable gate.

---

## 12. Active-Learning pitfalls — pre-empted

- **Off-by-default, strict flag; log_only default:** `AUTOPAY_ENABLED === "1"` and
  `AUTOPAY_CHARGE_MODE` defaulting to `log_only` — both read in the body (no `env={} = process.env`
  default param → avoids TS2559). Dark deploy ⇒ zero behavior change.
- **D1 has no transactions:** every claim/finalize is a **single-statement `INSERT … ON CONFLICT` or
  CAS `UPDATE`** with a claim token + re-read (never `db.transaction`/`db.batch`). The exactly-once
  guarantee rests on the partial `UNIQUE(invoice_payment_id) WHERE dry_run = 0` + the CAS token
  (`AND dry_run = 0`) + the pinned Stripe idempotency key (materialized in the claiming UPDATE) + the
  `UNIQUE(external_payment_id)` backstop — four layers, no transaction. Plus the two cross-channel
  guards: §6.2a post-claim re-verification and §6.2b resolve-the-open-checkout-session before POST.
- **Never blind-retry money:** a `charging` (ambiguous) row is TERMINAL-UNKNOWN; recovery is
  reconcile-against-Stripe, never a re-POST (the refund `submitting` posture).
- **Amount AND split are pinned, never re-computed at charge/webhook time:** the claiming UPDATE pins
  `amount_cents` + `service_amount_cents` + `client_fee_cents` + `idempotency_key` +
  `stripe_payment_method_id` before the network call; the POST sends the row's pinned values and mirrors
  the split into PI metadata; the webhook recorder consumes those pinned values (the refund
  `claimed.amountCents` discipline, extended to the fee split — MAJOR-2).
- **No forked money math:** the charge amount is `invoicePaymentClientPayableOpenCents`; recording
  reuses the `settleInvoicePaymentCheckoutSession` convergence. Neither is re-implemented.
- **Raw `fetch`, pinned `stripe-version`:** match `stripe-checkout.ts` exactly — no `stripe` SDK.
- **Webhook trust boundary:** autopay events ride the existing `verifyStripeWebhookPayload` route with
  the `stripe-webhook`/`stripe-webhook-rejected` carve-out; no new endpoint, no widened bypass list.
- **Secrets:** `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`CRON_SECRET` fail-closed when unset, never
  logged (redaction), never in the repo.
- **Card data:** never on any CRM surface — Stripe-hosted entry, tokenized; store `pm_…` + last4/brand
  only.
- **Build-exit-code gate:** CI/verify asserts `npm run build` exit code 0 (tsx tests don't type-check).

---

## 13. Changelog

### Rev 2 (Fable money-math review) — 2026-07-07

**Verdict: REVISE → all findings applied.** The adversarial money-math review returned **REVISE** with
2 BLOCKERs, 3 MAJORs, 6 MEDIUMs, and 8 MINORs. Every finding is folded in below; each fix was written
against a re-verification of the cited code (`fetchStripeCheckoutSessionReturnUrls`
`stripe-checkout.ts:87-106`; `expireStripeCheckoutSessionById` `:112-125`; the mint-time split pin
`metadata[service_open_cents]` `:364` + settle-time consume `:506-520`; the already-paid ignore branch
`:487-499`; the payable basis `:341-345`; the invoice-reminder allowlist `sequences.ts:506`; the
`emailSendingEnabled` locus `project-communications.ts:552-554`). **Verified-sound and deliberately
NOT regressed:** the Layer-1 INSERT-conflict + Layer-2 token-CAS single-winner claim; terminal-unknown
/ never-blind-retry; webhook-authoritative recording + tripwires; dark purity / secrets / card-data
boundaries.

| # | Severity | Finding | Fix (this rev) |
|---|---|---|---|
| B-1 | BLOCKER | **Cross-channel double charge.** The manual checkout channel stays live for the same installment: (1) manual pays at T0, webhook delayed, hourly cron claims → 2nd real charge; (2) autopay charges while a hosted checkout tab (lives ~24h) is still open → client completes it → 2nd charge. `UNIQUE(external_payment_id)` stops double-**recording**, not double-**charging**; the 2nd webhook hits the already-paid ignore (`stripe-checkout.ts:487-499`) and is silently swallowed. | Added **§6.2b pre-POST cross-channel resolution**: after winning the CAS and before the PI POST, if the installment has a `link_ready` session, GET it at Stripe — `complete` → do NOT charge, CAS row → `aborted_ineligible`, let settle run; `open` → **expire it first** (`expireStripeCheckoutSessionById`) then charge; `expired`/null → charge. And the settle already-paid branch (§6.5) now **distinguishes a same-`pi_…` replay** (true no-op) **from a different-`pi_…` for a paid installment** (money moved twice → CRITICAL + Phase 9b refund candidate). Both orderings added to the test plan (test 31). |
| B-2 | BLOCKER | **`log_only → live` incoherent.** §3.2 said dry-run rows are never promoted AND `UNIQUE(invoice_payment_id)` allows one row ever — so "going live creates a fresh row" was impossible; §6.2's CAS had no `dry_run` guard so it would claim-and-charge a dry-run row; "reconciled/cleared" was undefined. | Made the index **PARTIAL**: `UNIQUE(invoice_payment_id) WHERE dry_run = 0` (§3.2, §6.2 Layer 1, I3, §12) so dry-run rows sit outside the exactly-once ledger. Added `AND dry_run = 0` to the claiming CAS (§6.2 Layer 2) and to eligibility rule 6 (§5.1). Specified `AUTOPAY_CHARGE_MODE` is **read once at tick start** and the `dry_run` decision is **pinned at INSERT**, never re-evaluated per row (§6.1 note, §7 flag table). Dropped the undefined "reconcile/clear" step — dry-run rows are inert history. Test 34 added. |
| M-1 | MAJOR | **Post-claim re-verification (TOCTOU).** The claiming UPDATE guards only `status`; between the eligibility SELECT and the POST the installment can be manually recorded, the invoice voided, or consent revoked. The refund precedent re-checks after winning the claim (`stripe-refund-initiation.ts:467-489` 8b) — dropped in rev-1. | Added **§6.2a post-claim re-verification**: after the token re-read confirms ownership and before the POST, re-read installment + invoice + consent; if any §5.1 condition no longer holds, CAS the row (status+token guarded) to a new provable non-charged terminal **`aborted_ineligible`** and do not POST. New state added to §3.2 + §6.1 diagram. Test 32 (void/manual-record/revoke after claim). |
| M-2 | MAJOR | **Service/fee split source for recording.** The settle recorder derives the split from `amount_total` + `metadata[service_open_cents]` pinned at mint (`stripe-checkout.ts:364,506-520`); rev-1's PI metadata had no `service_open_cents` and the ledger pinned only the total → the recorder would recompute at webhook time and drift if the installment was edited between charge and a delayed webhook. | Pinned **`service_amount_cents` + `client_fee_cents` on the `autopay_charges` row at claim time** (§3.2) and mirror them into **PI metadata** (§6.3) exactly as checkout does; the recorder (§6.5) consumes the pinned values, never a webhook-time recompute. §12 pitfall updated. |
| M-3 | MAJOR | **Webhook transitions not CAS-guarded; PI-id write unspecified.** Out-of-order hazard: attempt-1 PI-A declines (webhook delayed days), attempt-2 PI-B succeeds but its webhook is lost, late PI-A `payment_failed` regresses `charged → failed_retryable` → next tick claims again → 3rd charge. | Every webhook-driven transition is a **single-statement CAS** (§6.5): failure `WHERE id=? AND status='charging' AND stripe_payment_intent_id=?`; success convergent-idempotent (`status IN ('charging','charged')`). The sync-response handler **persists `stripe_payment_intent_id` token-guarded** whenever the POST returns any PI object, including error bodies (§6.3). Test 36 (late `payment_failed` for a superseded PI → no-op). |
| MED-1 | MEDIUM | Idempotency-key computation locus (JS pre-read could drift from the SQL increment). | The key is **materialized in the claiming UPDATE** as a SQL expression from the column: `idempotency_key = id \|\| ':' \|\| (attempt_count + 1)` in the same statement that increments `attempt_count` (§3.2 column, §6.2 Layer 2, §6.3). |
| MED-2 | MEDIUM | §6.1 diagram vs §6.2 CAS contradiction on orphaned `pending` rows. | Stated explicitly (§6.1 diagram + §6.2 Layer 1, "M2"): on INSERT-conflict, a `pending` non-dry-run row **proceeds to the CAS claim** (not a dead end). |
| MED-3 | MEDIUM | `skipped_capped` is a dead end → hourly re-select + alert storm forever after a cap raise. | Defined `skipped_capped` as **re-claimable iff the freshly-pinned payable is now `<= AUTOPAY_MAX_CHARGE_CENTS`** — added to the CAS claimable set under that condition (§3.2, §5.1 rules 6-7, §6.1/§6.2). The alert fires only on the transition into the state, not per re-select. Test 37. |
| MED-4 | MEDIUM | `EMAIL_SENDING_ENABLED` reuse claim is wrong — the transport (`sendSequenceEmail`) does NOT enforce it; only the Phase 14 admin path does (`project-communications.ts:552-554`). | Stated the gate is enforced **inside the new autopay email helper itself** (§2 reuse row, §8); test 29 now asserts it **at that layer**, not the transport. |
| MED-5 | MEDIUM | Money-gate ordering — the Fable review sat after real-client consent capture. | Reordered §7: the **Fable diff review gates the MERGE/DEPLOY** (Step 0, before migration/deploy/flag), then dark deploy → flag on `log_only` → observe → Tyler's go → `live`. |
| MED-6 | MEDIUM | Re-consent vs the partial UNIQUE active index — a card update would brick on the index and poison the money-drift counter. | The activation handler **first CAS-revokes (supersedes) the prior active row, then activates** — two single statements; a crash between them leaves zero active consents (fail-safe) (§4.1 step 4). Test 35. |
| MIN-1 | MINOR | §6.4 reconcile: Stripe has no query-by-idempotency-key API. | Use `GET /v1/payment_intents/search?query=metadata['autopay_charge_id']` (or the stored PI id); enumerated the legal manual transitions from `charging` (§6.4). |
| MIN-2 | MINOR | `needs_action`/`failed_terminal` fallback left a residual PI completion path. | **Cancel the open PI** (`POST /v1/payment_intents/:id/cancel`) before minting the manual link (§6.6). |
| MIN-3 | MINOR | Eligibility rule 3 used a void/draft blocklist (fails open on new statuses). | Switched to the **allowlist** precedent `invoice.status IN ('sent','partially_paid','overdue')` (`sequences.ts:506`) — fails closed (§5.1 rule 3). |
| MIN-4 | MINOR | Test 18 (re-invoking a `charging` row) contradicted "a `charging` row is NEVER re-POSTed." | Reframed test 18 to assert key-pinned-once + zero re-POST + Stripe dedupe of a transport retry. |
| MIN-5 | MINOR | No stuck-pending-consent tripwire. | Added a **WARN** tripwire: a `pending` consent with a `seti_…` older than ~1h (§6.4, test 30). |
| MIN-6 | MINOR | "three-state (`log_only` \| `live`)" — it is two-state. | Corrected to **two-state** (§7 flag table). |
| MIN-7 | MINOR | An `AUTOPAY_CONSENT_VERSION` bump silently halts all charging. | Paired every bump with a **health signal** (count of active consents whose version != current → WARN) + a runbook note (§7). |
| MIN-8 | MINOR | Citation drift: rule 3's precedent is the invoice-reminder scan (`sequences.ts:506`), not "the Phase 22 overdue scan." | Corrected the citation (§5.1 rule 3). |

**Test plan additions (§10.10, tests 31-37 + updated 16/18/29/30):** cross-channel double charge both
orderings (a); void/manual-record/revoke after claim before POST (b); non-autopay `payment_intent.
succeeded` ignored (c); `log_only` cycle then live flip with existing dry-run rows (d); re-consent
while active (e); late `payment_failed` for a superseded PI vs a `charged` row → no-op (f);
`skipped_capped` then cap raised (g); `EMAIL_SENDING_ENABLED` asserted at the autopay-helper layer (h).

No findings were disagreed with or dropped — all 19 are folded in as specified above.

### Rev 2.1 (Fable verification pass on the rev-2 fixes) — 2026-07-07

The verification pass confirmed all 19 rev-2 findings genuinely folded in and nothing verified-sound
regressed, but found two fail-opens **in the fixes themselves** plus posture/coherence amendments.
Verdict: REVISE (narrowly). All 9 residual findings applied:

| # | Severity | Finding (the fix's own failure mode) | Fix in this rev |
| --- | --- | --- | --- |
| R-1 | MAJOR | §6.2b failed OPEN on a failed session read: the helper returns null on ANY failure (`stripe-checkout.ts:95,105`), and rev-2 said "null → proceed to POST" — charging with a possibly-complete session outstanding, exactly when Stripe flakiness also delays the webhook. | Null with a non-null `stripeCheckoutSessionId` = **the read failed** → FAIL CLOSED: no POST; CAS back to `pending` (token-guarded, provably nothing sent); next tick retries resolution (§6.2b + diagram). Test 38. |
| R-2 | MAJOR | §6.2a re-verified the eligibility BOOLEANS but not the AMOUNT — an installment edited/paid-down after claim still passes `payable > 0` while the pinned `amount_cents` is now an overcharge (the same TOCTOU window, applied to the number). | §6.2a now also recomputes the payable and requires it to **equal the pinned** `amount_cents` (+ service split); mismatch → `aborted_ineligible`, no POST; next tick re-claims with a fresh correct pin (§6.2a + diagram). Test 40. |
| R-3 | MEDIUM | Expire rejection unhandled: Stripe `/expire` fails on a session that completed in the GET→expire window; the helper throws; a builder importing §6.6's "benign error, proceed" posture would POST → double charge. | Expire rejected → **re-GET**: `complete` → abort+settle; anything else → no POST this tick, row back to `pending`. §6.6's posture explicitly barred from §6.2b. Test 39. |
| R-4 | MEDIUM | `aborted_ineligible` permanently bricked autopay after a *curable* disqualifier (revoke → re-consent) — blocking + non-claimable + the partial unique index = that installment silently excluded forever. | Made **conditionally re-claimable** on full §5.1 re-qualification (the `skipped_capped` pattern); permanent triggers (void/paid) never re-qualify and stay blocked by the rules themselves (§3.2, §5.1 rule 6, §6.2, diagram). Test 41. |
| R-5 | MEDIUM | §6.6 cancel-PI "benign error … mint proceeds regardless" fails open when the cancel is rejected because the PI just SUCCEEDED (slow-confirm race) → manual link minted on top of a succeeded charge. | Cancel rejected → GET the PI: `succeeded` → do NOT mint; converge to `charged` + settle. Only a confirmed non-succeeded PI proceeds to fallback (§6.6). Test 42. |
| R-6 | MINOR | The transition INTO `skipped_capped` was undefined (no diagram edge; INSERT-as vs CAS-to unspecified). | Defined: fresh over-cap installment → Layer-1 INSERT **directly as** `skipped_capped`; existing claimable row grown over-cap → plain status-guarded CAS (§5.1 rule 7). |
| R-7 | MINOR | §6.2b "let/force the settle path" was vague (the return-urls helper can't drive settle) and a complete-session-with-lost-webhook had no tripwire (signal 2 covers only `charged` rows). | Mandated a synchronous FULL session GET + `settleInvoicePaymentCheckoutSession` invocation; added §6.4 **signal 4**: `aborted_ineligible(session_complete)` + installment unsettled after ~1h → CRITICAL "paid at Stripe, unrecorded" (§6.2b, §6.4). |
| R-8 | MINOR | Dry-run rows unbounded (one per tick — hundreds per installment over a multi-week log-only cycle, burying the human-review ledger). | Second partial index `UNIQUE(invoice_payment_id) WHERE dry_run = 1` + upsert-refresh: at most one dry-run row per installment, amounts refreshed per observation (§3.2). Test 43. |
| R-9 | MINOR | Recorder split source ambiguity ("row / PI metadata"). | The **row is canonical**; PI metadata is a cross-check — mismatch records from the row + raises a WARN ("autopay split mirror mismatch") (§6.5). |

Build cautions folded in: `fetchStripeCheckoutSessionReturnUrls`/`expireStripeCheckoutSessionById`
are module-private and must be exported (task 4); PI search is eventually consistent (~1 min) — a
"no PI exists" conclusion never rests on a search miss alone for a young row (§6.4). Tests 38-43
added (§10.11).

### Rev 1 — 2026-07-07
Initial build-ready spec for Phase 13 (autopay / card-on-file, off-session installment auto-charge).
Written against a read of: the existing Stripe checkout + webhook verify (`stripe-checkout.ts`,
`stripe/webhook/route.ts`), the sole existing money-mutation module + its CAS/idempotency/reconcile
kit (`stripe-refund-initiation.ts`), the claim-first autonomous-send ledger (`sequences.ts`), the
Phase 12 anti-double-charge CAS precedent (`docs/specs/phase-12-unified-sign-pay.md`,
`stripe-checkout.ts:376-394`), the retainer predicate (`retainer-selection.ts`), the cron pattern
(`cron/sequences/route.ts`, `cron/scheduler-reminders/route.ts`), the heartbeat/alerting catalog
(`job-runs.ts`, `system-health.ts`), the three-state finance-flag idiom (`finance-flags.ts`), the
`invoice_payments` schema + the `UNIQUE(external_payment_id)` backstop
(`schema.ts:538-568`, `migrations/0029_unique_external_payment_ids.sql`), and the Phase 21/24 webhook
signature-reject carve-out. Confirmed the repo uses **raw `fetch`** (not the `stripe` SDK) with a
pinned `stripe-version` header. Migration slot `0099` (next free after `0098`; re-check at build).
**Pending: Fable money-math + idempotency review (Guardrail 3) before any build; first live charge
Tyler-gated (Guardrail 2).**
