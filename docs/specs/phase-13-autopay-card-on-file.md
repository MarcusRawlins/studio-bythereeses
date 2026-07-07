# Phase 13 — Autopay / card-on-file (off-session installment auto-charge)

Status: **SPEC (build-ready, pre-Fable).** Roadmap Tier 1 (`docs/roadmap-competitive-parity.md`).
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
  guarantee (§6): (1) a `UNIQUE(invoice_payment_id)` autopay-charge ledger row (one row per
  installment, ever); (2) a single-statement **CAS claim** with a per-attempt claim token (D1 has no
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
| Outbound email master gate (for notices/receipts) | `EMAIL_SENDING_ENABLED` (+ `sendSequenceEmail`, `isEmailSuppressed`) | `email.ts` (see `email-send-guard.test.ts`), `project-communications.ts` | Every client-facing autopay email is gated on `EMAIL_SENDING_ENABLED` **and** suppression (§8). |
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

**One row per installment, ever.** This table IS the idempotency/CAS state machine.

- `id TEXT PRIMARY KEY` — also the base of the Stripe idempotency key (§6.3).
- `invoice_payment_id TEXT NOT NULL` (FK → `invoice_payments.id`).
  **`UNIQUE(invoice_payment_id)`** — the hard guarantee that an installment gets **at most one**
  charge ledger row (I3 layer 1). Claim = `INSERT … ON CONFLICT DO NOTHING` (returns true iff this
  cron tick created it — the `insertLedger` pattern, `sequences.ts:324-346`).
- `invoice_id TEXT NOT NULL`, `project_id TEXT NOT NULL`, `consent_id TEXT NOT NULL` (which consent
  authorized it), `stripe_customer_id TEXT NOT NULL`, `stripe_payment_method_id TEXT NOT NULL`
  (pinned at claim time — the card that was authorized, so a later card swap can't retroactively
  redirect an in-flight charge).
- `amount_cents INTEGER NOT NULL` — pinned at claim time = `invoicePaymentClientPayableOpenCents`
  (I7). The charge sends **this pinned value**, never a re-computed one (mirrors the refund's pinned
  `amountCents`, `stripe-refund-initiation.ts:494`).
- `currency TEXT NOT NULL DEFAULT 'usd'`.
- `status TEXT NOT NULL DEFAULT 'pending'` — the state machine (§6.1):
  `pending → charging → charged | failed_retryable | failed_terminal | needs_action | skipped_capped`.
  Constrained by a canon-guard trigger.
- `dry_run INTEGER NOT NULL DEFAULT 0` — `1` iff this row was created in `log_only` mode (a
  would-charge record; **no Stripe call was made**). A dry-run row is a permanent audit artifact and
  is **never** promoted to a real charge; going live creates a *fresh* row after the dry-run row is
  reconciled/cleared (§7).
- `attempt_count INTEGER NOT NULL DEFAULT 0`, `max_attempts INTEGER NOT NULL`.
- `idempotency_key TEXT` — the exact key sent to Stripe for the **current** attempt (pinned in the
  claiming UPDATE, §6.3). Regenerated only for a *new* attempt after a **confirmed** decline.
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
4. Stripe → `setup_intent.succeeded` webhook (via the existing verified route) → attach: store
   `stripe_payment_method_id`, `card_brand`/`last4`/`exp`, flip consent `status='active'`,
   `consented_at=now`. `logActivity("autopay.consent_granted")`. A `setup_intent.setup_failed` →
   consent `status='failed'` (client can retry).

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
3. `P`'s invoice is **not** `void` and **not** `draft` (excluded exactly as the Phase 22 overdue scan
   excludes them — a void/reissued invoice must never trigger a charge).
4. `P` is **unsettled and payable**: `invoicePaymentOpenCents(P) > 0` (which is `0` for
   `paid`/`waived`/`refunded` via `isSettledInvoicePaymentStatus`, `invoice-balances.ts:66`) **and**
   `invoicePaymentClientPayableOpenCents(P, …) > 0`.
5. `P`'s project has an **`active` `autopay_consents`** row with `consent_version` == current
   `AUTOPAY_CONSENT_VERSION` and a non-null `stripe_payment_method_id` (I9).
6. **No blocking `autopay_charges` row** for `P`: no row in `charged`, `charging`, `needs_action`, or
   `failed_terminal`; a `failed_retryable` row qualifies **only** if `attempt_count < max_attempts`
   **and** `now >= next_attempt_at`.
7. `AUTOPAY_MAX_CHARGE_CENTS` gate: if the payable amount `> AUTOPAY_MAX_CHARGE_CENTS`, the engine does
   **not** charge — it writes a `skipped_capped` ledger row and alerts Tyler (§7). A fat-fingered large
   installment can never be silently auto-drained.
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

```
        (cron selects a qualifying installment P)
                        │
          INSERT autopay_charges (UNIQUE invoice_payment_id) ON CONFLICT DO NOTHING
                        │  claimed = (this INSERT created the row)?
        ┌───────────────┴───────────────┐
       no (a row already exists)        yes → status='pending', dry_run per mode
        │                                        │
   re-evaluate that row's status               (log_only?  → status stays a dry-run record; NO Stripe call; done)
   (retry only if failed_retryable              │
    & attempt<max & now>=next_attempt_at)       │ (live mode)
        └───────────────┬────────────────────────┘
                        ▼
     CAS claim:  UPDATE … SET status='charging', attempt_count+1, claim_token=NEW,
                 idempotency_key=`${id}:${attempt_count+1}`, stripe_payment_method_id=<pinned>,
                 amount_cents=<pinned open>, updated_at=now
                 WHERE id=? AND status IN ('pending','failed_retryable')
                       AND (retry guards)                              ← single statement, atomic in D1
                        │
     re-read row; proceed ONLY IF status='charging' AND claim_token=OURS  (else another worker owns it → no-op)
                        │
     POST /v1/payment_intents  (off_session:true, confirm:true, customer, payment_method,
                 amount=<pinned amount_cents>, currency, metadata[invoice_payment_id/charge_id/...],
                 Idempotency-Key: <pinned idempotency_key>)
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

- **Layer 1 — one row per installment, ever.** `INSERT INTO autopay_charges (…, status)
  VALUES (…, 'pending') ON CONFLICT(invoice_payment_id) DO NOTHING` and check whether the row was
  created (drizzle `.returning()` length, like `insertLedger`, `sequences.ts:344-345`). Two concurrent
  cron ticks racing the same fresh installment: **exactly one** INSERT wins; the loser sees the
  existing row and re-evaluates it (it will be `charging`/`charged` → skip). This alone prevents two
  *first* charges.
- **Layer 2 — per-attempt CAS claim with a claim token.** To move `pending`(or a retry-eligible
  `failed_retryable`) → `charging`, issue **one** `UPDATE … SET status='charging', claim_token=<new
  uuid>, idempotency_key=<pinned>, amount_cents=<pinned>, attempt_count=attempt_count+1
  WHERE id=? AND status IN ('pending','failed_retryable') AND <retry guards>`. Then **re-read** and
  proceed to the network call **only if** `status='charging' AND claim_token` equals ours. A loser's
  UPDATE matches 0 rows (status already `charging`) → its re-read shows a foreign token → it does
  **not** POST. This is the exact winner-detection the refund path uses
  (`stripe-refund-initiation.ts:438-465`) — a plain status re-read is insufficient because both racers
  would read `charging`; the **token** is what identifies the single winner.

### 6.3 The Stripe idempotency key strategy

- The key for the current attempt = **`${autopay_charges.id}:${attempt_count}`** (pinned in the
  claiming UPDATE **before** the network call — never regenerated for the same attempt). Stripe
  idempotency keys dedupe for ~24h.
- **Within one attempt** (crash between claim and terminal update, a retried cron tick, a duplicated
  request): re-sending with the **same** pinned key returns Stripe's original result — no second
  charge. This is the crash/retry guarantee.
- **Across attempts** (a *confirmed* decline → a deliberate new attempt hours/days later): a **new**
  key `${id}:${attempt_count+1}` is used, because the prior attempt provably did **not** charge (a
  confirmed decline is not money movement) and Stripe would reject reusing the old key with different
  parameters anyway.
- The PaymentIntent carries `metadata[autopay_charge_id]`, `metadata[invoice_payment_id]`,
  `metadata[invoice_id]`, `metadata[project_id]` so the webhook reconciles precisely, and
  `off_session: true` + `confirm: true` so it charges without the customer present.
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
  Stripe"** (query Stripe by the pinned idempotency key or `metadata[autopay_charge_id]` to learn
  whether the PI exists/succeeded, then hand-resolve the row); (2) a `charged` row with no matching
  recorded `invoice_payments` (webhook never landed) older than ~24h → **"autopay charge not
  reconciled"**. Both feed `computeSystemHealth` as CRITICAL signals with per-row `alertKey`s
  (mirror `critical:refund_stuck:${id}`, `system-health.ts:404`), so a stuck charge pages Tyler.

### 6.5 Webhook reconciliation → converge invoice state (reuse the existing path)

Extend `handleStripeCheckoutWebhook`'s dispatch (`stripe-checkout.ts:704-727`) to route:

- **`payment_intent.succeeded`** where `metadata.autopay_charge_id` is present →
  `recordAutopayPaymentIntentSucceeded(pi)`: find the `autopay_charges` row, mark `charged`; then
  record the installment through the **same convergence as the checkout settle**
  (`stripe-checkout.ts:526-585`): set `invoice_payments.status='paid'`, `paidAmountCents` =
  service portion, fee split, `externalPaymentId = pi.id`, recompute the invoice with
  `reconciledInvoicePaymentStatus`, and `autoAdvanceProjectStageForRetainerPayment`. **Idempotent
  replay** = no-op on an already-`paid` installment (the exact guard at `stripe-checkout.ts:487-499`).
  Reuse — do not re-derive — the amount/fee arithmetic (I7).
- **`payment_intent.payment_failed`** with `metadata.autopay_charge_id` → read the failure code: a
  provable decline (`card_declined`, `insufficient_funds`, `expired_card`, …) → `failed_retryable`
  (schedule `next_attempt_at`) or `failed_terminal` if at the attempt cap (§6.6);
  `authentication_required` → `needs_action` (§6.6). The `payment_intent.succeeded` path is
  authoritative for money-recording even if the synchronous POST response was ambiguous — so a
  `charging` row that later receives `payment_intent.succeeded` converges to `charged`+recorded (the
  ambiguity resolves itself the moment the webhook lands, and reconciliation only fires if it doesn't).
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
| `AUTOPAY_CHARGE_MODE` | three-state (`log_only` \| `live`), like `financeRefundRecordingMode` | **`log_only`** | `log_only`: engine runs, selects, writes `dry_run=1` would-charge ledger rows + logs "WOULD charge $X on installment Y" — **zero Stripe charge calls, zero client emails**. `live`: real off-session charges. Any unset/typo → `log_only` (fail-safe). **Tyler-only flip #2 — the first live charge.** |
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

**Dark deploy (Tyler's machine — the remote env has no Cloudflare creds, `handoff §5`):**
1. Apply migration `0099` to D1 (additive, `CREATE TABLE IF NOT EXISTS`; inert while dark).
2. `npm run deploy` (app Worker via OpenNext) — ships the routes/engine **inert** (`AUTOPAY_ENABLED`
   off ⇒ every path no-ops).
3. Register the `autopay-charge` cron trigger — with the flag off it records `ok` + skips, so wiring
   it early is safe and starts the heartbeat.

**Enablement runbook (Tyler, in order — do NOT skip a step):**
1. Confirm `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` are set; confirm the Stripe Dashboard webhook
   subscribes `setup_intent.succeeded`, `setup_intent.setup_failed`, `payment_intent.succeeded`,
   `payment_intent.payment_failed` (in addition to the existing checkout events).
2. Set `AUTOPAY_ENABLED=1`. **Consent capture goes live; the charge engine is still `log_only`.** Have
   a test/friendly client turn on autopay; confirm the SetupIntent succeeds, the card shows on the
   consent row (last4/brand only — I4), and `autopay.consent_granted` is logged.
3. **Watch a full billing cycle in `log_only`.** Confirm the engine writes `dry_run` would-charge rows
   for the right installments, right amounts, right dates; confirm **no** Stripe charge and **no**
   client email fired. Reconcile the dry-run ledger against what a human would have charged.
4. **Fable money-math + idempotency review of the diff** (Guardrail 3) — the hardest gate.
5. **First live charge:** set a low `AUTOPAY_MAX_CHARGE_CENTS`, set `AUTOPAY_PILOT_ALLOWLIST` to one
   project, then flip `AUTOPAY_CHARGE_MODE=live`. Watch the single charge end-to-end: PI succeeds →
   `payment_intent.succeeded` → installment `paid` → invoice recomputed → receipt emailed. Confirm the
   `autopay_charges` row is `charged` + reconciled and `/system-status` shows no stuck tripwire.
6. Gradually widen the allowlist / raise the cap. **Rollback at any point = set `AUTOPAY_CHARGE_MODE=
   log_only`** (instant, no redeploy — stops all real charges while consent/observation continue) or
   `AUTOPAY_ENABLED` unset (full revert).

---

## 8. Client-facing transparency (emails — gated + justified)

**Decision: every autopay client email is gated on BOTH `EMAIL_SENDING_ENABLED` AND `AUTOPAY_ENABLED`,
runs through the canonical transport (`sendSequenceEmail`/`email.ts`), respects
`isEmailSuppressed`, and is SUPPRESSED ENTIRELY in `log_only` mode.** Justification: these are
autonomous outbound emails, so they fall under the same email-pause guardrail (Guardrail 2) as every
other outbound send — `EMAIL_SENDING_ENABLED` is the existing master gate
(`email-send-guard.test.ts`, `project-communications.ts`) and must not be bypassed. And in `log_only`
mode **nothing is actually charged**, so sending "we charged your card" (a lie) or "we'll charge you
in 3 days" (also untrue) would be wrong — client emails only fire in `live` mode.

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
16. **Concurrent cron (two ticks, same fresh installment):** exactly **one** `autopay_charges` row
    exists (`UNIQUE(invoice_payment_id)`); exactly **one** `POST /v1/payment_intents`; the losing
    tick's claim UPDATE matches 0 rows / foreign token and makes no charge call.
17. **Crash/retry within an attempt:** simulate the POST resolving but the terminal UPDATE never
    running (row stuck `charging`); a later tick does **NOT** re-POST (never auto-retry a `charging`
    row); the reconcile tripwire surfaces it after ~1h.
18. **Idempotency key reuse within an attempt:** re-invoking the charge for the same `charging` row
    with the same pinned key is a no-op / returns Stripe's original result (assert no second distinct
    charge).
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
29. `EMAIL_SENDING_ENABLED` off → **zero** autopay emails regardless of charges. `log_only` mode →
    **zero** emails even with `EMAIL_SENDING_ENABLED` on. `live` + `EMAIL_SENDING_ENABLED` on →
    upcoming-notice (once per installment, idempotent) + receipt (once per charge, idempotent);
    suppressed recipient → no send.

### 10.9 Reconciliation tripwires
30. `getAutopayChargeReconciliation`: a `charging` row > ~1h old → "stuck in-flight" signal with a
    per-row CRITICAL `alertKey`; a `charged` row with no recorded `paid` installment > ~24h → "not
    reconciled" signal. Fresh rows → no signal.

---

## 11. Ordered task breakdown (effort / risk)

| # | Task | Effort | Risk | Notes |
| --- | --- | --- | --- | --- |
| 1 | Flag helpers (`autopayEnabled`, `autopayChargeMode`, cap/allowlist/attempts/batch readers) + tests (§10.1) | XS | Low | Copy `refundInitiationEnabled` + `financeRefundRecordingMode` shapes; strict, body-read. |
| 2 | Migration `0099`: `autopay_consents` + `autopay_charges` (+ canon-guard triggers, UNIQUE indexes) | S | Med | Additive, `IF NOT EXISTS`; mirror `0080`/`0091` trigger style. Re-check free number at build. |
| 3 | Schema + Drizzle models for the two tables; `autopay-consent.ts` (version + text + hash) | S | Low | Card display fields only (I4). |
| 4 | Stripe wrappers (raw `fetch`): `createStripeCustomer`, `createSetupIntent` (or Checkout `mode=setup`), `createOffSessionPaymentIntent`, `detachPaymentMethod` — mirror `stripe-checkout.ts:57-79` exactly (auth, version, form body, error cleanup, Idempotency-Key) | M | **High** | New money-mutation surface (`POST /v1/payment_intents`) — the hardest reuse-verification; assert byte-identical header/version to existing calls. |
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
  guarantee rests on `UNIQUE(invoice_payment_id)` + the CAS token + the pinned Stripe idempotency key
  + the `UNIQUE(external_payment_id)` backstop — four layers, no transaction.
- **Never blind-retry money:** a `charging` (ambiguous) row is TERMINAL-UNKNOWN; recovery is
  reconcile-against-Stripe, never a re-POST (the refund `submitting` posture).
- **Amount is pinned, never re-computed at charge time:** the claiming UPDATE pins `amount_cents` +
  `idempotency_key` + `stripe_payment_method_id` before the network call; the POST sends the row's
  pinned values (the refund `claimed.amountCents` discipline).
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
