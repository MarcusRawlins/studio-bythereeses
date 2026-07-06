-- migrations/0091_refund_initiation.sql
-- Phase 9b: audit + idempotency ledger for admin-initiated Stripe refunds.
-- 9b MOVES money via POST /v1/refunds. This table records WHO/WHEN/HOW-MUCH and holds
-- the deterministic Stripe Idempotency-Key (= the row id). It is NOT the canonical refund
-- ledger — payment_refunds (9a, webhook-owned) is. Never written from an agent/webhook path.
-- Additive + idempotent (CREATE TABLE IF NOT EXISTS); not on an always-on read path.
CREATE TABLE IF NOT EXISTS refund_initiations (
  id                             TEXT PRIMARY KEY NOT NULL,   -- our uuid; ALSO the Stripe Idempotency-Key
  invoice_payment_id             TEXT NOT NULL REFERENCES invoice_payments(id) ON DELETE CASCADE,
  stripe_payment_intent_id       TEXT,                        -- pi_... snapshot at initiation
  amount_cents                   INTEGER NOT NULL DEFAULT 0,
  currency                       TEXT NOT NULL DEFAULT 'usd',
  reason                         TEXT,                         -- internal reason (audit; capped 500); REQUIRED at execute (§3.9)
  service_not_rendered_confirmed INTEGER NOT NULL DEFAULT 0,  -- P10/§3.9: admin affirmed service was NOT rendered (1) before the money-moving call
  stripe_reason                  TEXT,                         -- requested_by_customer | duplicate | fraudulent
  status                         TEXT NOT NULL DEFAULT 'pending', -- pending | submitting | succeeded | failed
  claim_token                    TEXT,                         -- per-execute nonce; only the CAS winner (whose token survives the re-read) may POST/finalize (concurrency guard)
  stripe_refund_id               TEXT,                         -- re_... returned by Stripe (read-only cross-ref)
  error_message                  TEXT,                         -- cleaned Stripe error (capped)
  initiated_by                   TEXT,                         -- admin identity (actorName)
  created_at                     TEXT NOT NULL,
  updated_at                     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refund_initiations_payment ON refund_initiations(invoice_payment_id);
CREATE INDEX IF NOT EXISTS idx_refund_initiations_refund  ON refund_initiations(stripe_refund_id);
CREATE INDEX IF NOT EXISTS idx_refund_initiations_status  ON refund_initiations(status);
