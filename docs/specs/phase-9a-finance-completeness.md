# Phase 9a: Finance completeness — refund/dispute recording + bookkeeping export + tax/1099 (NO money moved)

Status: 🔵 speccing → safe to build + deploy dark. **Fable-reviewed + revised (rev 2).**
Migration: `0089` (additive; latest applied is `0088_automated_sequences`).

> **Rev 2 (Fable spec-review, REQUEST-CHANGES → addressed):** 2 BLOCKERs + 4 MAJORs + 3 MINORs.
> (1) D1 has no usable transaction — idempotency rebuilt on per-object convergence, dedupe row
> written last, existing checkout branch left untouched (§1.2). (2) `"refunded"` treated as a
> settled status so a later refund never deletes the original period's gross; refund shows only as
> a period-scoped net subtraction (§1.6 table, §2.2, test 4b). (3) Every `paid`/`waived` branch
> enumerated for `refunded` — openCents=0, block checkout mint, deliberate invoice status (§1.6
> table). (4) Unit fix: threshold on `grossCollectedCents` only; service-portion refund for invoice
> recompute (§1.6). (5) Migration mirrored into `src/db/client.ts` dev `migrate()` too (§1.3).
> (6) Net subtracts only `succeeded` refunds + divergence flag (§2.2). (7) 1099 method matching is
> a normalized include-list (§4.2). (8) Agent-writable expenses acknowledged; guard test scoped to
> new surfaces (§4.2). (9) Orphan-amount absolute sanity clamp (§1.5).

## Scope boundary (read first)

9a **records money events that already happened at Stripe** and **produces read-only
exports/reports**. It **NEVER moves money.** It never calls a Stripe write endpoint
(no `POST /v1/refunds`, no charge, no capture). Every Stripe interaction in 9a is an
**inbound, signature-verified webhook we react to** — Stripe is the source of truth for
what happened; we mirror it into our ledger.

- **In scope (9a):** record `charge.refunded` / `refund.*` / `charge.dispute.*` webhook
  events into the payment ledger; surface refunds/disputes in reconciliation + the finance
  report; accountant-ready QuickBooks/Xero-compatible export; quarterly tax estimate, 1099
  vendor tracking, mileage log — all read/report + simple admin entry.
- **Out of scope (9b — MONEY-MOVEMENT PAUSE):** *initiating* a refund from the admin UI (a
  button that calls Stripe to issue a refund), issuing account credits, any charge/capture.
  9b builds are allowed but the **first live deploy needs Tyler's explicit go** (Autonomous
  Build Loop guardrail 3). Nothing in this spec crosses that line: if a code path would call a
  Stripe mutating endpoint, it belongs in 9b, not here.

A one-line litmus test for every task below: *"Does this call Stripe to change money state?"*
If yes → 9b, stop. If it only reads a webhook / reads our DB / writes a CSV → 9a, proceed.

---

## 1. Refund / dispute / chargeback WEBHOOK recording

### 1.1 What we extend

`src/app/api/stripe/webhook/route.ts` already POSTs the raw body + `stripe-signature`
header into `handleStripeCheckoutWebhook(rawBody, signatureHeader)` in
`src/lib/stripe-checkout.ts`, which calls `verifyStripeWebhookPayload(...)` (HMAC-SHA256
over `${timestamp}.${rawBody}`, constant-time hex compare via `timingSafeEqual`, 300s
tolerance). **We reuse that verified path verbatim** — signature verification is a solved
problem and must not be reimplemented or bypassed.

Today `handleStripeCheckoutWebhook` early-returns `{ ignored: true, reason:
"unsupported_event" }` for any `event.type` outside the three checkout types. We extend the
dispatch (not the route, not the verifier) to additionally handle:

| Stripe event type | Meaning | Ledger effect |
| --- | --- | --- |
| `charge.refunded` | charge fully/partially refunded (authoritative `amount_refunded`) | set/refresh refunded totals on the payment |
| `refund.created` / `refund.updated` | individual refund object lifecycle | record/refresh a `payment_refunds` row |
| `charge.dispute.created` | customer/bank opened a dispute (funds held) | open a `payment_disputes` row, mark payment disputed |
| `charge.dispute.closed` | dispute resolved (`status` = `won`/`lost`) | close the dispute row, set outcome |
| `charge.dispute.funds_reinstated` | funds returned after a won dispute | mark reinstated (net effect reversed) |
| `charge.dispute.updated` | dispute evidence/status change | refresh dispute row fields |

Design the dispatch as a small typed router inside `stripe-checkout.ts` (or a sibling
`src/lib/stripe-refunds.ts` that `handleStripeCheckoutWebhook` delegates to — preferred, to
keep checkout settlement and refund/dispute recording in separate, separately-testable
modules; the route stays a one-liner). `handleStripeCheckoutWebhook` after the existing
checkout branch:

```
if (eventType === "charge.refunded")             return recordStripeChargeRefunded(event);
if (eventType === "refund.created"
 || eventType === "refund.updated")              return recordStripeRefund(event);
if (eventType.startsWith("charge.dispute."))     return recordStripeDispute(event, eventType);
return { ignored: true, reason: "unsupported_event", eventType };
```

### 1.2 Idempotency — per-object convergence + event-id dedupe (mandatory)

Active-Learning Log: *"Attacker-chosen ids → INSERT ON CONFLICT DO NOTHING, never UPDATE
from inbound. A replayed webhook doesn't double-record."* Stripe **redelivers** events (at-least-once).
A replayed `charge.refunded` must not double-count a refund.

> **⚠️ D1 has no usable transaction (Fable finding #1, verified).** Cloudflare D1 rejects
> `begin`/`commit`/`rollback` at runtime; drizzle's `db.transaction()` issues exactly those raw
> statements (`node_modules/drizzle-orm/d1/session.js`), and **this codebase has never used one**
> (zero `db.transaction`/`.batch(` in `src/`). Local better-sqlite3 *does* support transactions,
> so a transaction-based design would pass tests in dev and 500 on every event in prod. **Do NOT
> use `db.transaction`.** `db.batch()` is the only atomic primitive, and it can't hold this flow
> (link resolution + invoice recompute need reads *between* writes). Idempotency is therefore built
> on **per-object convergence**, not a transactional claim.

**Primary safety = idempotent-by-construction writes** (each is safe to replay on its own):
- `payment_refunds.stripe_refund_id` and `payment_disputes.stripe_dispute_id` are `UNIQUE`;
  record via `INSERT … ON CONFLICT DO NOTHING` then a follow-up `UPDATE … WHERE stripe_*_id = ?`
  that sets fields to the **authoritative inbound values** (a set, not an increment — replays
  converge to the same row state).
- `charge.refunded` sets `invoice_payments.refunded_amount_cents = clamp(amount_refunded, …)`
  as a **set-to-authoritative** (Stripe's `amount_refunded` is cumulative), never `+=`. Replays
  converge; no double-count even without any dedupe.
- The existing `status === "paid"` short-circuit **stays** as the checkout-settlement guard —
  do NOT wrap or gate the existing checkout branch behind the new dedupe (Fable finding #1: that
  would ship a prod regression on the always-on money path).

**Secondary = event-id dedupe row (fast-path skip + audit, written LAST).** New table
`stripe_webhook_events` (migration 0089):

```sql
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id     TEXT PRIMARY KEY NOT NULL,   -- Stripe `event.id` (evt_...)
  event_type   TEXT NOT NULL,
  created_at   TEXT NOT NULL,               -- our receive time
  stripe_created_at TEXT,                   -- event.created (epoch → ISO)
  result       TEXT                         -- short JSON of what we did (audit)
);
```

Ordering (**write the dedupe row LAST**, after successful processing):
1. Validate `event.id` as a non-empty string first; a missing/blank id is rejected (throw →
   400, Stripe retries — never silent-drop).
2. Fast-path skip: `SELECT 1 FROM stripe_webhook_events WHERE event_id = ?` — if present,
   return `{ ignored: true, reason: "duplicate_event", eventId }` before any work.
3. Process the event through the convergent per-object writes above.
4. **Only after** step 3 succeeds, `INSERT INTO stripe_webhook_events … ON CONFLICT(event_id)
   DO NOTHING`.

If step 3 throws, no dedupe row is written → Stripe retries → step 3 re-runs, and because every
write in step 3 is convergent (UNIQUE insert-or-ignore + set-to-authoritative), reprocessing is
safe and produces the identical end state. Test #4 asserts: a forced mid-write throw leaves **no**
`stripe_webhook_events` row, and a subsequent successful replay produces exactly one refund row
with the correct amount (convergence), not two.

### 1.3 New schema (migration 0089, additive)

Two options were considered: (a) widen `invoice_payments` with refund/dispute columns, or
(b) add child ledger tables. **Chosen: child tables** — a payment can have multiple refunds
(partial refunds over time) and a dispute is a distinct lifecycle object; flattening loses
that and complicates the "net collected" math. We also add a **small set of summary columns**
on `invoice_payments` so the existing finance report and `reconciledInvoicePaymentStatus` can
read net figures without a join on every row (Active-Learning Log: migration-ordering — these
are read on always-on paths, so 0089 applies BEFORE the Worker deploy).

```sql
-- Summary columns on the payment (always-on read path: finance report + reconcile status)
ALTER TABLE invoice_payments ADD COLUMN refunded_amount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_payments ADD COLUMN dispute_status TEXT;          -- NULL | open | won | lost | reinstated
ALTER TABLE invoice_payments ADD COLUMN disputed_amount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_payments ADD COLUMN last_refund_at TEXT;

-- Child ledger: individual refund objects
CREATE TABLE IF NOT EXISTS payment_refunds (
  id                    TEXT PRIMARY KEY NOT NULL,   -- our uuid
  stripe_refund_id      TEXT NOT NULL UNIQUE,        -- re_... (dedupe within table)
  stripe_charge_id      TEXT,                        -- ch_...
  stripe_payment_intent_id TEXT,                     -- pi_...  (join key to invoice_payments.external_payment_id)
  invoice_payment_id    TEXT REFERENCES invoice_payments(id) ON DELETE SET NULL,
  scheduler_booking_id  TEXT REFERENCES scheduler_bookings(id) ON DELETE SET NULL,
  amount_cents          INTEGER NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'usd',
  reason                TEXT,                         -- Stripe refund.reason (validated enum-ish, capped)
  status                TEXT,                         -- succeeded | pending | failed | canceled
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- Child ledger: disputes / chargebacks
CREATE TABLE IF NOT EXISTS payment_disputes (
  id                    TEXT PRIMARY KEY NOT NULL,
  stripe_dispute_id     TEXT NOT NULL UNIQUE,        -- dp_...
  stripe_charge_id      TEXT,
  stripe_payment_intent_id TEXT,
  invoice_payment_id    TEXT REFERENCES invoice_payments(id) ON DELETE SET NULL,
  scheduler_booking_id  TEXT REFERENCES scheduler_bookings(id) ON DELETE SET NULL,
  amount_cents          INTEGER NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'usd',
  reason                TEXT,                         -- fraudulent | product_not_received | ...
  status                TEXT,                         -- warning_needs_response | needs_response | under_review | won | lost | ...
  funds_reinstated      INTEGER NOT NULL DEFAULT 0,   -- boolean
  opened_at             TEXT,
  closed_at             TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_refunds_pi   ON payment_refunds(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_ip   ON payment_refunds(invoice_payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_pi  ON payment_disputes(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_ip  ON payment_disputes(invoice_payment_id);
```

Mirror these in **three** places (finding #5 — the spec previously named only the first two,
which would leave the dev/test DB missing the tables and fail the entire tsx test plan):
1. `src/db/schema.ts` — `paymentRefunds`, `paymentDisputes`, `stripeWebhookEvents`,
   `mileageLogs` tables + the four new `invoicePayments` columns + the `vendors` tax columns.
2. `src/db/studio-canon.test.ts` — drift/canon assertions following the existing "external ids
   uniquely indexed for ledger reconciliation" pattern.
3. **`src/db/client.ts` local-dev `migrate()`** — the better-sqlite3 dev/test DB converges via
   the idempotent block there (every migration 0085–0088 has one; see `addColumnIfMissing`
   calls ~client.ts:586-736). Add: `addColumnIfMissing` × 4 on `invoice_payments`, the `vendors`
   tax columns, and `CREATE TABLE IF NOT EXISTS` × 4 (`stripe_webhook_events`,
   `payment_refunds`, `payment_disputes`, `mileage_logs`) + indexes. Without this, local tests
   and `/finance` fail on missing tables/columns.

### 1.4 Linking a webhook to our payment row

Stripe refund/dispute objects carry `payment_intent` (pi_…) and/or `charge` (ch_…). Our
settled Stripe payments store the payment-intent id in `invoice_payments.external_payment_id`
(see `settleInvoicePaymentCheckoutSession`: `externalPaymentId: paymentIntentId`). Scheduler
bookings store it in `scheduler_bookings.external_payment_id`.

Link resolution (in order):
1. `refund.payment_intent` → `invoice_payments.external_payment_id` (unique) → payment row.
2. else `refund.payment_intent` → `scheduler_bookings.external_payment_id` → booking row.
3. If neither matches (e.g. a Stripe charge made outside the CRM, or a race where the
   settlement webhook hasn't arrived yet): **still record the `payment_refunds` /
   `payment_disputes` row** with `invoice_payment_id = NULL`, and surface it as an
   **orphaned/unlinked** finance-report reconciliation item. Never silent-drop. (A later
   settlement or a manual admin link can attach it; do NOT UPDATE canonical payment rows from
   an unmatched inbound event.)

### 1.5 Untrusted-field handling (every field hostile)

Even post-signature, treat the JSON as adversarial (Active-Learning Log):
- Validate `event.id`, `refund.id`, `dispute.id`, charge/pi ids as non-empty strings; trim;
  **length-cap** every stored string (e.g. 255 for ids, 500 for reason/notes).
- Amounts: coerce via the existing `stripeNumber` helper; reject non-finite/negative;
  **cap** each amount at the linked payment's `grossCollectedCents` (a refund cannot exceed
  what we recorded as collected — clamp with `Math.min`, and if it exceeds, still record but
  flag `needs_reconciliation` rather than trusting the number blindly).
  **Orphaned rows (no linked payment, §1.4 case 3) have no `grossCollectedCents` to cap
  against — apply an absolute sanity clamp instead** (Fable finding #9): non-negative integer,
  hard ceiling (e.g. $1,000,000 = 100_000_000 cents); an out-of-range orphan amount is stored
  clamped and flagged `needs_reconciliation`, never trusted or dropped.
- `amount_refunded` on `charge.refunded` is authoritative and cumulative — set
  `invoice_payments.refunded_amount_cents = Math.min(clamp(amount_refunded), grossCollectedCents)`
  (idempotent: replays converge to the same value; this is a set-to-authoritative, not an
  increment, so even without the event-dedupe it's safe — belt and suspenders).
- `refund.reason` / `dispute.reason` / `dispute.status`: store as free text capped; do not
  branch security decisions on them.

### 1.6 Effect on payment/invoice status

The full-refund path introduces a new terminal payment status `"refunded"`. **`"refunded"` is a
SETTLED status, not an open one** — this is the crux of findings #2 and #3. Every code path that
currently special-cases `"paid"`/`"waived"` must be audited and told how to treat `"refunded"`,
or the flip will (a) retroactively delete gross revenue and (b) make the payment re-owed and
re-billable. Do NOT ship the status flip until all of the below are handled.

**Threshold (finding #4 — unit correctness).** `refunded_amount_cents` is capped at
`grossCollectedCents` (service **+** client card fee). But invoice `amountPaidCents` sums
`paidAmountCents` (service only — see `settleInvoicePaymentCheckoutSession`:
`paidAmountCents: serviceOpenCents` vs `grossCollectedCents: amountTotalCents`). So:
- Full-refund threshold is **`refunded_amount_cents >= grossCollectedCents` only** — drop the
  `>= paidAmountCents` parenthetical (a $1,000 partial refund on $1,030 gross must NOT flip to
  terminal `refunded`).
- For invoice recompute, the refund's **service-portion** is
  `refundServiceCents = clamp(refunded_amount_cents − clientFeeCents, 0, paidAmountCents)`.
  Simpler equivalent rule, which the builder may use instead: a **fully-refunded** payment
  contributes **0** to `amountPaidCents`; a **partial** refund lives only in net figures (§2)
  and does not alter `amountPaidCents`. Pick one and state it in code comments; do not subtract
  a gross-based refund from a service-based paid total.

**Status transitions (system-from-webhook only):**
- `refunded_amount_cents >= grossCollectedCents` → `payment.status = "refunded"`; invoice
  recomputed with the payment contributing 0 to `amountPaidCents`.
- partial refund → keep `"paid"`; net-collected math (§2) subtracts the refunded amount; no
  change to `amountPaidCents`.
- open dispute → `payment.status` stays `"paid"`, `dispute_status = "open"`, row forced into the
  reconciliation queue (funds at risk, not yet lost).
- dispute lost + funds not reinstated → treat disputed amount like a refund for net-collected;
  dispute won / funds_reinstated → net effect reversed.

**Every `"paid"`/`"waived"` branch that must also handle `"refunded"` (finding #3 — enumerate,
do not leave to the builder):**

| Location | Current behavior | Required `"refunded"` behavior |
| --- | --- | --- |
| `getBookkeepingReport` paid-rows query (bookkeeping.ts:518, `eq(status,"paid")`) | gross revenue from paid rows scoped by `paidAt` | **treat as settled** — `inArray(status, ["paid","refunded"])`, keep `paidAt` scoping, so the original period's **gross stays immutable** (finding #2). Refund shows up ONLY as the §2.2 net subtraction. |
| `getPaymentLedgerReport` per-row `paidCents` (sales.ts:1661, `status==="paid" ? paidAmountCents : 0`) | 0 for non-paid | include `"refunded"` so `paidCents` reflects the original gross collection (net is derived separately). |
| `getPaymentLedgerReport` `openCents` (sales.ts:1670, `paid`\|`waived` → 0) | full amount re-owed otherwise | `"refunded"` → `openCents = 0` (a refunded payment is NOT re-owed). |
| `invoicePaymentOpenCents` (invoice-balances.ts:55, `paid`\|`waived` → 0) | full amount otherwise | add `"refunded"` → return 0. |
| `createInvoicePaymentCheckoutSession` (stripe-checkout.ts:194, blocks `paid`\|`waived`) | mintable otherwise | **block on `"refunded"`** — do NOT let a fresh Stripe checkout link be minted for a refunded payment. |
| `reconciledInvoicePaymentStatus` (sales.ts:84) | maps recomputed paidTotal→status; 0 → `"sent"` | a fully-refunded invoice must NOT resurrect into `"sent"`/dunning. Give it a deliberate invoice-level status (e.g. keep/route to a `"refunded"`-aware terminal) rather than the accidental `"sent"`. |
| AR aging filter (sales.ts:1590) | **already excludes `refunded`** ✅ | no change (pre-wired). |

Recompute the parent invoice **system-from-webhook** (actorType `"system"`, actorName
`"Stripe"`), never from an agent or admin form.

The status flip (and only the flip) sits behind the three-state `FINANCE_REFUND_RECORDING` flag
(§5): at `record_only` the child tables + summary columns are written and surfaced in net
figures, but `payment.status` is NOT flipped and none of the above branches change behavior — so
the risky enumerated changes are inert until Tyler flips to `enforce` after an observation window.

### 1.7 Activity logging

Log via `logActivity` (src/lib/activity.ts) with `actorType: "system"`, `actorName:
"Stripe"`, new actions: `invoice.payment_refunded_from_stripe`,
`invoice.payment_dispute_opened_from_stripe`, `invoice.payment_dispute_closed_from_stripe`,
`invoice.payment_dispute_funds_reinstated_from_stripe`. Metadata carries
`{ invoiceId, paymentId, stripeRefundId|stripeDisputeId, amountCents, reason, status,
eventId }`. Register the new action strings anywhere activity actions are enumerated/formatted
(`formatActivityAction`).

---

## 2. Reconciliation surfacing

### 2.1 Finance report + needs_reconciliation queue

`getPaymentLedgerReport` (sales.ts:1626) and `getBookkeepingReport` (bookkeeping.ts:502) feed
`getAgentFinanceReport` (agent-finance.ts:316) and the `/finance` admin page. Extend:

- **PaymentLedgerRow / report row:** add `refundedAmountCents`, `disputeStatus`,
  `disputedAmountCents`, and a derived `netCollectedCents = grossCollectedCents −
  refundedAmountCents − (dispute lost & not reinstated ? disputedAmountCents : 0)`.
- **Totals:** add `refundedCents`, `disputedOpenCents`, `netCollectedCents` to
  `PaymentLedgerReport["totals"]` and to the bookkeeping report totals (so
  `revenueCents` / `netDepositCents` consumers can show *net of refunds*). Keep the existing
  gross fields unchanged (don't break current consumers/tests); add net alongside.
- **`paymentLedgerNeedsReconciliation(row)`** (sales.ts:1526) currently flags paid rows
  missing external id / source. Extend to also flag: an **open dispute**, a **refund whose
  amount exceeds recorded collected** (the over-cap case from 1.5), and an **orphaned refund/
  dispute** (`invoice_payment_id IS NULL`). These appear in the `status=needs_reconciliation`
  view and the agent finance report's `reconciliation` block (agent-finance.ts:334,
  `buildReconciliationSummary` / `missingPaymentEvidence`).

### 2.2 Net figures

`getBookkeepingReport` totals `revenueCents` from `paidRows … paidAmountCents`. Gross stays
immutable (§1.6: paid-rows query now matches `["paid","refunded"]` scoped by `paidAt`, so a later
refund never removes revenue from the original period). Add a **parallel subtraction** to produce
`netRevenueCents` / `netDepositCents` as **additive** fields (both gross and net lines appear in
the CSV, section 3; existing gross consumers/tests unchanged):

- Subtract **only `payment_refunds.status = 'succeeded'`** rows (finding #6 — `pending`/`failed`/
  `canceled` refunds have not moved money and must not be subtracted), plus lost-not-reinstated
  disputes.
- Period-scope the subtraction on the refund/dispute **`created_at`** (money-event date),
  consistent with how `paidRevenueConditions` scopes revenue on `paidAt`. (Net-across-periods is
  therefore correct: gross booked in the paid period, refund subtracted in the refund period; no
  period double-removes the same dollars — the finding-#2 failure mode.)
- **Divergence guard (finding #6):** flag any payment where
  `refunded_amount_cents ≠ SUM(succeeded child refunds)` as `needs_reconciliation` — catches a
  dropped/missed event in either stream (the `charge.refunded` summary vs the `refund.*` children).

### 2.3 Guard stays — agents cannot mutate

Recording is **system-from-webhook only**. There is NO agent or admin mutation entry point
for refunds/disputes in 9a. The existing finance guard
(`requireTylerApprovalForAgentFinance`, sales.ts:697; scheduler equivalent) stays exactly as
is. Add a **guard test** asserting: (a) no exported agent-callable function writes
`payment_refunds` / `payment_disputes` / the new `invoice_payments` columns, and (b) a hostile
agent finance call still throws the approval error and writes zero canonical rows (extends
`src/lib/agent-finance-guard.test.ts`). Agents may **read** the refund/dispute data via the
finance report (read-only) and may draft reconciliation *task* recommendations — never record.

---

## 3. QuickBooks / Xero accountant export

### 3.1 What it is

A new read-only, period-scoped export **extending the existing bookkeeping export family**
(`/api/finance/bookkeeping-summary.csv`, `/api/finance/expenses.csv`,
`/api/finance/payment-ledger.csv` — all guarded by `guardDirectWorkerApiRequest`). No Stripe
API call, no accounting-platform API call.

New route: `src/app/api/finance/accounting-export.csv/route.ts` producing a
**QBO/Xero-import-friendly CSV** (both platforms ingest a generic transaction CSV; IIF is
QuickBooks-Desktop-only and legacy — we target the CSV path, which QBO Online and Xero both
accept). Builder in `src/lib/bookkeeping.ts` (or a new `src/lib/accounting-export.ts`):
`accountingExportCsv(report, options)`.

### 3.2 Rows and columns

One row per money event (income, refund, dispute-loss, expense/fee), so the accountant sees
every line that hits the books:

```
Date, Type, Description, Reference, Account, Debit, Credit, Party, Memo
```

- **Income** rows from paid `invoice_payments` / paid `scheduler_bookings` (net service
  amount as Credit to an income account).
- **Refund** rows from `payment_refunds` (Debit income / contra-revenue).
- **Dispute loss** rows from lost, not-reinstated `payment_disputes`.
- **Processor fee** rows from `processing_fee_cents` (Debit "Merchant fees").
- **Expense** rows from `expenses` (existing data).

`Reference` carries the Stripe id (`pi_…` / `re_…` / `dp_…`) so the accountant can trace to
the Stripe dashboard. `Account` uses a simple built-in mapping (income / merchant-fees /
refunds-contra / expense-by-category) — a fixed default chart, since we don't have Tyler's
actual QBO/Xero account names yet.

Reuse the existing `csvCell` / `centsCsv` helpers (bookkeeping.ts:613) and the period params
(`fromDate` / `toDate`) exactly like `bookkeeping-summary.csv`. Include a header comment row
noting the period and that amounts are in USD.

### 3.3 Explicitly deferred (future)

Direct **QuickBooks Online / Xero API sync** (OAuth, posting journal entries) is **out of
scope** — it needs Tyler's accounting-platform credentials + OAuth app registration, and it
*writes* to an external system (adjacent to the money-movement caution; it's ledger-write not
money-move, but still needs Tyler's creds + explicit choice of platform). Note it in the
roadmap as `🅣 needs Tyler's accounting credentials + platform choice`. 9a ships the CSV the
accountant imports manually.

---

## 4. Tax / 1099 + mileage

All three are **read/report + simple admin entry**; no money moved.

### 4.1 Quarterly tax-estimate report

Pure read over the existing ledger — no new money data. New builder
`getQuarterlyTaxEstimate({ year, quarter })` in `src/lib/tax.ts` + a read-only admin surface
(`/finance/tax` page and/or `/api/finance/tax-estimate.csv`). For the period:
- `netRevenueCents` (gross service revenue − refunds − lost disputes, section 2.2),
- `deductibleExpenseCents` (existing `taxDeductibleExpenseCents`) + mileage deduction (4.3),
- `estimatedNetSelfEmploymentIncomeCents = net revenue − deductible expenses`,
- an **estimated** set-aside using a **configurable flat rate** (default e.g. 25–30%, stored
  as an app setting, clearly labeled "estimate, not tax advice — confirm with your
  accountant"). No tax-bracket logic, no filing — just a set-aside guide.

Quarter boundaries: standard US estimated-tax quarters (Q1 Jan–Mar, Q2 Apr–May [IRS quirk],
etc. — use calendar quarters for the MVP and label them; note the IRS due-date quirk in the UI
copy rather than encoding it). Read-only; no persistence beyond the app-setting rate.

### 4.2 1099 vendor tracking

Extend the existing vendor/expense model. A 1099-NEC is owed to a vendor/second-shooter paid
**≥ $600** (the current IRS threshold) in a calendar year by non-card methods (card/third-party
payments are reported by the processor on 1099-K, not by us — so exclude
`payment_method IN ('stripe','credit_card')` from the 1099 tally). Design:
- Add nullable vendor columns (migration 0089): `vendors.tax_id_last4 TEXT`,
  `vendors.is_1099_tracked INTEGER NOT NULL DEFAULT 0`, `vendors.legal_name TEXT`,
  `vendors.tax_address TEXT` (admin-entered W-9 data; store only last4 of TIN, never the full
  SSN/EIN — PII minimization).
- New read builder `get1099VendorReport({ year })` in `src/lib/tax.ts`: sum
  `expenses.amount_cents` per vendor for the year where `status='paid'` and the payment method is
  a **reportable (non-card) method**, flag vendors crossing $600, and mark which
  crossed-threshold vendors are **missing W-9 data** (`legal_name` / `tax_id_last4` null) as a
  reconciliation item.
  **Method matching must be an include-list over normalized text, not an exact-string exclude
  list (finding #7):** `expenses.payment_method` is unvalidated free text (`formNullableText`),
  so `NOT IN ('stripe','credit_card')` would miss `'card'`, `'Credit Card'`, `'visa'`, etc. and
  over-report 1099 amounts. Normalize (`.trim().toLowerCase()`) and count only a known reportable
  set (`cash`/`check`/`zelle`/`venmo`/`ach`/`wire`); treat any **unrecognized** method on a
  ≥$600 vendor as a `needs_reconciliation` flag (don't silently include or exclude an ambiguous
  method).
- **Agent-writable input caveat (finding #8):** expenses are already agent-writable via
  `createExpenseFromAgent`/`updateExpenseFromAgent` (no Tyler-approval guard — consistent with
  existing authority; not a canonical-money write). Those feed the 1099 tally and quarterly
  estimate. This is acknowledged, not changed here. The no-agent-write **guard test** (§2.3, §6.2
  #11) covers the *new* finance-adjacent surfaces only: `vendors` W-9 columns, `mileage_logs`, and
  the refund/dispute tables + new `invoice_payments` columns.
- Read-only surface: `/finance/tax` 1099 section + `/api/finance/1099-summary.csv`. Admin can
  enter W-9 fields via a simple guarded form (`/api/finance/vendors` update — admin-only,
  `guardDirectWorkerApiRequest`). Agents cannot write vendor tax data (finance-adjacent) —
  keep it off the agent surface; add to the guard test.

### 4.3 Mileage log

New table (migration 0089) + simple admin entry + deduction report. No money moved.

```sql
CREATE TABLE IF NOT EXISTS mileage_logs (
  id            TEXT PRIMARY KEY NOT NULL,
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  trip_date     TEXT NOT NULL,
  miles         REAL NOT NULL,
  purpose       TEXT,
  from_location TEXT,
  to_location   TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

- Builder `getMileageReport({ year|fromDate, toDate })` in `src/lib/tax.ts`: sum miles ×
  **configurable IRS standard mileage rate** (app setting, e.g. 67¢/mi for 2024 — store the
  rate; label year) → `deductionCents`. Feeds the quarterly tax estimate (4.1).
- Admin CRUD via a guarded route (`/api/finance/mileage`, `guardDirectWorkerApiRequest`,
  admin-only) + a `/finance/tax` mileage section + `/api/finance/mileage.csv`. Simple
  create/update/delete like the expenses form. Agents: read-only via finance report; no write
  (add to guard test — mileage is a deduction input = finance-adjacent).

---

## 5. Flag / rollout

Per Autonomous Build Loop guardrails 1 & 3:

- **Webhook recording is additive & always-on when it lands.** The Stripe webhook already runs
  in prod; adding refund/dispute event handling changes behavior only when Stripe delivers one
  of the new event types. Because the new events are simply *recorded* (no money moved, no
  client-facing change), and because the finance report reads the new columns on always-on
  paths, this ships **on** — but it is inert until a real refund/dispute occurs. **No behavior
  change for existing (checkout) events.** *Optionally* gate the status-transition-to-
  `"refunded"` behavior behind a three-state flag `FINANCE_REFUND_RECORDING`
  (`off`/`record_only`/`enforce`): `record_only` writes the child tables + summary columns and
  surfaces them in reports but does NOT flip `payment.status`/invoice recompute;
  `enforce` also flips status. This gives an observation window before the reconcile-status
  change goes live. Recording the raw event (child tables) is always safe/on; only the derived
  status mutation is flag-gated. Recommend shipping at `record_only`, Tyler flips to `enforce`
  after observing real refund data (guardrail 2 — enablement flips are not autonomous).
- **Exports/reports are read-only admin surfaces** behind `guardDirectWorkerApiRequest`
  (origin guard) exactly like the existing finance CSVs; no flag needed (a new read endpoint
  changes nothing until someone loads it). Confirm proxy composition: these live under
  `/api/finance/*` and `/finance/*` — the same admin-authenticated surface as today's finance
  routes, so they inherit the existing admin-proof/origin-guard treatment. No new public path,
  no origin-guard-bypass entry (Active-Learning Log: don't add mutation endpoints to bypass
  lists).
- **Migration 0089 is additive and applied BEFORE the Worker deploy** (Active-Learning Log:
  migration ordering). The new `invoice_payments` columns + refund/dispute/1099/mileage tables
  are read by the finance report on always-on paths, so a missing column would 500 existing
  `/finance` loads. Apply via the idempotent direct `d1 execute --file` pattern
  (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN … DEFAULT`), verify columns + row
  sanity, THEN deploy the Worker. Do **not** blanket `migrations apply --remote` (tracker out
  of sync). All `ALTER … ADD COLUMN` use `NOT NULL DEFAULT` (SQLite-safe, no table rewrite).
- **Everything deploys dark/safe.** Backup D1 → capture Worker rollback version → apply 0089 →
  verify → deploy Worker + Pages-proxy → health-check → rollback-ready.

---

## 6. Config / secrets, test plan, task breakdown

### 6.1 Config / secrets

**No new secrets.** Reuses existing `STRIPE_WEBHOOK_SECRET` (already required by
`stripeWebhookSecret()`, fail-closed when unset). New **app settings** (not secrets, stored in
the settings surface): `taxSetAsideRatePercent`, `mileageRateCents`, `1099ThresholdCents`
(default 60000) — all with safe defaults, all read-only-affecting (reports only). Optional new
env flag `FINANCE_REFUND_RECORDING` (`off`/`record_only`/`enforce`, default `record_only`), a
three-state flag like `CSP_MODE`/`ADMIN_PROOF_ENFORCE` — read in the body, not as a default
param (Active-Learning Log: avoid `env = process.env` weak-type TS2559).

### 6.2 Test plan

Webhook recording (tsx tests alongside `stripe-checkout` tests):
1. **Signature** — refund/dispute events with a bad/missing signature throw → route returns
   400; valid signature records. Reuses `verifyStripeWebhookPayload` test harness.
2. **Refund recording** — `charge.refunded` with `amount_refunded` sets
   `refunded_amount_cents`, writes `payment_refunds`, links via `payment_intent` →
   `external_payment_id`; partial vs full refund → status stays `paid` vs flips `refunded`
   (enforce mode).
3. **Idempotency (convergence)** — replay the same `event.id` twice → one `payment_refunds` row,
   unchanged `refunded_amount_cents` (set-to-authoritative, not incremented), second call returns
   `duplicate_event`. Replay a `charge.dispute.created` → one `payment_disputes` row. Assert
   convergence holds even if the dedupe row is absent (per-object UNIQUE + set-to-authoritative
   is the primary safety, not the event-id row).
4. **Retry-safety (no transaction)** — a forced mid-write throw leaves **no**
   `stripe_webhook_events` row (it's written last); a subsequent successful replay produces
   exactly one refund row with the correct amount (not two). Confirms the design does NOT rely on
   `db.transaction` (which D1 rejects at runtime — finding #1).
4b. **Cross-period gross immutability** — payment paid $X in period P1, fully refunded in P2:
   re-running the P1 bookkeeping report shows **unchanged** gross `revenueCents` (the refund does
   NOT retroactively delete P1 revenue); the refund appears only as the P2 net subtraction; net
   across P1+P2 nets to $0, not −$X (finding #2). Also assert `openCents`/`invoicePaymentOpenCents`
   are 0 for the refunded payment and no fresh checkout link can be minted (finding #3).
5. **Dispute lifecycle** — `created` → open; `closed` won → won + net restored; `closed` lost
   → net reduced; `funds_reinstated` → reinstated flag + net reversed.
6. **Untrusted fields** — over-cap refund amount (> gross) is clamped/flagged; hostile long
   strings capped; missing ids rejected (400, not silent-drop); orphaned refund (no matching
   pi) recorded with null link + surfaced in reconciliation.
7. **Reconciliation** — `status=needs_reconciliation` includes open disputes, over-cap
   refunds, orphaned events; net-collected totals subtract refunds/lost disputes; AR aging
   still excludes `refunded`.
8. **Export correctness** — accounting-export CSV includes income + refund + fee + expense
   rows for a period, Stripe reference ids present, period-scoped, gross+net lines correct;
   reuse `bookkeeping-summary.csv` route test shape.
9. **1099 threshold** — vendor with ≥ $600 non-card paid expenses in a year is flagged;
   card-paid amounts excluded; crossed-threshold vendor missing W-9 flagged as reconciliation.
10. **Mileage** — miles × rate = deduction; feeds tax estimate; CRUD round-trips.
11. **No-agent-write (guard)** — hostile agent finance call still throws approval error and
    writes zero rows to `payment_refunds`/`payment_disputes`/`invoice_payments` new
    columns/`vendors` tax fields/`mileage_logs` (extends `agent-finance-guard.test.ts`).
12. **Build gate** — `npm run build` **exit code 0** (type-check passes), `npm test` green,
    `npm run lint`. Canon/drift tests updated for the new tables/columns/indexes.

### 6.3 Ordered task breakdown (effort / risk)

| # | Task | Effort | Risk |
| --- | --- | --- | --- |
| 1 | Migration 0089: `stripe_webhook_events`, `payment_refunds`, `payment_disputes`, `mileage_logs`; `invoice_payments` + `vendors` columns; indexes. Mirror in `schema.ts`, `studio-canon.test.ts`, **and the `src/db/client.ts` local-dev `migrate()` block** (finding #5). | M | Med (always-on read cols → migration-ordering discipline) |
| 2 | Event-id dedupe (`stripe_webhook_events`, written **last**; per-object convergence is primary safety — **no `db.transaction`**, finding #1) wired into `handleStripeCheckoutWebhook`; do NOT gate the existing checkout branch behind it. | S | Med (retry-safety without transactions) |
| 3 | `recordStripeChargeRefunded` / `recordStripeRefund` / `recordStripeDispute` in `stripe-refunds.ts`; link resolution; untrusted-field validation/caps; system activity logs. | L | High (money-integrity correctness, untrusted input) |
| 4 | Status/net recompute: extend `reconciledInvoicePaymentStatus` consumers, `payment.status="refunded"`, invoice recompute; `FINANCE_REFUND_RECORDING` three-state flag. | M | Med (behavior change behind flag) |
| 5 | Reconciliation surfacing: extend `PaymentLedgerRow`/report totals (refunded/disputed/net), `paymentLedgerNeedsReconciliation`, agent-finance report + `/finance` page. | M | Med (don't break existing tests — add net alongside gross) |
| 6 | Accounting export: `accountingExportCsv` + `/api/finance/accounting-export.csv` route (period-scoped, QBO/Xero CSV). | M | Low (read-only) |
| 7 | Tax module `src/lib/tax.ts`: quarterly estimate, 1099 report, mileage report; `/finance/tax` page + CSVs. | M | Low (read/report) |
| 8 | 1099 W-9 admin entry + mileage CRUD (guarded admin routes); app settings for rates/threshold. | M | Low-Med (PII: store TIN last4 only) |
| 9 | Guard tests (no-agent-write across all new tables/cols) + full test suite + build-exit-code gate. | M | Med (the safety net) |
| 10 | Deploy dark: backup → apply 0089 → verify cols → deploy Worker + proxy → health-check → rollback-ready; flag at `record_only`. | S | Med (prod migration ordering) |

Effort: S ≈ ≤0.5d, M ≈ 0.5–1d, L ≈ 1–2d.

### 6.4 9b boundary (restated)

Nothing in 9a moves money. **Refund *initiation*** — an admin/agent action that calls Stripe's
`POST /v1/refunds` to actually issue a refund — is **Phase 9b** and is under the
**money-movement pause**: it may be built but its first live deploy requires Tyler's explicit
go. 9a only *reacts to* Stripe's webhooks (records what already happened) and *reads* our
ledger to produce exports/reports. If any 9a task finds itself needing to call a Stripe
mutating endpoint, it has crossed into 9b — stop and re-scope.
