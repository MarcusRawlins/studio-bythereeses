# Phase 9b: Refund INITIATION — admin-triggered Stripe refund (MOVES REAL MONEY)

Status: 🔴 speccing → **MONEY-MOVEMENT PAUSE**. Build allowed; **first live deploy needs Tyler's explicit go** (Autonomous Build Loop guardrail 3). Ships behind an OFF flag; **turning the flag on and issuing the first real refund are Tyler-only actions.**
Migration: `0091` (additive; latest applied is `0090_intelligence_forecasting`).
Pairs with: `phase-9a-finance-completeness.md` (the refund/dispute **recording** that already ships dark at `FINANCE_REFUND_RECORDING=record_only`).

> **What makes 9b different from every prior phase.** Every phase before this one either read data or reacted to a webhook describing money that **already** moved. 9b is the first and only code in the app that calls a Stripe **mutating** endpoint (`POST /v1/refunds`) — it *causes* money to leave the business bank account. There is no undo. This document is the artifact Tyler reviews to grant or withhold the go; the product decisions are made explicit below (with recommended defaults) and the safety rails are specified to be airtight and testable.

---

## Rev 3 (owner refund policy) — changelog

Rev 3 encodes **Tyler's stated refund policy** into the spec's rails, product decisions, and tests. Tyler's words (verbatim): *"For refunds, refunds are only ever issued if service isn't rendered. No refunds on the initial retainer of services. No refunds on the initial retainer of services. All processing fees I want passed to the client."* Each change below is grounded in the real schema/code (read before writing) and, where the code signal is weak or a business meaning had to be interpreted, that interpretation is **stated explicitly for Tyler to confirm at the deploy gate** rather than guessed silently.

| Tyler's rule | Encoded as | Where |
| --- | --- | --- |
| **"Refunds only ever issued if service isn't rendered."** The system cannot verify whether service was rendered, so this is a **policy gate the admin affirms**, not an automated check. | Execute payload gains a **required** `service_not_rendered_confirmed: true` boolean **and** a required free-text `reason`; the helper **refuses server-side if either is absent/false** (not just UI). Both are persisted on the `refund_initiations` audit row. | §2 P10, §3.1/§3.4, §3.9 (new), §4.1, §5.1/§5.2, §6, §9.17 |
| **"No refunds on the initial retainer of services."** | The retainer payment is **HARD-BLOCKED server-side** from refund initiation. Because the schema has **no** `payment_type`/deposit-flag column, the predicate reuses the codebase's existing `isRetainerPaymentLabel` **and** unions it with "earliest payment on the invoice" (safest robust rule given a weak label-only signal). | §2 P9, §3.4, §3.8 (new), §9.16 |
| **"All processing fees I want passed to the client."** | The refundable ceiling is redefined to the **SERVICE portion the studio actually keeps** (`paidAmountCents`), **not** gross (`grossCollectedCents` = service + client card fee). The client never gets the processing/card fee back. Every ceiling reference is moved off gross onto the service basis. | §2 P11, §3.1 (rewritten), §4.1, §7, §9.3/§9.4/§9.18/§9.19 |

**Interpretations flagged for Tyler's confirmation at the deploy gate (Rev 3 did NOT guess these):**
1. **"Initial retainer" = which payment row?** There is no retainer/deposit column in `invoice_payments`; the only signals are the free-text `label` and payment ordering. Rev 3 blocks **(a)** any payment whose label matches the existing `isRetainerPaymentLabel` (`/\b(retainer|deposit)\b/i`, sales.ts:102) **OR (b)** the earliest payment on the invoice. If Tyler names retainers differently, rule (b) still catches the first installment. **Confirm this predicate matches how you label retainers.** (§3.8, Risk 6.)
2. **"Pass processing fees to the client" = refund only the service portion.** Rev 3 interprets this as: the refundable ceiling is `paidAmountCents` (service kept), so the client bears their own card fee on a refund; the studio never returns the fee it collected. Stripe *also* does not return its own processing fee on a refund (existing Risk 5), so refunding only the service portion keeps the studio whole on service while the client bears their card fee. **Confirm the ceiling should be service, not gross.** (§3.1, Risk 7.)

---

## Rev 2 (Fable spec-review) — changelog

Rev 2 addresses an adversarial Fable review (REQUEST-CHANGES; 0 BLOCKER, 2 MAJOR, 4 MINOR). Each fix was verified against the cited code before landing.

| Finding | Severity | What changed |
| --- | --- | --- |
| **M1** — stuck-`submitting` double-refund via 24h idempotency-key expiry; §3.3/§4.5 contradiction; reconciliation gap | MAJOR | **Absolute rule: a `submitting` row is NEVER blind-retried** (removed the §4.5/§3.3 "Stripe's idempotency key makes the retry safe" language — the key **expires after ~24h**, so a re-POST of an old stuck row is a FRESH refund → double-pay). §3.2 now states the ~24h expiry constraint explicitly. §3.3 recovery = **reconcile against Stripe** (query refunds for the PI / match `metadata[initiation_id]`), then manually resolve the row to `succeeded`/`failed` — never re-POST. §4.4 reconciliation extended to surface `submitting` rows older than **~1h** (the money-BLOCKED wedge: a stuck `submitting` row pins `maxRefundable=0` and the old `status='succeeded'`-only query never saw it). |
| **M2** — §12 didn't verify the auth boundary is ARMED (both guards fail-OPEN when their env is unset) | MAJOR | §12 adds a **hard-blocking, smoke-asserted precondition**: confirm `ORIGIN_PROXY_SECRET` is set at the Worker AND `ADMIN_PROOF_ENFORCE=1` **before** flipping `REFUND_INITIATION_ENABLED` on. Named alongside the webhook-subscription precondition. (`origin-guard.ts:61` returns `false` — no block — when the secret is unset; `adminProofEnforced` is `false` unless the flag is exactly `"1"`, `admin-proxy-auth.test.ts:197`.) |
| **M3** — amount not pinned between prepare and execute; §3.2 idempotency-key wording wrong | MINOR | §3.2/§4.1: the `submitting`-claim UPDATE now **persists the final `amountCents` onto the row**, and the Stripe POST sends **exactly the row's persisted amount** (not the prepare-time prefill). Corrected §3.2: the amount is **not** in the Idempotency-Key; the real guarantee is Stripe **rejects same-key-different-params with `idempotency_error`**. New test §9.15: two executes, same `initiationId`, different amounts → **exactly one** refund. |
| **M4** — flag parse + defense-in-depth | MINOR | §8: `refundInitiationEnabled()` parses **strict `=== "1"`** (matches `adminProofEnforced`; `"true"`/`"0"` read as off), and the flag check now also lives **inside** `initiateInvoicePaymentRefund` itself, not only in the routes. |
| **M5** — dispute-lag race + local `lost`-and-not-reinstated geometry | MINOR | §2 P5: states **Stripe is the backstop** for the just-opened-dispute lag race (Stripe rejects refunds on actively-disputed charges → the initiation lands `failed`, no double-loss); adds a **local block** on `dispute_status="lost" && !fundsReinstated` (the true double-loss shape). |
| **M6** — `charge.refunded` is the load-bearing subscription; §3.3 lifecycle wording | MINOR | §11/§12 name **`charge.refunded` specifically** as load-bearing: only `recordStripeChargeRefunded` sets `refunded_amount_cents` + drives the status flip; `recordStripeRefund` (`refund.created/updated`) writes child rows + `lastRefundAt` only. §3.3/§4.1 wording made consistent: the lifecycle **INSERTs `pending` at prepare** and **UPDATEs to `submitting` at execute** (no "INSERT the submitting claim"). |

---

## 1. Scope + the money-movement boundary (restated)

**In scope (9b):** an **admin-only** UI action + endpoint that calls Stripe `POST /v1/refunds` to issue a full or partial refund against an `invoice_payments` row we own; a small **`refund_initiations`** audit/idempotency table (migration 0091) that records every initiation attempt; the safety rails (SERVICE-portion amount cap, ledger re-check, typed confirmation, retainer hard-block, service-not-rendered affirmation, Stripe idempotency key, in-flight guard); an OFF-by-default flag; and the interleave with 9a so the canonical ledger stays single-sourced.

**Explicitly OUT of scope (do NOT build in 9b):**
- **Writing `payment_refunds` / `refunded_amount_cents` directly.** The canonical refund ledger is owned by the 9a inbound webhook. 9b initiates; 9a records. One source of truth (§4).
- Any **charge / capture / account-credit** (money *in* or store credit) — not this phase, not this app yet.
- **Agent / MCP** refund initiation — money-movement is admin-only and is **never** exposed on the agent surface, with or without approval. This is stricter than the existing draft-only finance guard (§5).
- Refunding a **booking-linked** Stripe payment (`scheduler_bookings.external_payment_id`). 9a records booking-linked refunds but never mutates booking status; 9b's first cut refunds **`invoice_payments` only**. Booking refunds are a later, deliberate increment.
- Direct QuickBooks/Xero write-back, dispute *responses* (evidence submission), partial-capture, etc.

**Litmus test for every task:** *"Does this call `api.stripe.com/v1/refunds`, or gate/record a call that does?"* → 9b, and it lives behind the OFF flag. Anything that only reads our DB or reacts to a webhook is 9a and already shipped.

---

## 2. Product decisions to surface for Tyler (explicit choices + recommended defaults)

Each row is a decision Tyler is being asked to ratify. The **Recommended default** is what the build will implement unless Tyler says otherwise. **Rows tagged `ADOPTED — owner policy` (P9–P11) are no longer "defaults"** — they encode Tyler's verbatim refund policy (Rev 3) and are hard rails, not toggles. P1–P8 remain the recommended defaults for the mechanics around that policy.

| # | Decision | Options | **Recommended default** | Rationale |
| --- | --- | --- | --- | --- |
| P1 | Full vs partial refunds | full-only / full+partial | **full + partial (within the SERVICE ceiling, P11)** | Real-world refunds are often partial. UI pre-fills the **full remaining refundable SERVICE** amount (`maxRefundableCents`, §3.1); admin may reduce it. Note: "retainer kept, balance returned" is now stronger than a default — the retainer row itself is hard-blocked (P9). |
| P2 | Refund reason capture | none / internal note / Stripe reason + internal note | **both — internal reason (required, ≥3 chars, capped 500) + Stripe `reason` (default `requested_by_customer`)** | Internal reason is the audit trail (activity log + `refund_initiations.reason`); Stripe `reason` ∈ `requested_by_customer\|duplicate\|fraudulent` is optional metadata on Stripe's side. Reason is never a security decision input. |
| P3 | Second / typed-amount confirmation | single click / typed-amount confirm | **typed-amount confirm (must type the exact cents/dollar figure, server-validated against the same amount)** | This is the most destructive admin action in the app and it is irreversible. A typed confirmation is cheap and defeats accidental / double-click refunds. |
| P4 | Approval step vs admin-direct | in-app second approver / admin-direct | **admin-direct** (no separate in-app approver) | Tyler *is* the owner/admin; there is no second human. The "approval" that matters is the money-movement guardrail itself: the OFF flag + the first real refund are Tyler actions (§8, §11). Agents can never initiate (§5). |
| P5 | Refund a payment with an **OPEN dispute** | allow / block | **BLOCK** | Stripe blocks/complicates refunding a charge under dispute, and refunding during a dispute risks a **double loss** (you refund *and* lose the chargeback). Disputes resolve through the dispute flow (9a records `won`/`lost`/`reinstated`), not a refund. Reject with a clear message when `invoice_payments.dispute_status = "open"`. **See the P5 dispute-edge notes below the table for the two geometries the local `dispute_status="open"` gate does not by itself close.** |
| P6 | Refund window limit | app-enforced window / rely on Stripe | **rely on Stripe** (no hard app window) + **soft warn** if the charge is > 120 days old | Stripe already fails very old / insufficient-balance refunds; we surface Stripe's error verbatim (cleaned). Encoding our own window would drift from Stripe's rules. |
| P7 | Payment eligibility | any status / paid-and-partially-refunded only | **only Stripe-collected `paid` (incl. already-partially-refunded) payments with a non-null `external_payment_id` (pi_…)** | A `waived` payment collected nothing; a cash/check payment has no Stripe charge to refund; a fully-`refunded` payment has `maxRefundable = 0` (rejected by the amount cap). |
| P8 | Invoice/project state after refund | 9b mutates status / 9a webhook mutates status | **9a owns all status changes** | 9b moves money; the resulting `charge.refunded` webhook lets 9a set `refunded_amount_cents` and (at `FINANCE_REFUND_RECORDING=enforce`) flip a fully-refunded payment to the terminal `refunded` status via the enumerated settled-status handling (9a §1.6). 9b never touches `payment.status` or the invoice. **Consequence Tyler must know:** to have a full refund *reflected in invoice/payment status*, `FINANCE_REFUND_RECORDING` must be at `enforce` (§8, §11). |
| **P9** | Refund the **initial retainer** | allow / hard-block | **ADOPTED — owner policy: HARD-BLOCK (server-side).** | Tyler: *"No refunds on the initial retainer of services."* The initiate endpoint **refuses** if the target payment is the retainer, with a clear reason. Enforced in the helper (§3.8), not just the UI. Predicate (schema has no retainer column): the payment is a retainer if its label matches `isRetainerPaymentLabel` (`/\b(retainer\|deposit)\b/i`, sales.ts:102) **OR** it is the earliest payment on the invoice (§3.8). |
| **P10** | Require a **"service not rendered"** affirmation | none / required affirmation + reason | **ADOPTED — owner policy: REQUIRED affirmation + required reason.** | Tyler: *"refunds are only ever issued if service isn't rendered."* The system can't verify service delivery, so this is a **policy gate the admin affirms**: execute requires `service_not_rendered_confirmed === true` **and** a non-empty `reason`, both server-validated (refuse if absent/false) and both stored on the audit row (§3.9). |
| **P11** | What the refund ceiling is measured against | gross collected / **service portion** | **ADOPTED — owner policy: SERVICE portion (`paidAmountCents`), NOT gross.** | Tyler: *"All processing fees I want passed to the client."* The client never gets the card/processing fee back, so `maxRefundableCents` is computed against the **service** the studio kept, not gross (service + client fee). Two cases (§3.1): client-pays-fee → ceiling = service < gross; `studio_absorbs` → no separate client fee, so service == gross and the ceiling is unchanged. |

**P5 dispute-edge notes — the two geometries the local `dispute_status="open"` gate does not fully close (M5):**
- **(a) Just-opened-dispute lag race — Stripe is the backstop.** A dispute can open at Stripe in the window between our fresh `dispute_status` read and the `POST /v1/refunds`, so the local check can pass on a charge that is now under dispute. **Stripe is the authoritative backstop:** it rejects a refund on an actively-disputed charge, so the initiation lands `failed` (cleaned Stripe error surfaced, §3.7) — **no double-loss, no money moves.** The local check is the fast/clean path; Stripe is the hard guarantee.
- **(b) `dispute_status="lost" && !fundsReinstated` — block LOCALLY, don't just lean on Stripe.** When a dispute is `lost` and funds were **not** reinstated, the chargeback has already pulled the funds, yet `grossCollected − refunded` still shows a positive `maxRefundable` — **this is the true double-loss geometry** (refund on top of a chargeback that already took the money). Stripe will typically reject, but the cleaner shape is to **block locally**: reject when `dispute_status="lost" && !fundsReinstated` with a clear "funds already pulled by chargeback" message, rather than depending on Stripe's rejection. (A `won` or `reinstated` dispute leaves the funds with us and is refundable normally, subject to the amount cap.) Fold both `open` and `lost && !fundsReinstated` into the §3.4 eligibility gate.

---

## 3. Safety rails (airtight)

All rails are **server-side** and enforced in the initiation helper, not the client. The client UI mirrors them for UX only.

### 3.1 Amount validation + hard server-side ledger re-check at execution time — SERVICE-portion ceiling (P11)

**Ceiling is the SERVICE portion the studio kept, not gross (Rev 3 / P11 / Tyler: "all processing fees passed to the client").** The client does **not** get the processing/card fee back on a refund, so the ceiling is measured against `paidAmountCents` (the service the studio actually keeps), **never** `grossCollectedCents` (service + client card fee). This is grounded in the real settle path (`settleInvoicePaymentCheckoutSession`, stripe-checkout.ts:374–390): `paidAmountCents = serviceOpenCents`, `grossCollectedCents = amountTotalCents`, `clientFeeCents = max(amountTotalCents − serviceOpenCents, 0)`.

At **execution** (not draft, not client), re-read the payment row fresh and compute:

```
serviceCollectedCents      = payment.paidAmountCents               // SERVICE the studio kept (NOT gross)
webhookRefundedCents       = payment.refundedAmountCents           // 9a webhook set-to-authoritative
localInFlightRefundedCents = Σ refund_initiations.amountCents       // THIS payment's own
                              WHERE status IN ('submitting','succeeded')
alreadyRefundedServiceCents = max(webhookRefundedCents, localInFlightRefundedCents)
maxRefundableCents         = max(serviceCollectedCents - alreadyRefundedServiceCents, 0)
```

**Two fee-policy cases (both handled by the single formula above — `paidAmountCents` already encodes them):**
- **Client-pays-fee** (`invoices.card_fee_policy` adds a fee; `clientFeeCents > 0`): `paidAmountCents < grossCollectedCents`. The ceiling is the **service** amount; the client's card fee is excluded. Example: a $200 service collected as $205.90 gross (`clientFeeCents = 590`) has `maxRefundableCents = 20000`, not `20590` — the $5.90 fee is never refunded.
- **`studio_absorbs`** (no separate client fee added at checkout; `clientFeeCents = 0`): `paidAmountCents == grossCollectedCents`, so **service == gross** and the ceiling is numerically unchanged from the pre-Rev-3 gross rule. Nothing to exclude because the client was never charged a separate fee.

- **Reject** if `requestedAmountCents <= 0` or `requestedAmountCents > maxRefundableCents`. A refund can never exceed **service-collected-minus-already-refunded**. This is checked against the **fresh** ledger at execution — a refund that landed via webhook between draft and confirm shrinks `maxRefundableCents` and can invalidate a stale draft.
- **Why `max(webhook, localInFlight)`** (critical, do not omit): if the 9a webhook is lagging or (mis-)configured, `refundedAmountCents` may still be 0 right after a successful refund. Counting this payment's own non-failed `refund_initiations` rows means a second refund is capped correctly **even before the webhook lands**, closing the double-refund window that would otherwise exist during webhook lag. `payment_refunds`/`refunded_amount_cents` remain webhook-owned; this is a *read-side* union for the cap only, not a canonical write.
- **Basis consistency of the union (Rev 3 note, flagged for Tyler).** Both union terms are treated as a **cents-refunded-on-the-service-basis** quantity. `localInFlightRefundedCents` is exactly that by construction — 9b only ever sends service-portion amounts (it never refunds the fee). `webhookRefundedCents` (`refunded_amount_cents`, set from the charge's cumulative `amount_refunded`) also equals the service basis **as long as every refund on this charge went through 9b**. If a refund were issued **outside 9b** (e.g. a full-gross refund from the Stripe dashboard), `refunded_amount_cents` could exceed the service ceiling — which drives `maxRefundableCents` to 0 (clamped), the **safe** direction (it blocks, never over-permits). No unsafe divergence exists; the only effect is a possibly-too-conservative cap, which is correct for a money-out gate.

### 3.2 Stripe idempotency key (double-click / in-window retry cannot double-refund)
- Every `POST /v1/refunds` is sent with an **`Idempotency-Key`** header equal to the `refund_initiations.id` (a UUID minted once per initiating action; §4). Within Stripe's idempotency-key retention window, Stripe guarantees at-most-once execution per key — a network retry or a double-submit of the same initiation returns the *same* refund object, never a second refund.
- **The key is minted once per initiating action and persisted** (at "prepare"; §4.1) so any retry of that same initiation *within the window* reuses it. A *deliberate* new refund is a new "prepare" → new id → new key (correctly a distinct refund).
- **Correction (M3) — what the key actually guarantees.** The key is **not** "deterministic per (payment, amount)": the **amount is not part of the key**. The real guarantee is that Stripe **rejects a request that reuses a key with different parameters** (an `idempotency_error`, HTTP 400) — it does not silently re-run with the new amount, and it does not issue a second refund. This is why §4.1 **pins the amount onto the row at execute** and sends **exactly the row's persisted amount**: the key + the pinned amount together mean a retry is byte-identical (same key, same params → same refund object), while a params drift is a hard 400, never a second money movement.
- **⚠️ Hard constraint — the idempotency key EXPIRES (~24h) (M1).** Stripe retains idempotency keys for only ~24 hours. After the window lapses, a "retry" that reuses the same key is treated as a **brand-new request** and Stripe will **execute a FRESH refund** → double-pay. Therefore the key is a guard **only against near-term retries/double-clicks**, never against a stale in-flight row hours later. **No future increment may add an automatic retry of an in-flight (`submitting`) row** — recovery is reconcile-against-Stripe, never re-POST (§3.3, §4.4). Treat this ~24h expiry as a load-bearing safety constraint, not an implementation detail.

### 3.3 In-flight guard (local, belt-and-suspenders to Stripe's key)
On execute, load the `refund_initiations` row by id:
- `pending` → proceed. Persist the pinned `amountCents` and transition `pending` → `submitting` in the **same UPDATE**, **before** the Stripe call (§4.1).
- `succeeded` → **do not call Stripe again**; return the existing row's result (idempotent response). This is the local guard against a double-click racing the network.
- `submitting` → **do not call Stripe again, and do NOT blind-retry (M1).** A `submitting` row means the Stripe POST may already be in flight or already executed (money may already have moved). Return an "in progress / needs reconciliation" response; recovery is **reconcile against Stripe, never re-POST** (see below + §4.4). **This rule is absolute — a `submitting` row is NEVER auto-retried, no matter how old.**
- `failed` → terminal for that id; a user "try again" mints a **fresh** initiation (new id/key). Do not silently reuse a failed key from a new user action.

**Lifecycle ordering (no `db.transaction` — D1 rejects it; Active-Learning Log).** The row is **INSERTed as `pending` at prepare**, then **UPDATEd `pending` → `submitting` at execute, before the network call** (the amount is pinned in this same UPDATE, §4.1), then **UPDATEd to `succeeded`/`failed` after** the Stripe response. There is no "INSERT the submitting claim" step — `submitting` is only ever reached by UPDATE of an existing `pending` row.

**Crash between claim and response (the money-critical case, M1).** If the process dies after the `submitting` UPDATE but before the terminal UPDATE, the row is left `submitting` and **money may or may not have moved.** The recovery is **NOT** a re-POST — Stripe's idempotency key **expires after ~24h** (§3.2), so re-POSTing a stale `submitting` row would issue a **second, fresh refund** → double-pay. Instead:
1. §4.4's reconciliation/tripwire surfaces any `submitting` row older than **~1h**.
2. Recovery is **reconcile against Stripe**: query Stripe's refunds for the payment intent (or match `metadata[initiation_id]`, which §7 already sends) to learn whether a refund actually executed.
3. **Manually resolve the row** to `succeeded` (record the returned `re_…` id) or `failed` — **never by re-POSTing.** This is a deliberate, human-in-the-loop resolution, not an automatic retry.

### 3.4 Ownership + eligibility check before refunding
Before any Stripe call, confirm the target is a real payment we own:
- The `paymentId` resolves to an `invoice_payments` row **and** that row's `invoiceId` matches the route `id` (same defensive check as `createInvoicePaymentCheckoutSession`, stripe-checkout.ts:187).
- `payment.status === "paid"` (a settled Stripe collection; `waived`/`unpaid`/`pending` are ineligible — P7).
- `payment.externalPaymentId` is a non-empty `pi_…` (there is a Stripe charge to refund; cash/check payments are rejected).
- `payment.dispute_status !== "open"` **and NOT (`dispute_status === "lost" && !fundsReinstated`)** (P5 + M5 — reject the already-charged-back double-loss geometry locally; Stripe is the backstop for the just-opened-dispute lag race).
- **The payment is NOT the retainer (P9 / §3.8).** Reject with a clear reason if the target payment is identified as the initial retainer. This is a **hard block** — no amount, no confirmation, and no flag override refunds a retainer.
- **The "service not rendered" affirmation is present (P10 / §3.9).** Reject if `service_not_rendered_confirmed !== true` or if `reason` is empty. This is validated **server-side**, before any Stripe call, independent of the UI.
- `maxRefundableCents > 0` (§3.1, **service basis** — P11).

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

### 3.8 Retainer hard-block (P9 — Tyler: "No refunds on the initial retainer of services")
Before any Stripe call, the helper **refuses** if the target `invoice_payments` row is the initial retainer. Reject with a clear message (e.g. *"The initial retainer is non-refundable and cannot be refunded."*) and log `invoice.payment_refund_initiation_failed`. This is a **server-side hard block** — it is not gated by the amount cap, the typed confirmation, or the OFF flag; even a fully-authorized admin with the flag on cannot refund a retainer.

**Retainer-identification predicate (grounded in the real schema — read before writing).** `invoice_payments` has **no** `payment_type` / `kind` / deposit-flag / installment-sequence column (schema.ts:513–543). The only available signals are the free-text `label` and payment ordering (`dueDate`, then `createdAt`). The label signal alone is **weak** (an admin can name a payment anything), so Rev 3 uses a **union of the two most reliable signals** and blocks if **either** matches:

```
isRetainer(payment, allPaymentsOnInvoice) =
     isRetainerPaymentLabel(payment.label)          // reuse sales.ts:102 — /\b(retainer|deposit)\b/i
  OR payment.id === earliestPaymentOnInvoice(allPaymentsOnInvoice).id

// earliestPaymentOnInvoice: min by (dueDate NULLS LAST), tie-break min createdAt, tie-break id
// (a total, deterministic order so "earliest" is unambiguous even with equal/absent dueDates)
```

- **Reuse `isRetainerPaymentLabel`** (do not re-invent the regex) so the block stays consistent with the existing `retainer_paid` stage-advance semantics (`autoAdvanceProjectStageForRetainerPayment`, sales.ts:106–116) — the same rows that advance a project to `retainer_paid` are the rows that are non-refundable. Consistency here is the point: "the retainer" means the same thing in both places.
- **The earliest-payment arm is the safety net for the weak label signal.** If Tyler labels a retainer as "Booking payment", "Payment 1", etc., the label arm misses it but the earliest-payment arm still catches the first installment. This is the safest rule available given the schema; its residual weakness (a single-payment invoice — see below — and label ambiguity) is flagged for Tyler in Risk 6.
- **Single-payment invoices (flagged interpretation).** On a one-payment invoice the sole payment **is** the earliest, so it is treated as the retainer and blocked. This matches Tyler's intent (a paid-in-full-up-front booking is retainer-like and service may not be rendered), but it means a lump-sum payment cannot be refunded through 9b. **Flagged for Tyler's confirmation** (Risk 6): if he wants lump-sum invoices refundable, narrow the earliest-payment arm to invoices with ≥2 payments. Rev 3's default is the stricter (block) reading, because the policy is "no refunds on the retainer" and over-blocking is the safe direction for a money-out gate.

### 3.9 "Service not rendered" affirmation (P10 — Tyler: "refunds are only ever issued if service isn't rendered")
The app **cannot** verify whether service was actually rendered — there is no delivery/completion signal that is authoritative enough to gate money movement on. So this rule is encoded as a **policy gate the admin affirms**, captured in the audit trail, not as an automated check:
- The **execute** payload must carry `service_not_rendered_confirmed: boolean` **and** a non-empty `reason` (the existing required internal reason, P2). The helper **refuses (server-side, before any Stripe call)** if `service_not_rendered_confirmed !== true` or `reason` is blank — this is not a UI-only affordance; a direct call to `initiateInvoicePaymentRefund` without the affirmation throws.
- Both are **persisted on the `refund_initiations` audit row** (`service_not_rendered_confirmed`, `reason`) and included in the `invoice.payment_refund_initiated` activity metadata, so every refund carries a durable, attributable record that the admin affirmed service was not rendered and why.
- The UI presents the affirmation as an explicit checkbox/typed acknowledgement alongside the typed-amount confirm (P3); it is a distinct affirmation from the amount confirmation and both must pass.

---

## 4. Interleave with 9a recording (one source of truth, idempotent across both systems)

The core contract: **9b initiates, 9a records.** 9b never writes `payment_refunds` or `refunded_amount_cents`. Those come only from the inbound `refund.created` / `charge.refunded` webhooks that Stripe fires *because* 9b initiated.

### 4.1 The initiation lifecycle (new `refund_initiations` table — NOT `payment_refunds`)

```
1. PREPARE  (admin opens refund dialog)
   → RE-CHECK: reject here too if the payment is the retainer (§3.8) so the dialog never
     opens on a non-refundable payment (the hard block also re-runs at execute).
   → INSERT refund_initiations { id=uuid, invoicePaymentId, stripePaymentIntentId,
       amountCents=maxRefundableCents (SERVICE-basis PREFILL only, §3.1 — not the final amount),
       status='pending', initiatedBy }
   → id is BOTH our row id AND the Stripe Idempotency-Key.

2. EXECUTE  (admin types the confirm amount + affirms service-not-rendered, submits
            { initiationId, amountCents, confirmAmountCents, reason,
              service_not_rendered_confirmed, stripeReason? })
   → re-check ledger (§3.1, SERVICE ceiling), typed-amount confirm (confirmAmountCents == amountCents),
     eligibility (§3.4) incl. RETAINER hard-block (§3.8) + SERVICE-NOT-RENDERED affirmation (§3.9:
     refuse if service_not_rendered_confirmed !== true OR reason is blank)
   → UPDATE refund_initiations SET status='submitting', amount_cents=<final amountCents>,
       reason=<reason>, service_not_rendered_confirmed=1
       WHERE id=initiationId AND status='pending'   (PIN amount + claim, ONE UPDATE, BEFORE network — M3)
   → POST /v1/refunds  (Idempotency-Key: id, amount = the ROW's just-persisted amount_cents,
                        NOT the prepare prefill)     (money moves here)
   → UPDATE refund_initiations SET status='succeeded'|'failed',
       stripeRefundId=re_..., errorMessage=..., updatedAt
   → logActivity(initiated | initiation_failed)

3. RECORD  (Stripe → our webhook, seconds later; 9a code, unchanged)
   → refund.created / charge.refunded arrive at /api/stripe/webhook
   → 9a recordStripeRefund (refund.created/updated): writes the child payment_refunds
     row (dedupe on stripe_refund_id) + lastRefundAt. Does NOT set refunded_amount_cents.
   → 9a recordStripeChargeRefunded (charge.refunded): the LOAD-BEARING one (M6) — sets
     invoice_payments.refunded_amount_cents (set-to-authoritative, from the charge's
     cumulative amount_refunded) + (at enforce) flips status to "refunded".
```

**`charge.refunded` is the load-bearing subscription (M6).** Verified against 9a: **only** `recordStripeChargeRefunded` sets `refunded_amount_cents` and drives the status flip; `recordStripeRefund` (`refund.created/updated`) writes only the child rows + `lastRefundAt`. So if `charge.refunded` specifically is not subscribed at Stripe, the summary column and the status flip never happen **even if `refund.*` is subscribed** — the canonical cap-input column and the terminal status silently lag. §11/§12 name `charge.refunded` explicitly as a hard precondition, not just "the refund webhooks."

`refund_initiations` is an **audit + idempotency** table. `payment_refunds` is the **canonical ledger**, webhook-owned. They are joined for display on `stripe_refund_id` but 9b never writes the canonical table.

**Amount pinning (M3).** The `pending` prefill is a UI default only; the **authoritative amount is the value persisted in the `submitting` UPDATE at execute**, and the Stripe POST sends **exactly that persisted value**. This closes two divergences: (a) the §3.1 Σ-cap sums `refund_initiations.amountCents` — if the row still held the stale full-prefill while a smaller amount was actually sent, the cap would over-count and wrongly block later refunds; (b) the audit row would otherwise diverge from what was actually sent to Stripe. Persist-then-send-the-persisted-value keeps row, cap, and Stripe request identical. (The amount is **not** in the idempotency key (§3.2), so a same-key request with a different amount is a hard `idempotency_error`, never a silent second refund.)

### 4.2 No double-count
- Because 9b does **not** write `payment_refunds`, there is exactly one canonical row per Stripe refund — the one 9a inserts `ON CONFLICT DO NOTHING` keyed on `stripe_refund_id`.
- If Stripe redelivers `refund.created`, 9a's per-object convergence (9a §1.2) keeps it a single row. 9b's involvement ends at the Stripe response.
- The `stripeRefundId` 9b stores on the initiation row is a **read-only cross-reference** (lets the UI show pending→succeeded before the webhook lands); it is never treated as the canonical ledger.

### 4.3 UI reflects pending → succeeded
The invoice/payment view shows refund state by joining the two:
- **`refund_initiations.status`** = what *we* did (`pending` → `submitting` → `succeeded`/`failed`) — visible immediately.
- **`payment_refunds`** row + **`refunded_amount_cents`** = webhook-confirmed canonical state — visible when the webhook lands (usually seconds).
- Display rule: `succeeded` initiation with a matching `payment_refunds` row → "Refunded" (confirmed). `succeeded` initiation with **no** matching webhook row yet → "Refund submitted (awaiting confirmation)". `failed` → show the cleaned Stripe error.

### 4.4 Reconciliation — two tripwires (webhook-never-arrived AND stuck in-flight)
Both surface in the existing **needs_reconciliation** finance view (extend `paymentLedgerNeedsReconciliation` / the agent-finance `reconciliation` block, 9a §2.1).

**(1) Webhook-never-arrived** — a `refund_initiations` row `status='succeeded'` older than a threshold (e.g. 24h) with **no** `payment_refunds` row sharing its `stripe_refund_id` means the recording webhook never arrived (webhook mis-subscribed — esp. `charge.refunded` per M6 — or dropped). Surface as an **"Initiated refund not yet recorded"** item. This is the tripwire for the "9a webhook not subscribed" failure mode (§11 precondition).

**(2) Stuck `submitting` (M1 — money-critical).** A `refund_initiations` row still `status='submitting'` older than **~1h** means the execute path crashed between the claim and the terminal UPDATE (§3.3). **Money may or may not have moved**, and the §3.1 Σ-cap counts this row (`status IN ('submitting','succeeded')`), so it **pins that payment's `maxRefundable` at 0 until resolved** — a refundability wedge, not just a display gap. The old `status='succeeded'`-only query never surfaced this row. Surface it as a **"Refund stuck in-flight — reconcile against Stripe"** item. **Resolution is human-in-the-loop reconcile-against-Stripe, NOT a re-POST** (the ~24h key expiry makes a re-POST a fresh double-refund; §3.2, §3.3): query Stripe's refunds for the payment intent or match `metadata[initiation_id]` (§7), then manually set the row to `succeeded` (with the `re_…` id) or `failed`. The ~1h threshold (vs 24h for tripwire 1) is deliberately tight because a stuck `submitting` row both risks an unrecorded money movement and actively blocks further refunds on that payment.

### 4.5 D1 no-transaction discipline (Active-Learning Log)
Same as 9a: **no `db.transaction` / `db.batch`** for this flow (D1 rejects them at runtime; passes in dev better-sqlite3, 500s in prod). Each step is an independent convergent write; the `pending` → `submitting` claim (with the pinned amount) is written before the network call and the `succeeded`/`failed` update after.

**A crash mid-flow leaves a `submitting` row that is recovered by reconcile-against-Stripe, NEVER by a blind retry (M1).** Do **not** rely on "Stripe's idempotency key makes the retry safe" — that is false past the ~24h key-retention window (§3.2): a re-POST of a stale `submitting` row is a **fresh** refund → double-pay. Recovery is the §3.3 / §4.4(2) procedure: the ~1h tripwire surfaces the row, an operator reconciles against Stripe (query the PI's refunds / match `metadata[initiation_id]`), and manually resolves the row to `succeeded`/`failed`. The idempotency key protects only near-term retries/double-clicks, not hours-later recovery.

---

## 5. Auth model (admin-only; never agent-reachable)

### 5.1 Routes (all under `/api/invoices/*`, never `/api/agent/*`)
Two-phase to support the typed-confirmation + persisted idempotency key:

| Method + path | Purpose | Guard |
| --- | --- | --- |
| `POST /api/invoices/[id]/payments/[paymentId]/refund/prepare` | Mint a `refund_initiations` row (`pending`), return `{ initiationId, maxRefundableCents, currency }`. | `guardDirectWorkerApiRequest` + admin-proof/proxy admin session + flag check |
| `POST /api/invoices/[id]/payments/[paymentId]/refund/execute` | Body `{ initiationId, amountCents, confirmAmountCents, reason (required), service_not_rendered_confirmed (required, must be true — §3.9), stripeReason? }`. Validate (incl. retainer hard-block §3.8 + service-not-rendered affirmation §3.9), re-check ledger (SERVICE ceiling §3.1), call Stripe, update row. | same |

Both mirror the existing admin mutation shape (checkout route, invoices/[id]/status route): `const blocked = guardDirectWorkerApiRequest(request); if (blocked) return blocked;` first line, then the flag gate, then the helper, then a 303/JSON response. No new auth primitive — reuse the exact origin-guard + Pages-proxy admin wall every other admin mutation uses (this is the same trust boundary as `/api/invoices/[id]/payments/[paymentId]/checkout`).

### 5.2 Library boundary
- New module `src/lib/stripe-refund-initiation.ts` exporting `initiateInvoicePaymentRefund({ invoiceId, paymentId, initiationId, amountCents, confirmAmountCents, reason, serviceNotRenderedConfirmed, stripeReason, actorType, actorName })`. The helper **throws server-side** (before any Stripe call) if `serviceNotRenderedConfirmed !== true` or `reason` is blank (§3.9), or if the target payment is the retainer (§3.8) — these are enforced in the library boundary, not only the route.
- It takes `actorType` and **throws immediately** if `actorType !== "admin"` (defense-in-depth: even if some future code path tried to call it as `"agent"`/`"system"`, it refuses — this is stricter than the draft-only guard because there is *no approval that unlocks it*).
- It **also calls `refundInitiationEnabled()` itself and throws before any Stripe call if the flag is off** (M4, §8) — the flag gate is not left solely to the routes, so a future caller that bypassed the route still cannot move money while the flag is off.
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
  reason                   TEXT,                         -- internal reason (audit; capped 500); REQUIRED at execute (§3.9)
  service_not_rendered_confirmed INTEGER NOT NULL DEFAULT 0, -- P10/§3.9: admin affirmed service was NOT rendered (1) before the money-moving call
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

// params: payment_intent=pi_...  amount=<the ROW's persisted amount_cents, M3>  reason=<stripeReason?>
//         metadata[invoice_payment_id]=...  metadata[initiation_id]=<initiationId>
//   metadata[initiation_id] is load-bearing for recovery: it lets an operator match a
//   Stripe refund back to a stuck `submitting` row during reconcile-against-Stripe (§3.3, §4.4).
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
- Use `payment_intent` (we store `pi_…` in `external_payment_id`); Stripe refunds against that PI's charge. Send an explicit `amount` equal to the **row's persisted `amount_cents`** (pinned in the `submitting` UPDATE, §4.1/M3) — never the prepare-time prefill, and never rely on "omit = full" (determinism + row/cap/request parity).
- **Stripe refunds against the CHARGE (gross); we deliberately refund only the SERVICE portion (P11).** Stripe's own refundable ceiling on a charge is the **gross** amount collected (service + client card fee), because that is what the customer was actually charged. Our `amountCents` is capped at the **service** portion (`paidAmountCents`, §3.1), which is **always ≤ gross**, so the amount we send is **always valid at Stripe** — we are choosing to never refund the fee portion, not being forced to. Framed as `refund = min(requestedServiceAmount, whatStripeAllows)`: because `requestedServiceAmount ≤ serviceCollected ≤ grossCollected = Stripe's ceiling`, the `min` is always the service amount. No Stripe-side rejection arises from the fee exclusion. (Stripe also keeps its own processing fee on any refund — existing Risk 5 — so refunding only the service portion is what keeps the studio whole on service while the client bears their card fee.)
- **The `Idempotency-Key` guards only near-term retries (~24h window; §3.2).** It is not a substitute for the in-flight guard (§3.3): a `submitting` row is never re-POSTed, so the key is never the thing standing between a stuck row and a double-refund. The amount is **not** in the key, so a same-key request with a changed amount returns Stripe `idempotency_error` (HTTP 400), never a second refund.
- Stripe may return `status: "pending"` (async settlement) with a 200 — that is a **success** (the refund is accepted); the 9a webhook will finalize it. Store `succeeded` on our initiation row when the HTTP call is 2xx; the *Stripe* refund status lives in `payment_refunds` via the webhook.
- Do not build a second Stripe secret accessor if a shared one is extracted; if `stripeSecretKey()` is promoted to a shared `src/lib/stripe-client.ts`, reuse it (keep the checkout path behavior identical).

---

## 8. Off-by-default flag + dark rollout

- **`REFUND_INITIATION_ENABLED`** (default **OFF**). A hard money gate — a single boolean, read **in the body** (never as a default param — TS2559, Active-Learning Log) via `refundInitiationEnabled()` in `src/lib/finance-flags.ts`. **Parse strict `=== "1"`** (M4), exactly matching `adminProofEnforced` (`admin-proxy-auth.test.ts:194–197`): unset, empty, `"0"`, `"true"`, `"on"`, any typo → **OFF**; only the literal `"1"` enables. No fuzzy truthiness on a money gate.
- **Defense-in-depth: the flag is checked INSIDE the helper, not only in the routes (M4).** `initiateInvoicePaymentRefund` calls `refundInitiationEnabled()` itself and **throws before any Stripe call** if it is off — the same belt-and-suspenders posture as the `actorType !== "admin"` throw (§5.2). So even a future code path that reached the helper without passing through the route flag gate cannot move money while the flag is off. Both routes ALSO short-circuit with a 403 `{ error: "Refund initiation is disabled." }` **before** any Stripe call, and the admin UI hides/disables the refund control. Even a fully authenticated admin cannot move money while the flag is off.
- **Two Tyler actions gate real money:** (1) flip `REFUND_INITIATION_ENABLED` on; (2) issue the first real refund. Neither is autonomous (guardrails 2 + 3).
- **Dependency on 9a flags Tyler must set together** (§11): the recording webhook must be **subscribed at Stripe** and `FINANCE_REFUND_RECORDING` should be at `enforce` before the first real refund, or money moves without being recorded / reflected in status.
- **Migration 0091 applied before the Worker deploy** (discipline), via the idempotent direct `d1 execute --file` pattern (`CREATE TABLE IF NOT EXISTS`), verified, then Worker + Pages-proxy deploy. No `migrations apply --remote` (tracker out of sync — Active-Learning Log).
- **Deploy is reversible** (guardrail 4): real D1 backup → capture Worker rollback version → deploy dark (`REFUND_INITIATION_ENABLED` unset) → health-check → rollback-ready. **Instant kill-switch:** `wrangler secret delete REFUND_INITIATION_ENABLED` (or set `0`) → no refund can be initiated; nothing else changes.

---

## 9. Test plan (tsx; build-exit-code gate)

All tests spy on `fetch` and assert `api.stripe.com/v1/refunds` call counts.

1. **Happy path (mocked Stripe)** — prepare → execute a full refund on a **non-retainer** payment with `service_not_rendered_confirmed = true` and a non-empty `reason` → exactly **one** `POST /v1/refunds` with `Idempotency-Key = initiationId` and `amount = maxRefundableCents` (SERVICE basis, §3.1); `refund_initiations` row `succeeded` with `stripe_refund_id`, `service_not_rendered_confirmed = 1`, and the `reason` persisted; activity `invoice.payment_refund_initiated` logged (metadata includes `reason` + `service_not_rendered_confirmed`).
2. **Partial refund** — `amountCents < maxRefundableCents` accepted; over-cap partial rejected (see #3).
3. **Amount over-cap rejected (SERVICE basis — P11)** — `requestedAmountCents > paidAmountCents - alreadyRefundedServiceCents` → rejected, **zero** Stripe calls, `initiation_failed` logged. Explicitly assert a request for the **gross** amount on a client-pays-fee payment (service + fee) is **rejected** — the ceiling is the service portion, not gross.
4. **Ledger re-check uses `max(webhook, local in-flight)`** — with `refundedAmountCents = 0` but a prior `succeeded`/`submitting` `refund_initiations` row summing to the full **service** amount, a second refund is capped/rejected → **zero** Stripe calls (proves the webhook-lag double-refund window is closed).
5. **Disputed payment rejected** — `dispute_status = "open"` → rejected, zero Stripe calls (P5). Also assert `dispute_status = "lost" && !fundsReinstated` → rejected locally, zero Stripe calls (P5 note (b) / M5); and that a `won`/`reinstated` dispute is refundable (subject to the cap).
6. **In-flight guard prevents double-refund** — two `execute` calls with the same `initiationId`: the first calls Stripe once; the second hits the in-flight guard and makes **zero** additional Stripe calls. Assert both sub-cases: a `succeeded` row returns the existing result; a `submitting` row returns an "in progress / needs reconciliation" response and is **never re-POSTed** regardless of age (M1) — no reliance on the Stripe key past its ~24h window.
7. **Typed-confirmation mismatch rejected** — `confirmAmountCents !== amountCents` → rejected, zero Stripe calls.
8. **Eligibility** — non-`paid` status, null `external_payment_id`, or `paymentId`/`invoiceId` mismatch each → rejected, zero Stripe calls.
9. **Agent/MCP CANNOT initiate** — (a) MCP `tools/list` has no refund-initiation tool; (b) no `/api/agent/*` route imports the initiation module; (c) `initiateInvoicePaymentRefund({ actorType: "agent" })` throws and makes **zero** Stripe calls + writes zero `refund_initiations` rows (extends `agent-finance-guard.test.ts`).
10. **Admin-only auth** — direct-Worker origin (no origin secret) → `guardDirectWorkerApiRequest` 404, zero Stripe calls; refund routes are **not** in `isPublicOriginBypassApiPath` (extends `origin-guard.test.ts` classifier/drift assertion).
11. **Fail-closed secret** — `STRIPE_SECRET_KEY` unset → execute throws before any network call; secret never appears in logs/errors.
12. **No direct `payment_refunds` write** — after a successful initiation, `payment_refunds` and `refunded_amount_cents` are **unchanged** (recording still comes only from the webhook); then simulate the `refund.created`/`charge.refunded` webhook (9a path) and assert exactly one `payment_refunds` row appears (no duplicate from 9b).
13. **Flag-off blocks initiation, incl. strict parse + in-helper check (M4)** — assert `refundInitiationEnabled` treats `undefined`, `""`, `"0"`, `"true"`, `"on"` as OFF and only `"1"` as ON (mirror `admin-proxy-auth.test.ts:194–197`). With the flag off: both routes 403, zero Stripe calls, no `refund_initiations` row; **and** a direct call to `initiateInvoicePaymentRefund` with the flag off **throws before any Stripe call** (defense-in-depth, flag checked inside the helper).
14. **Reconciliation tripwires (both, §4.4)** — (a) a `succeeded` initiation with no matching `payment_refunds` row surfaces as "initiated refund not yet recorded"; (b) a `submitting` row older than ~1h surfaces as "refund stuck in-flight — reconcile against Stripe" (M1), and the Σ-cap pins that payment's `maxRefundable` at 0 while it is stuck.
15. **Amount pinned + same-key-different-amount is one refund (M3)** — execute pins the row's `amount_cents` in the `submitting` UPDATE and sends **exactly** that to Stripe (assert the POST `amount` equals the persisted row value, not the prepare prefill). Then two executes with the **same `initiationId` but different amounts** → **exactly one** `POST /v1/refunds` (the second is blocked by the in-flight guard before any Stripe call; if it reached Stripe it would be an `idempotency_error`, never a second refund).
16. **Retainer refused (P9 / §3.8)** — a payment identified as the retainer is **rejected**, **zero** Stripe calls, `initiation_failed` logged. Assert **both** predicate arms independently: (a) a payment whose `label` matches `isRetainerPaymentLabel` (e.g. "Retainer", "Deposit") is refused even if it is not the earliest; (b) the **earliest** payment on an invoice (min dueDate, tie-break createdAt) is refused even when its label does **not** match (e.g. "Payment 1"). Also assert a clearly-non-retainer, non-earliest payment (e.g. a labeled "Final balance" that is not first) is **allowed** (subject to the cap). Assert prepare **and** execute both block (§4.1).
17. **Missing service-not-rendered affirmation refused (P10 / §3.9)** — execute with `service_not_rendered_confirmed` absent or `false` → **rejected**, zero Stripe calls, `initiation_failed`; and execute with a blank/whitespace `reason` → rejected, zero Stripe calls. Assert a **direct** call to `initiateInvoicePaymentRefund` without the affirmation **throws before any network call** (server-side, not UI-only). Assert the happy path (both present + true) stores `service_not_rendered_confirmed=1` and the `reason` on the `refund_initiations` row and in the activity metadata.
18. **Service-portion ceiling excludes the client card fee (P11, client-pays)** — a payment with `paidAmountCents = 20000`, `grossCollectedCents = 20590`, `clientFeeCents = 590`: the max refundable is **20000**, not 20590. A request for `20000` succeeds; a request for `20001`…`20590` is **rejected** (zero Stripe calls); the successful `POST /v1/refunds` sends `amount = 20000` (service), never gross.
19. **`studio_absorbs` ceiling equals gross == service (P11)** — a payment with `card_fee_policy = 'studio_absorbs'`, `clientFeeCents = 0`, `paidAmountCents == grossCollectedCents = 20000`: max refundable is **20000** and a full refund sends `amount = 20000`. Confirms the single service-basis formula (§3.1) leaves the no-separate-fee case numerically unchanged.
20. **Auth-armed smoke (M2)** — extend `scripts/production-smoke.mjs`: an unauthenticated `POST …/refund/execute` on the `*.workers.dev` origin (no origin secret, no admin proof) returns **404**. This is the pre-enable assertion that `ORIGIN_PROXY_SECRET` is set at the Worker and `ADMIN_PROOF_ENFORCE=1` (both fail-open when unset).
21. **Build gate** — `npm run build` **exit code 0** (type-check passes), `npm test` green, `npm run lint`; canon/drift updated for `refund_initiations`.

---

## 10. Ordered task breakdown (effort / risk)

| # | Task | Effort | Risk |
| --- | --- | --- | --- |
| 1 | Migration `0091` `refund_initiations`; mirror in `schema.ts`, `studio-canon.test.ts`, `client.ts` `migrate()`. | S | Low (additive, not always-on) |
| 2 | `refundInitiationEnabled()` in `finance-flags.ts` (single OFF boolean, read in body). | S | Low |
| 3 | `src/lib/stripe-refund-initiation.ts`: `initiateInvoicePaymentRefund` — eligibility + **SERVICE-basis** ledger re-check (§3.1, `max(webhook,local)` on `paidAmountCents`), **retainer hard-block (§3.8, reuse `isRetainerPaymentLabel`)**, **service-not-rendered affirmation + required reason (§3.9)**, `refund_initiations` lifecycle, Stripe call with Idempotency-Key, fail-closed secret, no-log, activity logs, `actorType!=="admin"` throw. | **L** | **High (moves real money — correctness of cap/idempotency/eligibility/retainer-block is load-bearing)** |
| 4 | Two admin routes `refund/prepare` + `refund/execute` (`guardDirectWorkerApiRequest` + flag gate + admin-proof), typed-confirmation + service-not-rendered affirmation validation. | M | Med (most sensitive admin mutation) |
| 5 | Admin UI: refund control on the invoice/payment view (SERVICE-basis prefill + partial + required reason + typed-amount confirm + **service-not-rendered affirmation checkbox**; retainer rows show the control **disabled** with "retainer is non-refundable"), pending→succeeded display joining `refund_initiations` + `payment_refunds`. | M | Med |
| 6 | Reconciliation surfacing: "initiated refund not yet recorded" tripwire in the needs_reconciliation view (extend 9a §2.1). | S | Low |
| 7 | Guard tests (no agent/MCP surface, `actorType` throw, origin-guard, flag-off) + full test plan §9 + build-exit-code gate. | M | Med (the safety net) |
| 8 | Deploy **dark**: backup → apply 0091 → verify → deploy Worker + proxy → health-check → rollback-ready; `REFUND_INITIATION_ENABLED` unset. **Hold for Tyler's go before this step runs.** | S | **Gated — money-movement pause** |

Effort: S ≈ ≤0.5d, M ≈ 0.5–1d, L ≈ 1–2d.

---

## 11. Active-Learning-Log pitfalls pre-empted (mapping)

| Log pitfall | How 9b pre-empts it |
| --- | --- |
| **D1 has no usable transaction** | No `db.transaction`/`db.batch`. `pending`→`submitting` claim (with the pinned amount) written before the network call, `succeeded`/`failed` after. A crash leaves a `submitting` row that is recovered by **reconcile-against-Stripe, never a blind re-POST** — the Stripe key expires ~24h so a re-POST would double-pay (§3.2, §3.3, §4.4(2), §4.5). |
| **Off-by-default flag** | `REFUND_INITIATION_ENABLED` default OFF; both routes 403 before any Stripe call (§8). Money gate is a hard boolean, flipped only by Tyler. |
| **Attacker-chosen ids / untrusted input** | Every field validated + capped (reuse 9a's `capId`/`capReason`/`clampAmountCents`); amount re-checked server-side against the fresh ledger; typed-amount confirm; ownership check (§3). |
| **Agent authority** | Money-movement is **absent** from the agent surface (stricter than the approval guard); `actorType!=="admin"` throw + guard test asserting zero Stripe calls (§5). |
| **Owner refund policy enforced server-side, not in the UI (Rev 3)** | All three of Tyler's rules are **library-boundary** gates, not UI affordances: retainer hard-block (§3.8), required service-not-rendered affirmation + reason (§3.9), and the SERVICE-portion ceiling (§3.1). A direct call to `initiateInvoicePaymentRefund` that skips the UI still cannot refund a retainer, refund without the affirmation, or exceed the service ceiling. Retainer identity reuses the existing `isRetainerPaymentLabel` (sales.ts:102) unioned with earliest-payment so it can't be defeated by a relabel. |
| **Secrets fail closed** | `stripeSecretKey()` throws when unset; no dev fallback in prod; key never logged (§3.5). |
| **Never silent-drop / no double-count** | 9b never writes `payment_refunds`; recording comes only from the 9a webhook — specifically **`charge.refunded`** sets `refunded_amount_cents` (the load-bearing subscription, M6); `stripeRefundId` cross-ref is read-only; both reconciliation tripwires (missing webhook + stuck `submitting`) catch failures (§4.4). |
| **Origin-guard bypass discipline** | Refund routes use `guardDirectWorkerApiRequest` and are **never** added to `PUBLIC_API_PREFIXES`/`isPublicOriginBypassApiPath`; drift test asserts this (§3.6, §9.10). |
| **Fail-open guards must be ARMED before a money route ships (M2)** | Both `guardDirectWorkerApiRequest` (no-op when `ORIGIN_PROXY_SECRET` unset, `origin-guard.ts:61`) and admin-proof (enforces only when `ADMIN_PROOF_ENFORCE="1"`) fail OPEN when unset. §12 PRECONDITION AUTH-ARMED + the §9.20 smoke assert both are set **before** `REFUND_INITIATION_ENABLED` flips on, so the route is never unauthenticated-reachable on `*.workers.dev`. |
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

**Named, hard-blocking preconditions Tyler must confirm are true before flipping `REFUND_INITIATION_ENABLED` on** (each should be a **smoke assertion in `scripts/production-smoke.mjs`**, not a memory item — the flag flip is blocked until they pass):

- **PRECONDITION AUTH-ARMED (M2 — new, hard-blocking).** Confirm the auth boundary the refund route relies on is actually **ARMED at the Worker before the flag flips**. Both guards **fail OPEN when their env is unset**, and if both are unset in prod with the refund flag on, `POST …/refund/execute` on the `*.workers.dev` origin is reachable **UNAUTHENTICATED** → an attacker can drain up to the **service ceiling** (§3.1) per payment (the retainer and non-retainer non-earliest payments still subject to §3.8; the server-side cap and gates run even without auth, but an unauthenticated refund is still catastrophic). Verify **both**:
  - `ORIGIN_PROXY_SECRET` is **set at the Worker** — else `guardDirectWorkerApiRequest` is a **no-op** (`origin-guard.ts:61`: `if (!configuredSecret) return false;` → never blocks a direct-Worker request).
  - `ADMIN_PROOF_ENFORCE = "1"` — else admin-proof does **not** enforce (`adminProofEnforced` is true only for exactly `"1"`; unset = fail-open, pinned by `admin-proxy-auth.test.ts:197`).
  - Make this a **smoke assertion**: an unauthenticated `POST …/refund/execute` to the `*.workers.dev` origin (no origin secret, no admin proof) must return **404**, asserted BEFORE `REFUND_INITIATION_ENABLED` is turned on. This precondition sits alongside PRECONDITION WEBHOOK below as a first-class gate, not an afterthought.
- **PRECONDITION WEBHOOK — `charge.refunded` subscribed at Stripe (M6).** The 9a recording webhook must be subscribed for **`charge.refunded` specifically** (plus `refund.*`) — 9a enable-runbook item 1. `charge.refunded` is **load-bearing**: only `recordStripeChargeRefunded` sets `refunded_amount_cents` (from the charge's cumulative `amount_refunded`) and drives the status flip; `recordStripeRefund` (`refund.created/updated`) writes child rows + `lastRefundAt` **only**. So without `charge.refunded` specifically, the summary column and status flip never happen **even if `refund.*` is subscribed** — a 9b refund moves money but the canonical cap-input column lags. The reconciliation tripwire (§4.4(1)) will fire and the `max(webhook, local in-flight)` cap (§3.1) still prevents a double-refund in that window, but the books stay wrong until the subscription is fixed. Verify the exact event `charge.refunded` is present in the Stripe webhook endpoint's event list, not just "refund events."
- **PRECONDITION ENFORCE — `FINANCE_REFUND_RECORDING = enforce`** (9a enable-runbook item 2), so a full refund actually flips the payment to the terminal `refunded` status and recomputes the invoice. At `record_only`, a full refund still moves money and records the child row + net figures, but the payment stays `paid` in status (temporarily wrong books — see Risk 2 below). Recommended: enforce is on before the first real refund.
- **PRECONDITION TEST-TARGET** — a **known-safe test target** (e.g. refund a small, recent Stripe test/real charge Tyler controls) for the very first refund, watched end-to-end: initiation `succeeded` → `charge.refunded` webhook lands → `payment_refunds` row + `refunded_amount_cents` update → (at enforce) status flip.

**Instant rollback at any point:** `wrangler secret delete REFUND_INITIATION_ENABLED` (or set `0`) → no further refund can be initiated; already-issued refunds are unaffected (they are real money movements at Stripe, recorded by 9a). Worker rollback to the captured pre-9b version removes the initiation code entirely.

### 12.1 Risks Tyler should weigh before go (residual, honest)

These are the residual risks that remain **even with every safety rail in this spec built and every precondition above met.** None is a blocker; each is a thing Tyler is accepting by saying "go." Read them as the true cost of turning money-movement on.

1. **Money-out auth is ONE shared boundary, with no per-action credential.** The refund route is protected by the same Pages-proxy admin wall + origin-proxy secret + admin-proof that guards every other admin mutation — there is **no separate, refund-specific credential**. Whoever holds admin access to the app can move money once the flag is on. The typed-amount confirm and the OFF flag are the only refund-specific friction. (This is also why PRECONDITION AUTH-ARMED above is hard-blocking: if that shared boundary is misconfigured fail-open, the most destructive action in the app inherits the hole.)
2. **At `record_only`, a full refund moves real money but the payment still reads `paid`.** Recording writes the child row + net figures, but the status flip is gated to `enforce`. Until `FINANCE_REFUND_RECORDING = enforce`, the books are **temporarily wrong** (money left, status says paid). Flip to `enforce` first (PRECONDITION ENFORCE) or knowingly accept temporarily-wrong status until you do.
3. **A crashed `execute` can wedge a payment's refundability until manual reconciliation.** If the process dies between the `submitting` claim and the terminal update, that payment's `maxRefundable` is pinned at 0 (the Σ-cap counts the `submitting` row) and no further refund can be initiated on it **until a human reconciles against Stripe** (§3.3, §4.4(2)). This is a deliberate fail-safe (better to block than to risk a double-refund), but it is manual, human-in-the-loop recovery — there is no auto-retry (by design: the ~24h key expiry makes auto-retry a double-pay risk).
4. **Refunds are IRREVERSIBLE at Stripe. The kill-switch only stops FUTURE refunds.** `wrangler secret delete REFUND_INITIATION_ENABLED` and the Worker rollback both prevent *new* refunds — neither can claw back a refund already sent. Once `POST /v1/refunds` returns 2xx, the money is gone; the only "undo" is a fresh charge to the client, which is a separate, out-of-scope action. Every real refund is final.
5. **Stripe does NOT return its processing fee on a refund — every refund costs the fee.** When you refund a charge, Stripe keeps the original processing fee (it is not returned to the balance). So a full refund of a $200 charge returns $200 to the client but leaves the business out the original Stripe fee — every refund has a real, non-recoverable cost. The app surfaces the refunded amount, not this sunk fee; Tyler should factor it into partial-vs-full and "should we refund at all" decisions. **(Rev 3 note:** the service-portion ceiling (P11) means the client already bears their card fee — the studio never *adds* the fee to a refund — so the studio's only unrecovered cost on a refunded charge is Stripe's own kept fee, minimized by refunding the service portion only.)
6. **The retainer block leans on a WEAK schema signal — confirm the predicate matches how you label retainers (Rev 3 / P9).** `invoice_payments` has **no** retainer/deposit/type column; the block identifies the retainer by **label match** (`/\b(retainer\|deposit)\b/i`) **OR earliest payment on the invoice** (§3.8). This is the safest available rule, but two edges are Tyler's to confirm: (a) a retainer labeled with none of those words *and* not the earliest payment would slip the label arm (the earliest arm is the backstop — so name the retainer first, or use "retainer"/"deposit"); (b) on a **single-payment invoice** the sole payment is treated as the retainer and is therefore **non-refundable through 9b** (§3.8) — if Tyler wants lump-sum invoices refundable, the earliest-payment arm must be narrowed to ≥2-payment invoices. Rev 3 defaults to the stricter (over-block) reading; **confirm at the gate.**
7. **The "pass fees to the client" ceiling is an INTERPRETATION — confirm it means "refund service only" (Rev 3 / P11).** Tyler said *"all processing fees I want passed to the client."* Rev 3 encodes this as: the refundable ceiling is the **service portion** (`paidAmountCents`), so a refund never returns the card/processing fee the client paid, and (combined with Risk 5) the studio stays whole on service. The alternative reading — refund gross and separately absorb/recover the fee — is **not** what Rev 3 builds. If Tyler actually wants the client made whole on gross (fee included), the ceiling reverts to `grossCollectedCents` and P11/§3.1 must change. **Confirm the service-portion ceiling at the gate before the first real refund.**
