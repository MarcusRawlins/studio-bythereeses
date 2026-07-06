# Deploy record — Phase 9a finance completeness (dark) — 2026-07-06

Branch `claude/reese-crm-production-qa-4caxz0`. Deployed autonomously per the build-loop
charter (guardrails hold). **Phase 9a moves ZERO money** (records inbound signature-verified
Stripe webhooks + read-only reports/CSVs), so it does NOT trip the money-movement pause
(that is Phase 9b — refund initiation). Every Stripe interaction is inbound-webhook-only;
the Fable code-review verified no `POST /v1/refunds`/charge/capture call exists anywhere.

## Gates
- Spec Fable-gated **twice** (rev 1 → REQUEST-CHANGES: D1-no-transaction BLOCKER + gross-deletion
  BLOCKER + 4 MAJORs; rev 2 → REQUEST-CHANGES: incomplete settled-status enumeration + out-of-order
  guard; rev 3 → clean). Code Fable-gated once (REQUEST-CHANGES: 1 MAJOR ledger-date + minors → fixed).
- Local verify (independently re-run): `npm run lint` exit 0, `npm run build` **exit 0**, `npm test` 200/200.

## Deploy sequence (all green)
1. Real D1 backup: `studio-bythereeses-2026-07-06T01-31-31Z.sql` (+ local SQLite).
2. Migration `0089_finance_completeness.sql` applied to remote D1 **before** the Worker deploy
   (summary columns on always-on read paths). Verified: 4 `invoice_payments` cols, 4 `vendors`
   cols, 4 new tables (`stripe_webhook_events`/`payment_refunds`/`payment_disputes`/`mileage_logs`).
   Additive + idempotent (`ADD COLUMN NOT NULL DEFAULT`, `CREATE TABLE IF NOT EXISTS`); applied
   via direct `d1 execute --file` (NOT `migrations apply` — tracker out of sync).
3. `npx opennextjs-cloudflare build` → exit 0.
4. Rollback point captured: Worker **`3b78372e`** (prior 8c deploy).
5. `npx opennextjs-cloudflare deploy` → new Worker **`d29fe5c6`**.
6. Pages-proxy: **unchanged** (9a adds no public path; new routes are admin-gated `/api/finance/*`
   + `/finance/*`, same surface as existing finance CSVs) → no proxy redeploy.

## Health checks (post-deploy)
- `/finance`, `/finance/tax`, `/api/finance/{accounting-export,1099-summary}.csv` → 303 → `/admin/login`
  (admin-gated, no data leak, new routes exist, no 5xx).
- Stripe webhook on the origin path Stripe uses
  (`…workers.dev/api/stripe/webhook`, origin-guard public prefix) → **400** on missing/bogus signature
  (signature verification intact; the 9a refund/dispute dispatch runs only after it). Proxy host
  login-walls the webhook path (expected — Stripe uses the origin, not the proxy host).
- `schedule.bythereeses.com` public booking healthy.

## Dark state / rollback
- `FINANCE_REFUND_RECORDING` unset → default `record_only`: child tables + summary columns record,
  but NO `payment.status` flip and NO invoice recompute. `off` is a true kill-switch (records nothing).
- Prod has 0 `invoice_payments` rows and the Stripe webhook is not yet subscribed to refund/dispute
  events, so 9a is inert until Tyler enables (see ledger "9a enable").
- Rollback: `npx wrangler rollback d29fe5c6 --name reese-photography-crm` → `3b78372e` (schema is
  additive, so the prior Worker runs unaffected against the new columns).

## Tyler enablement (NOT autonomous — see ledger)
1. Subscribe the Stripe webhook endpoint to `charge.refunded` / `refund.created` / `refund.updated`
   / `charge.dispute.*` (dashboard config — nothing records without it).
2. After an observation window on real refund data, flip `FINANCE_REFUND_RECORDING=enforce` to allow
   the `refunded` status transition + invoice recompute.
3. Enter finance rate settings (tax set-aside %, mileage ¢/mi, 1099 threshold) + vendor W-9 data.

## Pre-enforce follow-ups (tracked; report-only, inert at `record_only`)
- #3 SQL-side `MAX()` for the monotonic refund guard (currently read-modify-write; concurrency caveat).
- #4 net-revenue service-vs-gross unit fix + #5 exclude orphan refunds from the revenue subtraction
  (both feed the quarterly tax estimate — currently off by the card-fee portion / unlinked refunds).
- #7 dispute-close canon (child raw status vs summary status) for exotic closures.
