# Deploy record — Phase 9b refund initiation (DARK) — 2026-07-06

**Phase 9b MOVES real money** (Stripe `POST /v1/refunds`) when enabled. It is deployed **DARK**:
`REFUND_INITIATION_ENABLED` is unset ⇒ off ⇒ the helper throws at the library boundary before any
Stripe reachability. Routes are admin-only + origin-guarded (execute 404s on `*.workers.dev`).
**No money can move until Tyler completes the enable checklist below and flips the flag.**

## Gates
- Spec Fable-gated **×4**: rev 1 (full), rev 2 (auth-armed + idempotency/24h-key), rev 3 (owner
  policy: retainer non-refundable, service-not-rendered affirmation, service-portion ceiling),
  rev 4 (dedupe-union over-refund fix). Plus a final tight confirmation of the dedupe-union.
- Code Fable-gated **×2**: first pass caught a **BLOCKER** (concurrent double-execute both POSTing
  via a status-only CAS winner check) → fixed with a per-execute **claim-token** CAS (only the
  writer whose token survives the re-read may POST/finalize) + token-guarded terminal UPDATEs +
  post-claim overshoot recheck; second pass APPROVED the fix.
- Local verify (independently re-run): lint 0, `build` exit 0, test 204/204 (incl. §9.23
  concurrent-race regression test: held fetch → exactly one POST).

## Deploy sequence (all green)
1. Real D1 backup `studio-bythereeses-2026-07-06T06-30-51Z.sql`.
2. Migration `0091_refund_initiation.sql` applied to prod (additive `CREATE TABLE IF NOT EXISTS
   refund_initiations` + `claim_token` + 3 indexes). Verified: table present, `claim_token` +
   money-critical columns present, 0 rows.
3. `opennextjs-cloudflare build` → exit 0. Rollback point captured: Worker **`3fa37e5a`**.
4. `opennextjs-cloudflare deploy` → new Worker **`c52f2dc6`**. Pages-proxy unchanged (refund routes
   are admin-gated `/api/invoices/*`, same surface).
5. Health-check: execute route → 404 on `*.workers.dev` origin (unreachable unauth), 303→login on
   proxy; prepare route same; invoice/finance pages 303 (no 500); 9a Stripe webhook still 400 bad-sig;
   public booking healthy.

## Money-math + safety (as shipped)
- Ceiling = **service portion** (`paidAmountCents`), never gross → the client's card fee is never
  refunded (owner policy P11).
- Over-refund cap = `max(webhookRefunded, Σlocal(submitting,succeeded) + Σexternal)` — dedupe-union
  closes the mixed external-refund + 9b webhook-lag gap; NULL-safe.
- Retainer payment **hard-blocked** (exported `isRetainerPaymentLabel` ∪ earliest-payment).
- `service_not_rendered_confirmed` + reason **required**, server-enforced.
- Dispute block: open OR lost-not-reinstated.
- Idempotency: Stripe Idempotency-Key = row id; claim-token CAS; `submitting` never blind-retried
  (24h key expiry) → reconcile-against-Stripe.
- Admin-only, **no agent/MCP surface**, not in any origin-guard bypass. 9b writes only
  `refund_initiations`; `payment_refunds`/`refunded_amount_cents`/`payment.status` stay 9a-webhook-owned.

## Rollback
`npx wrangler rollback c52f2dc6 --name reese-photography-crm` → `3fa37e5a`. Schema is additive
(the new table is unused by the prior Worker), so rollback is clean.

## ⚠️ ENABLE checklist (Tyler-only — do ALL before flipping `REFUND_INITIATION_ENABLED=1`)
1. **Admin refund UI** (deferred in the build): a control on the invoice/payment view with amount
   prefill, typed-amount confirmation, the "service not rendered" checkbox, and retainer rows
   disabled. (Server rails are all in place; do NOT first-refund via curl.)
2. **Wire reconciliation**: surface `getRefundInitiationReconciliation()` (both tripwires: succeeded
   >24h with no `payment_refunds` match; `submitting` >~1h stuck) into the finance needs-reconciliation
   view or a scheduled check. Until wired, a stuck refund has no visible alarm.
3. **PRECONDITION auth-armed**: run `scripts/production-smoke.mjs` against prod and confirm the
   `refund/execute` direct-worker 404 (proves `ORIGIN_PROXY_SECRET` set at the Worker AND
   `ADMIN_PROOF_ENFORCE=1`).
4. **PRECONDITION webhook**: confirm the Stripe endpoint is subscribed to **`charge.refunded`**
   specifically (else refunds move but never record / flip status).
5. **PRECONDITION enforce**: set `FINANCE_REFUND_RECORDING=enforce` (or knowingly accept that a full
   refund shows `paid` until then).
6. **Confirm 2 policy interpretations** (flagged in the spec): (a) retainer = label match ∪ earliest
   payment on the invoice — **a single-payment/lump-sum invoice is non-refundable through 9b**;
   (b) "fees passed to client" = refund **service only** (not gross).
7. **First real refund** on a known-safe target, watched end-to-end (initiate → `charge.refunded`
   → `payment_refunds` + `refunded_amount_cents` → status flip).
