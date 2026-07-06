-- Phase 9a: Finance completeness — refund/dispute WEBHOOK recording + tax/1099 + mileage.
-- Additive + idempotent. NO money is moved by anything reading/writing these objects.
-- The invoice_payments summary columns are read on always-on paths (finance report +
-- reconcile status), so 0089 must be applied to prod BEFORE the Worker deploy.
-- All ALTER ... ADD COLUMN use NOT NULL DEFAULT (SQLite-safe, no table rewrite).

-- Summary columns on the payment (always-on read path).
ALTER TABLE invoice_payments ADD COLUMN refunded_amount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_payments ADD COLUMN dispute_status TEXT;
ALTER TABLE invoice_payments ADD COLUMN disputed_amount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_payments ADD COLUMN last_refund_at TEXT;

-- Finance rate app-settings (reports only; safe code defaults when NULL). Not secrets.
ALTER TABLE app_settings ADD COLUMN tax_set_aside_rate_percent INTEGER;
ALTER TABLE app_settings ADD COLUMN mileage_rate_cents INTEGER;
ALTER TABLE app_settings ADD COLUMN form_1099_threshold_cents INTEGER;

-- 1099 / W-9 vendor tax data (store ONLY last4 of the TIN — PII minimization).
ALTER TABLE vendors ADD COLUMN tax_id_last4 TEXT;
ALTER TABLE vendors ADD COLUMN is_1099_tracked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vendors ADD COLUMN legal_name TEXT;
ALTER TABLE vendors ADD COLUMN tax_address TEXT;

-- Event-id dedupe (fast-path skip + audit). Written LAST, after processing succeeds.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id          TEXT PRIMARY KEY NOT NULL,
  event_type        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  stripe_created_at TEXT,
  result            TEXT
);

-- Child ledger: individual refund objects (a payment can have several partial refunds).
CREATE TABLE IF NOT EXISTS payment_refunds (
  id                       TEXT PRIMARY KEY NOT NULL,
  stripe_refund_id         TEXT NOT NULL,
  stripe_charge_id         TEXT,
  stripe_payment_intent_id TEXT,
  invoice_payment_id       TEXT REFERENCES invoice_payments(id) ON DELETE SET NULL,
  scheduler_booking_id     TEXT REFERENCES scheduler_bookings(id) ON DELETE SET NULL,
  amount_cents             INTEGER NOT NULL DEFAULT 0,
  currency                 TEXT NOT NULL DEFAULT 'usd',
  reason                   TEXT,
  status                   TEXT,
  stripe_created_at        TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

-- Child ledger: disputes / chargebacks (a distinct lifecycle object).
CREATE TABLE IF NOT EXISTS payment_disputes (
  id                       TEXT PRIMARY KEY NOT NULL,
  stripe_dispute_id        TEXT NOT NULL,
  stripe_charge_id         TEXT,
  stripe_payment_intent_id TEXT,
  invoice_payment_id       TEXT REFERENCES invoice_payments(id) ON DELETE SET NULL,
  scheduler_booking_id     TEXT REFERENCES scheduler_bookings(id) ON DELETE SET NULL,
  amount_cents             INTEGER NOT NULL DEFAULT 0,
  currency                 TEXT NOT NULL DEFAULT 'usd',
  reason                   TEXT,
  status                   TEXT,
  funds_reinstated         INTEGER NOT NULL DEFAULT 0,
  opened_at                TEXT,
  closed_at                TEXT,
  stripe_created_at        TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

-- Mileage log (deduction input). No money moved.
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

-- UNIQUE on the Stripe id is the dedupe key inside each child table (INSERT-OR-IGNORE,
-- then set-to-authoritative — never blind-increment).
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_refunds_stripe_refund_id_unique ON payment_refunds(stripe_refund_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_disputes_stripe_dispute_id_unique ON payment_disputes(stripe_dispute_id);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_pi   ON payment_refunds(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_ip   ON payment_refunds(invoice_payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_created ON payment_refunds(created_at);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_pi  ON payment_disputes(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_ip  ON payment_disputes(invoice_payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_created ON payment_disputes(created_at);
CREATE INDEX IF NOT EXISTS idx_mileage_logs_trip_date ON mileage_logs(trip_date);
CREATE INDEX IF NOT EXISTS idx_mileage_logs_project ON mileage_logs(project_id);
