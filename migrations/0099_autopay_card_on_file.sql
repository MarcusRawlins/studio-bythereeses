-- migrations/0099_autopay_card_on_file.sql
-- Phase 13: autopay / card-on-file (off-session installment auto-charge).
-- Additive + idempotent (CREATE TABLE IF NOT EXISTS). INERT while AUTOPAY_ENABLED is off:
-- no existing table is altered and nothing reads these tables until the flag is on (I1).
-- Card data NEVER touches the CRM (I4) — only cus_/pm_ ids + display-only last4/brand/exp.

-- 3.1 autopay_consents — one ACTIVE consent per project (the card-on-file authorization).
CREATE TABLE IF NOT EXISTS autopay_consents (
  id                        TEXT PRIMARY KEY NOT NULL,
  project_id                TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_id                 TEXT REFERENCES clients(id) ON DELETE SET NULL,
  stripe_customer_id        TEXT NOT NULL,                 -- cus_...
  stripe_payment_method_id  TEXT,                          -- pm_... (NULL until the SetupIntent succeeds)
  card_brand                TEXT,                          -- display-only (I4)
  card_last4                TEXT,                          -- display-only (I4) — NEVER a PAN/CVC
  card_exp_month            INTEGER,
  card_exp_year             INTEGER,
  consent_version           TEXT NOT NULL,                 -- version string the client agreed to (§4.2)
  consent_text_hash         TEXT,                          -- hash of the exact rendered copy at grant time
  status                    TEXT NOT NULL DEFAULT 'pending', -- pending | active | revoked | failed
  setup_intent_id           TEXT,                          -- seti_... (idempotency + reconcile join key)
  consented_at              TEXT,
  revoked_at                TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_autopay_consents_project ON autopay_consents(project_id);
CREATE INDEX IF NOT EXISTS idx_autopay_consents_status ON autopay_consents(status);
CREATE INDEX IF NOT EXISTS idx_autopay_consents_setup_intent ON autopay_consents(setup_intent_id);
-- At most ONE active autopay consent per project (a re-consent supersedes the prior via CAS, §4).
CREATE UNIQUE INDEX IF NOT EXISTS idx_autopay_consents_project_active
  ON autopay_consents(project_id) WHERE status = 'active';

-- Canon-guard: the status column is constrained to the enum (mirror 0080's status CHECK trigger).
CREATE TRIGGER IF NOT EXISTS trg_autopay_consents_canon_insert
BEFORE INSERT ON autopay_consents
FOR EACH ROW
WHEN NEW.status NOT IN ('pending', 'active', 'revoked', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'autopay consent status must be canonical');
END;
CREATE TRIGGER IF NOT EXISTS trg_autopay_consents_canon_update
BEFORE UPDATE OF status ON autopay_consents
FOR EACH ROW
WHEN NEW.status NOT IN ('pending', 'active', 'revoked', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'autopay consent status must be canonical');
END;

-- 3.2 autopay_charges — the exactly-once charge ledger (I3 backbone). ONE real (dry_run=0) row per
-- installment ever; dry-run audit rows sit OUTSIDE that partial unique index (bounded to one upserted
-- row per installment by a second partial index). This table IS the idempotency/CAS state machine.
CREATE TABLE IF NOT EXISTS autopay_charges (
  id                        TEXT PRIMARY KEY NOT NULL,     -- our uuid; ALSO the base of the Stripe Idempotency-Key
  invoice_payment_id        TEXT NOT NULL REFERENCES invoice_payments(id) ON DELETE CASCADE,
  invoice_id                TEXT NOT NULL,
  project_id                TEXT NOT NULL,
  consent_id                TEXT NOT NULL,                 -- which consent authorized it
  stripe_customer_id        TEXT NOT NULL,
  stripe_payment_method_id  TEXT NOT NULL,                 -- pinned at claim time (the card that was authorized)
  amount_cents              INTEGER NOT NULL,              -- pinned at claim = invoicePaymentClientPayableOpenCents
  service_amount_cents      INTEGER NOT NULL,              -- pinned split (service) = invoicePaymentOpenCents at claim
  client_fee_cents          INTEGER NOT NULL,              -- pinned split (fee) = amount_cents - service_amount_cents
  currency                  TEXT NOT NULL DEFAULT 'usd',
  status                    TEXT NOT NULL DEFAULT 'pending',
  -- pending | charging | charged | failed_retryable | failed_terminal | needs_action
  --   | skipped_capped | aborted_ineligible
  dry_run                   INTEGER NOT NULL DEFAULT 0,    -- 1 iff created in log_only mode (audit-only; NO Stripe call ever)
  attempt_count             INTEGER NOT NULL DEFAULT 0,
  max_attempts              INTEGER NOT NULL,
  idempotency_key           TEXT,                          -- exact key for the CURRENT attempt (materialized in the claiming UPDATE)
  claim_token               TEXT,                          -- per-attempt CAS ownership token (the refund pattern)
  stripe_payment_intent_id  TEXT,                          -- pi_...
  stripe_status             TEXT,
  decline_code              TEXT,
  last_error                TEXT,                          -- sanitized ≤500
  abort_reason              TEXT,                          -- why aborted_ineligible (e.g. session_complete, amount_drift, consent_revoked)
  refund_candidate_pi       TEXT,                          -- set when a DIFFERENT pi recorded on an already-paid installment (§6.5 double-charge)
  next_attempt_at           TEXT,                          -- earliest next cron tick may re-attempt (failed_retryable)
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  charged_at                TEXT,
  reconciled_at             TEXT
);
CREATE INDEX IF NOT EXISTS idx_autopay_charges_payment ON autopay_charges(invoice_payment_id);
CREATE INDEX IF NOT EXISTS idx_autopay_charges_status ON autopay_charges(status);
CREATE INDEX IF NOT EXISTS idx_autopay_charges_pi ON autopay_charges(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_autopay_charges_project ON autopay_charges(project_id);
-- Layer 1 (I3): at most ONE real (non-dry-run) charge ledger row per installment, EVER. The partial
-- predicate is load-bearing — it keeps dry_run=1 rows entirely OUTSIDE the exactly-once ledger so a
-- log_only audit row can never collide with, block, or be promoted into the single real row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_autopay_charges_ip_real
  ON autopay_charges(invoice_payment_id) WHERE dry_run = 0;
-- Second partial index (R-8): at most ONE dry-run audit row per installment (upsert-refreshed).
CREATE UNIQUE INDEX IF NOT EXISTS idx_autopay_charges_ip_dry
  ON autopay_charges(invoice_payment_id) WHERE dry_run = 1;

-- Canon-guard: the status column is constrained to the enum.
CREATE TRIGGER IF NOT EXISTS trg_autopay_charges_canon_insert
BEFORE INSERT ON autopay_charges
FOR EACH ROW
WHEN NEW.status NOT IN ('pending','charging','charged','failed_retryable','failed_terminal','needs_action','skipped_capped','aborted_ineligible')
BEGIN
  SELECT RAISE(ABORT, 'autopay charge status must be canonical');
END;
CREATE TRIGGER IF NOT EXISTS trg_autopay_charges_canon_update
BEFORE UPDATE OF status ON autopay_charges
FOR EACH ROW
WHEN NEW.status NOT IN ('pending','charging','charged','failed_retryable','failed_terminal','needs_action','skipped_capped','aborted_ineligible')
BEGIN
  SELECT RAISE(ABORT, 'autopay charge status must be canonical');
END;
