# Phase 9b: Refund INITIATION — admin-triggered Stripe refund (MOVES REAL MONEY)

Status: 🔴 speccing → **MONEY-MOVEMENT PAUSE**. Build allowed; **first live deploy needs Tyler's explicit go** (Autonomous Build Loop guardrail 3). Ships behind an OFF flag; **turning the flag on and issuing the first real refund are Tyler-only actions.**
Migration: `0091` (additive; latest applied is `0090_intelligence_forecasting`).
Pairs with: `phase-9a-finance-completeness.md` (the refund/dispute **recording** that already ships dark at `FINANCE_REFUND_RECORDING=record_only`).

> **What makes 9b different from every prior phase.** Every phase before this one either read data or reacted to a webhook describing money that **already** moved. 9b is the first and only code in the app that calls a Stripe **mutating** endpoint (`POST /v1/refunds`) — it *causes* money to leave the business bank account. There is no undo. This document is the artifact Tyler reviews to grant or withhold the go; the product decisions are made explicit below (with recommended defaults) and the safety rails are specified to be airtight and testable.

---

## 1. Scope + the money-movement boundary (restated)

**In scope (9b):** an **admin-only** UI action + endpoint that calls Stripe `POST /v1/refunds` to issue a full or partial refund against an `invoice_payments` row we own; a small **`refund_initiations`** audit/idempotency table (migration 0091) that records every initiation attempt; the safety rails (amount cap, ledger re-check, typed confirmation, Stripe idempotency key, in-flight guard); an OFF-by-default flag; and the interleave with 9a so the canonical ledger stays single-sourced.

**Explicitly OUT of scope (do NOT build in 9b):**
- **Writing `payment_refunds` / `refunded_amount_cents` directly.** The canonical refund ledger is owned by the 9a inbound webhook. 9b initiates; 9a records. One source of truth (§4).
- Any **charge / capture / account-credit** (money *in* or store credit) — not this phase, not this app yet.
- **Agent / MCP** refund initiation — money-movement is admin-only and is **never** exposed on the agent surface, with or without approval. This is stricter than the existing draft-only finance guard (§5).
- Refunding a **booking-linked** Stripe payment (`scheduler_bookings.external_payment_id`). 9a records booking-linked refunds but never mutates booking status; 9b's first cut refunds **`invoice_payments` only**. Booking refunds are a later, deliberate increment.
- Direct QuickBooks/Xero write-back, dispute *responses* (evidence submission), partial-capture, etc.

**Litmus test for every task:** *"Does this call `api.stripe.com/v1/refunds`, or gate/record a call that does?"* → 9b, and it lives behind the OFF flag. Anything that only reads our DB or reacts to a webhook is 9a and already shipped.

---

## 2. Product decisions to surface for Tyler (explicit choices + recommended defaults)

Each row is a decision Tyler is being asked to ratify. The **Recommended default** is what the build will implement unless Tyler says otherwise.

| # | Decision | Options | **Recommended default** | Rationale |
| --- | --- | --- | --- | --- |
| P1 | Full vs partial refunds | full-only / full+partial | **full + partial** | Real-world refunds are often partial (retainer kept, balance returned). UI pre-fills the **full remaining refundable** amount; admin may reduce it. |
| P2 | Refund reason capture | none / internal note / Stripe reason + internal note | **both — internal reason (required, ≥3 chars, capped 500) + Stripe `reason` (default `requested_by_customer`)** | Internal reason is the audit trail (activity log + `refund_initiations.reason`); Stripe `reason` ∈ `requested_by_customer\|duplicate\|fraudulent` is optional metadata on Stripe's side. Reason is never a security decision input. |
| P3 | Second / typed-amount confirmation | single click / typed-amount confirm | **typed-amount confirm (must type the exact cents/dollar figure, server-validated against the same amount)** | This is the most destructive admin action in the app and it is irreversible. A typed confirmation is cheap and defeats accidental / double-click refunds. |
| P4 | Approval step vs admin-direct | in-app second approver / admin-direct | **admin-direct** (no separate in-app approver) | Tyler *is* the owner/admin; there is no second human. The "approval" that matters is the money-movement guardrail itself: the OFF flag + the first real refund are Tyler actions (§8, §11). Agents can never initiate (§5). |
| P5 | Refund a payment with an **OPEN dispute** | allow / block | **BLOCK** | Stripe blocks/complicates refunding a charge under dispute, and refunding during a dispute risks a **double loss** (you refund *and* lose the chargeback). Disputes resolve through the dispute flow (9a records `won`/`lost`/`reinstated`), not a refund. Reject with a clear message when `invoice_payments.dispute_status = "open"`. |
| P6 | Refund window limit | app-enforced window / rely on Stripe | **rely on Stripe** (no hard app window) + **soft warn** if the charge is > 120 days old | Stripe already fails very old / insufficient-balance refunds; we surface Stripe's error verbatim (cleaned). Encoding our own window would drift from Stripe's rules. |
| P7 | Payment eligibility | any status / paid-and-partially-refunded only | **only Stripe-collected `paid` (incl. already-partially-refunded) payments with a non-null `external_payment_id` (pi_…)** | A `waived` payment collected nothing; a cash/check payment has no Stripe charge to refund; a fully-`refunded` payment has `maxRefundable = 0` (rejected by the amount cap). |
| P8 | Invoice/project state after refund | 9b mutates status / 9a webhook mutates status | **9a owns all status changes** | 9b moves money; the resulting `charge.refunded` webhook lets 9a set `refunded_amount_cents` and (at `FINANCE_REFUND_RECORDING=enforce`) flip a fully-refunded payment to the terminal `refunded` status via the enumerated settled-status handling (9a §1.6). 9b never touches `payment.status` or the invoice. **Consequence Tyler must know:** to have a full refund *reflected in invoice/payment status*, `FINANCE_REFUND_RECORDING` must be at `enforce` (§8, §11). |

---

## 3. Safety rails (airtight)

All rails are **server-side** and enforced in the initiation helper, not the client. The client UI mirrors them for UX only.

### 3.1 Amount validation + hard server-side ledger re-check at execution time
At **execution** (not draft, not client), re-read the payment row fresh and compute:

```
grossCollectedCents        = payment.grossCollectedCents            // authoritative collected total
webhookRefundedCents       = payment.refundedAmountCents            // 9a webhook set-to-authoritative
localInFlightRefundedCents = Σ refund_initiations.amountCents        // THIS payment's own
                              WHERE status IN ('submitting','succeeded')
alreadyRefundedCents       = max(webhookRefundedCents, localInFlightRefundedCents)
maxRefundableCents         = max(grossCollectedCents - alreadyRefundedCents, 0)
```

- **Reject** if `requestedAmountCents <= 0` or `requestedAmountCents > maxRefundableCents`. A refund can never exceed collected-minus-already-refunded. This is checked against the **fresh** ledger at execution — a refund that landed via webhook between draft and confirm shrinks `maxRefundableCents` and can invalidate a stale draft.
- **Why `max(webhook, localInFlight)`** (critical, do not omit): if the 9a webhook is lagging or (mis-)configured, `refundedAmountCents` may still be 0 right after a successful refund. Counting this payment's own non-failed `refund_initiations` rows means a second refund is capped correctly **even before the webhook lands**, closing the double-refund window that would otherwise exist during webhook lag. `payment_refunds`/`refunded_amount_cents` remain webhook-owned; this is a *read-side* union for the cap only, not a canonical write.

### 3.2 Stripe idempotency key (double-click / retry cannot double-refund)
- Every `POST /v1/refunds` is sent with an **`Idempotency-Key`** header equal to the `refund_initiations.id` (a UUID minted once per initiating action; §4). Stripe guarantees at-most-once execution per key — a network retry or a double-submit of the same initiation returns the *same* refund object, never a second refund.
- The key is **deterministic per (payment, amount, initiating-action)**: it is minted at "prepare" time and persisted, so any retry of that same initiation reuses it. A *deliberate* new refund is a new "prepare" → new id → new key (correctly a distinct refund).

### 3.3 In-flight guard (local, belt-and-suspenders to Stripe's key)
On execute, load the `refund_initiations` row by id:
- `pending` → proceed (transition to `submitting` **before** the Stripe call).
- `submitting` or `succeeded` → **do not call Stripe again**; return the existing row's result (idempotent response). This is the local guard against a double-click racing the network.
- `failed` → terminal for that id; a user "try again" mints a **fresh** initiation (new id/key). Do not silently reuse a failed key from a new user action.

Ordering (no `db.transaction` — D1 rejects it; Active-Learning Log): INSERT the `submitting` claim **before** the network call, UPDATE to `succeeded`/`failed` **after**. If the process dies between claim and response, the row is left `submitting`; a reconciliation surfaces it (§4.4) and Stripe's idempotency key makes any retry safe.

### 3.4 Ownership + eligibility check before refunding
Before any Stripe call, confirm the target is a real payment we own:
- The `paymentId` resolves to an `invoice_payments` row **and** that row's `invoiceId` matches the route `id` (same defensive check as `createInvoicePaymentCheckoutSession`, stripe-checkout.ts:187).
- `payment.status === "paid"` (a settled Stripe collection; `waived`/`unpaid`/`pending` are ineligible — P7).
- `payment.externalPaymentId` is a non-empty `pi_…` (there is a Stripe charge to refund; cash/check payments are rejected).
- `payment.dispute_status !== "open"` (P5).
- `maxRefundableCents > 0` (§3.1).

### 3.5 Secret handling — fail-closed, never logged
- The Stripe secret key is read via a fail-closed accessor (`STRIPE_SECRET_KEY?.trim()`, throw if unset — identical to `stripeSecretKey()` in stripe-checkout.ts:17). No dev fallback in production.
- **Never** log the secret key, the `Authorization` header, or the raw Stripe request. **Never** log full PII (client email, card data — we never see card data). Activity/audit logs carry only `{ invoiceId, paymentId, amountCents, reason, stripeRefundId, initiationId, initiatedBy, result }`.

### 3.6 Endpoint hardening
- Admin-only, **POST**, `guardDirectWorkerApiRequest` (origin guard) at the top of every route (§5).
- **Never** added to `PUBLIC_API_PREFIXES` / `isPublicOriginBypassApiPath` (origin-guard.ts). The Stripe *webhook* path is public-bypass (it must be, for 9a); the refund-**initiation** route is the opposite — a first-class admin mutation behind the Pages-proxy admin wall + origin secret. (Active-Learning Log: do NOT add mutation endpoints to origin-guard bypass lists.)
- **Never** reachable from `/api/agent/*` or the MCP tool registry (§5).

### 3.7 Audit every attempt
`logActivity` (actorType `"admin"`, actorName the admin identity) on:
- `invoice.payment_refund_initiated` — on a successful Stripe call, with `{ invoiceId, paymentId, amountCents, reason, stripeReason, stripeRefundId, initiationId }`.
- `invoice.payment_refund_initiation_failed` — on a rejected pre-check or a Stripe error, with `{ paymentId, amountCents, errorMessage (capped), initiationId }`.
Register both action strings wherever activity actions are enumerated/formatted (`formatActivityAction`).

---

## 4. Interleave with 9a recording (one source of truth, idempotent across both systems)

The core contract: **9b initiates, 9a records.** 9b never writes `payment_refunds` or `refunded_amount_cents`. Those come only from the inbound `refund.created` / `charge.refunded` webhooks that Stripe fires *because* 9b initiated.

### 4.1 The initiation lifecycle (new `refund_initiations` table — NOT `payment_refunds`)

```
1. PREPARE  (admin opens refund dialog)
   → INSERT refund_initiations { id=uuid, invoicePaymentId, stripePaymentIntentId,
       amountCents=maxRefundableCents (prefill), status='pending', initiatedBy }
   → id is BOTH our row id AND the Stripe Idempotency-Key.

2. EXECUTE  (admin types the confirm amount, submits)
   → re-check ledger (§3.1), typed-amount == amountCents, eligibility (§3.4)
   → UPDATE refund_initiations SET status='submitting'          (claim BEFORE network)
   → POST /v1/refunds  (Idempotency-Key: id)                    (money moves here)
   → UPDATE refund_initiations SET status='succeeded'|'failed',
       stripeRefundId=re_..., errorMessage=..., updatedAt
   → logActivity(initiated | initiation_failed)

3. RECORD  (Stripe → our webhook, seconds later; 9a code, unchanged)
   → refund.created / charge.refunded arrive at /api/stripe/webhook
   → 9a recordStripeRefund / recordStripeChargeRefunded write the CANONICAL
     payment_refunds row (dedupe on stripe_refund_id) + set refunded_amount_cents
     (set-to-authoritative) + (at enforce) flip status to "refunded".
```

`refund_initiations` is an **audit + idempotency** table. `payment_refunds` is the **canonical ledger**, webhook-owned. They are joined for display on `stripe_refund_id` but 9b never writes the canonical table.

### 4.2 No double-count
- Because 9b does **not** write `payment_refunds`, there is exactly one canonical row per Stripe refund — the one 9a inserts `ON CONFLICT DO NOTHING` keyed on `stripe_refund_id`.
- If Stripe redelivers `refund.created`, 9a's per-object convergence (9a §1.2) keeps it a single row. 9b's involvement ends at the Stripe response.
- The `stripeRefundId` 9b stores on the initiation row is a **read-only cross-reference** (lets the UI show pending→succeeded before the webhook lands); it is never treated as the canonical ledger.

### 4.3 UI reflects pending → succeeded
The invoice/payment view shows refund state by joining the two:
- **`refund_initiations.status`** = what *we* did (`pending` → `submitting` → `succeeded`/`failed`) — visible immediately.
- **`payment_refunds`** row + **`refunded_amount_cents`** = webhook-confirmed canonical state — visible when the webhook lands (usually seconds).
- Display rule: `succeeded` initiation with a matching `payment_refunds` row → "Refunded" (confirmed). `succeeded` initiation with **no** matching webhook row yet → "Refund submitted (awaiting confirmation)". `failed` → show the cleaned Stripe error.

### 4.4 Reconciliation — webhook-never-arrived detection
A `refund_initiations` row `status='succeeded'` older than a threshold (e.g. 24h) with **no** `payment_refunds` row sharing its `stripe_refund_id` means the recording webhook never arrived (webhook mis-subscribed or dropped). Surface this in the existing **needs_reconciliation** finance view (extend `paymentLedgerNeedsReconciliation` / the agent-finance `reconciliation` block, 9a §2.1) as an **"Initiated refund not yet recorded"** item. This is the tripwire for the "9a webhook not subscribed" failure mode (§11 precondition).

### 4.5 D1 no-transaction discipline (Active-Learning Log)
Same as 9a: **no `db.transaction` / `db.batch`** for this flow (D1 rejects them at runtime; passes in dev better-sqlite3, 500s in prod). Each step is an independent convergent write; the `submitting` claim is written before the network call and the `succeeded`/`failed` update after. A crash mid-flow leaves a recoverable `submitting` row, and Stripe's idempotency key makes the retry safe.

---

## 5. Auth model (admin-only; never agent-reachable)

### 5.1 Routes (all under `/api/invoices/*`, never `/api/agent/*`)
Two-phase to support the typed-confirmation + persisted idempotency key:

| Method + path | Purpose | Guard |
| --- | --- | --- |
| `POST /api/invoices/[id]/payments/[paymentId]/refund/prepare` | Mint a `refund_initiations` row (`pending`), return `{ initiationId, maxRefundableCents, currency }`. | `guardDirectWorkerApiRequest` + admin-proof/proxy admin session + flag check |
| `POST /api/invoices/[id]/payments/[paymentId]/refund/execute` | Body `{ initiationId, amountCents, confirmAmountCents, reason, stripeReason? }`. Validate, re-check ledger, call Stripe, update row. | same |

Both mirror the existing admin mutation shape (checkout route, invoices/[id]/status route): `const blocked = guardDirectWorkerApiRequest(request); if (blocked) return blocked;` first line, then the flag gate, then the helper, then a 303/JSON response. No new auth primitive — reuse the exact origin-guard + Pages-proxy admin wall every other admin mutation uses (this is the same trust boundary as `/api/invoices/[id]/payments/[paymentId]/checkout`).

### 5.2 Library boundary
- New module `src/lib/stripe-refund-initiation.ts` exporting `initiateInvoicePaymentRefund({ invoiceId, paymentId, initiationId, amountCents, confirmAmountCents, reason, stripeReason, actorType, actorName })`.
- It takes `actorType` and **throws immediately** if `actorType !== "admin"` (defense-in-depth: even if some future code path tried to call it as `"agent"`/`"system"`, it refuses — this is stricter than the draft-only guard because there is *no approval that unlocks it*).
- The module is imported **only** by the two `/api/invoices/*` routes above — never by `src/lib/studio-mcp.ts`, never by any `/api/agent/*` route.

### 5.3 No agent / MCP surface (stricter than the existing finance guard)
- There is **no** `studio_initiate_refund` MCP tool and **no** `/api/agent/.../refund` route. Money-movement is not merely "requires Tyler approval" (the pattern for invoice/payment writes) — it is **absent from the agent surface entirely**.
- The existing `requireTylerApprovalForAgentFinance` (sales.ts:697) continues to block agent *recording* mutations; 9b adds nothing agent-callable to block, because it exposes nothing to agents.
- **Guard test** (extends `agent-finance-guard.test.ts` / `studio-mcp.test.ts`): (a) the MCP `tools/list` surface contains no refund-initiation tool; (b) no `/api/agent/*` route imports `stripe-refund-initiation.ts`; (c) calling `initiateInvoicePaymentRefund` with `actorType: "agent"` throws and makes **zero** Stripe calls (fetch spy asserts 0 calls to `api.stripe.com/v1/refunds`) and writes zero `refund_initiations` rows.

---

## 6. Migration sketch (0091, additive)

One new table. It is **not** on an always-on read path (only touched when the refund feature is used), so migration-ordering is low-risk — but apply-before-deploy anyway for discipline (Active-Learning Log). All columns `NOT NULL DEFAULT` where applicable (SQLite-safe, no table rewrite).

```sql
-- migrations/0091_refund_initiation.sql
-- Phase 9b: audit + idempotency ledger for admin-initiated Stripe refunds.
-- 9b MOVES money via POST /v1/refunds. This table records WHO/WHEN/HOW-MUCH and holds
-- the deterministic Stripe Idempotency-Key. It is NOT the canonical refund ledger —
-- payment_refunds (9a, webhook-owned) is. Never written from an agent/webhook path.
CREATE TABLE IF NOT EXISTS refund_initiations (
  id                       TEXT PRIMARY KEY NOT NULL,   -- our uuid; ALSO the Stripe Idempotency-Key
  invoice_payment_id       TEXT NOT NULL REFERENCES invoice_payments(id) ON DELETE CASCADE,
  stripe_payment_intent_id TEXT,                        -- pi_... snapshot at initiation
  amount_cents             INTEGER NOT NULL DEFAULT 0,
  currency                 TEXT NOT NULL DEFAULT 'usd',
  reason                   TEXT,                         -- internal reason (audit; capped 500)
  stripe_reason            TEXT,                         -- requested_by_customer | duplicate | fraudulent
  status                   TEXT NOT NULL DEFAULT 'pending', -- pending | submitting | succeeded | failed
  stripe_refund_id         TEXT,                         -- re_... returned by Stripe (read-only cross-ref)
  error_message            TEXT,                         -- cleaned Stripe error (capped)
  initiated_by             TEXT,                         -- admin identity (actorName)
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refund_initiations_payment ON refund_initiations(invoice_payment_id);
CREATE INDEX IF NOT EXISTS idx_refund_initiations_refund  ON refund_initiations(stripe_refund_id);
CREATE INDEX IF NOT EXISTS idx_refund_initiations_status  ON refund_initiations(status);
```

**Mirror in three places** (9a finding #5 — or the tsx test plan fails on a missing table):
1. `src/db/schema.ts` — `refundInitiations` table.
2. `src/db/studio-canon.test.ts` — drift/canon assertion (follow the "external ids uniquely indexed for ledger reconciliation" pattern).
3. `src/db/client.ts` local-dev `migrate()` — `CREATE TABLE IF NOT EXISTS refund_initiations …` + indexes (idempotent block, like every migration 0085–0090).

---

## 7. The Stripe call (exact pattern — follows stripe-checkout.ts verbatim)

Reuse the checkout-mint pattern (stripe-checkout.ts:57–79): secret-key Bearer auth, x-www-form-urlencoded body, pinned `stripe-version`, JSON error parsing, no key logging. Add the **`Idempotency-Key`** header.

```ts
// src/lib/stripe-refund-initiation.ts (sketch — do NOT copy verbatim into other phases)
const STRIPE_API_VERSION = "2026-02-25.clover"; // match stripe-checkout.ts

function stripeSecretKey() {                      // fail-closed, never logged
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("Stripe is not configured. Add STRIPE_SECRET_KEY before issuing refunds.");
  return key;
}

// params: payment_intent=pi_...  amount=<cents>  reason=<stripeReason?>
//         metadata[invoice_payment_id]=...  metadata[initiation_id]=...
const response = await fetch("https://api.stripe.com/v1/refunds", {
  method: "POST",
  headers: {
    authorization: `Bearer ${stripeSecretKey()}`,
    "content-type": "application/x-www-form-urlencoded",
    "stripe-version": STRIPE_API_VERSION,
    "idempotency-key": initiationId,              // ← at-most-once per initiating action
  },
  body: params,
});
const body = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(stripeErrorMessage(body) ?? "Stripe refund failed."); // cleaned message only
// body.id = "re_...", body.status = "succeeded" | "pending" | ...
```

Notes:
- Use `payment_intent` (we store `pi_…` in `external_payment_id`); Stripe refunds against that PI's charge. Send an explicit `amount` (never rely on "omit = full" — determinism).
- Stripe may return `status: "pending"` (async settlement) with a 200 — that is a **success** (the refund is accepted); the 9a webhook will finalize it. Store `succeeded` on our initiation row when the HTTP call is 2xx; the *Stripe* refund status lives in `payment_refunds` via the webhook.
- Do not build a second Stripe secret accessor if a shared one is extracted; if `stripeSecretKey()` is promoted to a shared `src/lib/stripe-client.ts`, reuse it (keep the checkout path behavior identical).

---

## 8. Off-by-default flag + dark rollout

- **`REFUND_INITIATION_ENABLED`** (default **OFF**). A hard money gate — a single boolean, read **in the body** (never as a default param — TS2559, Active-Learning Log) via `refundInitiationEnabled()` in `src/lib/finance-flags.ts`. When off, **both** routes short-circuit with a 403 `{ error: "Refund initiation is disabled." }` **before** any Stripe call, and the admin UI hides/disables the refund control. Even a fully authenticated admin cannot move money while the flag is off.
- **Two Tyler actions gate real money:** (1) flip `REFUND_INITIATION_ENABLED` on; (2) issue the first real refund. Neither is autonomous (guardrails 2 + 3).
- **Dependency on 9a flags Tyler must set together** (§11): the recording webhook must be **subscribed at Stripe** and `FINANCE_REFUND_RECORDING` should be at `enforce` before the first real refund, or money moves without being recorded / reflected in status.
- **Migration 0091 applied before the Worker deploy** (discipline), via the idempotent direct `d1 execute --file` pattern (`CREATE TABLE IF NOT EXISTS`), verified, then Worker + Pages-proxy deploy. No `migrations apply --remote` (tracker out of sync — Active-Learning Log).
- **Deploy is reversible** (guardrail 4): real D1 backup → capture Worker rollback version → deploy dark (`REFUND_INITIATION_ENABLED` unset) → health-check → rollback-ready. **Instant kill-switch:** `wrangler secret delete REFUND_INITIATION_ENABLED` (or set `0`) → no refund can be initiated; nothing else changes.

---

## 9. Test plan (tsx; build-exit-code gate)

All tests spy on `fetch` and assert `api.stripe.com/v1/refunds` call counts.

1. **Happy path (mocked Stripe)** — prepare → execute a full refund → exactly **one** `POST /v1/refunds` with `Idempotency-Key = initiationId` and `amount = maxRefundableCents`; `refund_initiations` row `succeeded` with `stripe_refund_id`; activity `invoice.payment_refund_initiated` logged.
2. **Partial refund** — `amountCents < maxRefundableCents` accepted; over-cap partial rejected (see #3).
3. **Amount over-cap rejected** — `requestedAmountCents > grossCollectedCents - alreadyRefundedCents` → rejected, **zero** Stripe calls, `initiation_failed` logged.
4. **Ledger re-check uses `max(webhook, local in-flight)`** — with `refundedAmountCents = 0` but a prior `succeeded`/`submitting` `refund_initiations` row summing to the full gross, a second refund is capped/rejected → **zero** Stripe calls (proves the webhook-lag double-refund window is closed).
5. **Disputed payment rejected** — `dispute_status = "open"` → rejected, zero Stripe calls (P5).
6. **Idempotency-key prevents double-refund** — two `execute` calls with the same `initiationId`: the first calls Stripe once; the second hits the in-flight guard (`submitting`/`succeeded`) and makes **zero** additional Stripe calls, returning the existing result.
7. **Typed-confirmation mismatch rejected** — `confirmAmountCents !== amountCents` → rejected, zero Stripe calls.
8. **Eligibility** — non-`paid` status, null `external_payment_id`, or `paymentId`/`invoiceId` mismatch each → rejected, zero Stripe calls.
9. **Agent/MCP CANNOT initiate** — (a) MCP `tools/list` has no refund-initiation tool; (b) no `/api/agent/*` route imports the initiation module; (c) `initiateInvoicePaymentRefund({ actorType: "agent" })` throws and makes **zero** Stripe calls + writes zero `refund_initiations` rows (extends `agent-finance-guard.test.ts`).
10. **Admin-only auth** — direct-Worker origin (no origin secret) → `guardDirectWorkerApiRequest` 404, zero Stripe calls; refund routes are **not** in `isPublicOriginBypassApiPath` (extends `origin-guard.test.ts` classifier/drift assertion).
11. **Fail-closed secret** — `STRIPE_SECRET_KEY` unset → execute throws before any network call; secret never appears in logs/errors.
12. **No direct `payment_refunds` write** — after a successful initiation, `payment_refunds` and `refunded_amount_cents` are **unchanged** (recording still comes only from the webhook); then simulate the `refund.created`/`charge.refunded` webhook (9a path) and assert exactly one `payment_refunds` row appears (no duplicate from 9b).
13. **Flag-off blocks initiation** — `REFUND_INITIATION_ENABLED` unset → both routes 403, zero Stripe calls, no `refund_initiations` row.
14. **Reconciliation tripwire** — a `succeeded` initiation with no matching `payment_refunds` row surfaces in needs_reconciliation (§4.4).
15. **Build gate** — `npm run build` **exit code 0** (type-check passes), `npm test` green, `npm run lint`; canon/drift updated for `refund_initiations`.

---

## 10. Ordered task breakdown (effort / risk)

| # | Task | Effort | Risk |
| --- | --- | --- | --- |
| 1 | Migration `0091` `refund_initiations`; mirror in `schema.ts`, `studio-canon.test.ts`, `client.ts` `migrate()`. | S | Low (additive, not always-on) |
| 2 | `refundInitiationEnabled()` in `finance-flags.ts` (single OFF boolean, read in body). | S | Low |
| 3 | `src/lib/stripe-refund-initiation.ts`: `initiateInvoicePaymentRefund` — eligibility + ledger re-check (§3.1, `max(webhook,local)`), `refund_initiations` lifecycle, Stripe call with Idempotency-Key, fail-closed secret, no-log, activity logs, `actorType!=="admin"` throw. | **L** | **High (moves real money — correctness of cap/idempotency/eligibility is load-bearing)** |
| 4 | Two admin routes `refund/prepare` + `refund/execute` (`guardDirectWorkerApiRequest` + flag gate + admin-proof), typed-confirmation validation. | M | Med (most sensitive admin mutation) |
| 5 | Admin UI: refund control on the invoice/payment view (full prefill + partial + reason + typed-amount confirm), pending→succeeded display joining `refund_initiations` + `payment_refunds`. | M | Med |
| 6 | Reconciliation surfacing: "initiated refund not yet recorded" tripwire in the needs_reconciliation view (extend 9a §2.1). | S | Low |
| 7 | Guard tests (no agent/MCP surface, `actorType` throw, origin-guard, flag-off) + full test plan §9 + build-exit-code gate. | M | Med (the safety net) |
| 8 | Deploy **dark**: backup → apply 0091 → verify → deploy Worker + proxy → health-check → rollback-ready; `REFUND_INITIATION_ENABLED` unset. **Hold for Tyler's go before this step runs.** | S | **Gated — money-movement pause** |

Effort: S ≈ ≤0.5d, M ≈ 0.5–1d, L ≈ 1–2d.

---

## 11. Active-Learning-Log pitfalls pre-empted (mapping)

| Log pitfall | How 9b pre-empts it |
| --- | --- |
| **D1 has no usable transaction** | No `db.transaction`/`db.batch`. `submitting` claim written before the network call, `succeeded`/`failed` after; Stripe idempotency key makes any retry safe (§3.3, §4.5). |
| **Off-by-default flag** | `REFUND_INITIATION_ENABLED` default OFF; both routes 403 before any Stripe call (§8). Money gate is a hard boolean, flipped only by Tyler. |
| **Attacker-chosen ids / untrusted input** | Every field validated + capped (reuse 9a's `capId`/`capReason`/`clampAmountCents`); amount re-checked server-side against the fresh ledger; typed-amount confirm; ownership check (§3). |
| **Agent authority** | Money-movement is **absent** from the agent surface (stricter than the approval guard); `actorType!=="admin"` throw + guard test asserting zero Stripe calls (§5). |
| **Secrets fail closed** | `stripeSecretKey()` throws when unset; no dev fallback in prod; key never logged (§3.5). |
| **Never silent-drop / no double-count** | 9b never writes `payment_refunds`; recording comes only from the 9a webhook; `stripeRefundId` cross-ref is read-only; reconciliation tripwire catches a missing webhook (§4). |
| **Origin-guard bypass discipline** | Refund routes use `guardDirectWorkerApiRequest` and are **never** added to `PUBLIC_API_PREFIXES`/`isPublicOriginBypassApiPath`; drift test asserts this (§3.6, §9.10). |
| **Prod D1 migrations** | 0091 via idempotent `d1 execute --file`, verified before Worker deploy; no blanket `migrations apply --remote` (§8). |
| **Deploy rails / reversible** | Backup → rollback version → dark deploy → health-check → instant flag kill-switch (§8). |
| **Settled-status enumeration** | 9b does NOT introduce or flip any status — status handling stays entirely in 9a's already-enumerated settled-status logic (P8); 9b only moves money and records the initiation. |
| **TS2559 weak-type env** | Flag read in the body, not as a default param (§8). |

---

## 12. The explicit deploy checkpoint (Tyler-only)

**This is the section that lets Tyler say "go" — read it before approving.**

Even after the 9b code is built, Fable-reviewed, and passes the build-exit-code gate, **three things remain gated on Tyler and are NOT autonomous:**

1. **The FIRST live deploy of this code** — because it is the first and only code in the app that can call Stripe's mutating refund endpoint — **requires Tyler's explicit go** (Autonomous Build Loop guardrail 3). The loop stops here and asks. The deploy itself is dark (`REFUND_INITIATION_ENABLED` unset), so even the deploy moves no money — but the go is still required before it ships.

2. **Turning `REFUND_INITIATION_ENABLED` on** is a Tyler action (guardrail 2). Until it is on, no refund can be initiated by anyone.

3. **Issuing the first real refund** is a Tyler action, performed by Tyler in the admin UI, with the typed-amount confirmation.

**Preconditions Tyler must confirm are true before enabling (or money moves without being recorded/reflected):**
- **9a recording webhook is subscribed at Stripe** for `charge.refunded` / `refund.*` (9a enable-runbook item 1). If it is not, a 9b refund moves money but 9a never records it — the reconciliation tripwire (§4.4) will fire, but the canonical ledger will lag. The `max(webhook, local in-flight)` cap (§3.1) still prevents a double-refund in that window, but the books will be wrong until the webhook is fixed.
- **`FINANCE_REFUND_RECORDING = enforce`** (9a enable-runbook item 2), so a full refund actually flips the payment to the terminal `refunded` status and recomputes the invoice. At `record_only`, a full refund still moves money and records the child row + net figures, but the payment stays `paid` in status. Recommended: enforce is on before the first real refund.
- A **known-safe test target** (e.g. refund a small, recent Stripe test/real charge Tyler controls) for the very first refund, watched end-to-end: initiation `succeeded` → webhook lands → `payment_refunds` row + `refunded_amount_cents` update → (at enforce) status flip.

**Instant rollback at any point:** `wrangler secret delete REFUND_INITIATION_ENABLED` (or set `0`) → no further refund can be initiated; already-issued refunds are unaffected (they are real money movements at Stripe, recorded by 9a). Worker rollback to the captured pre-9b version removes the initiation code entirely.
