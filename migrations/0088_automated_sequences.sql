-- Phase 8c: Automated communication sequences (dunning / pre-event nudge /
-- post-delivery review).
--
-- ADDITIVE + DARK. All three tables are read/written ONLY by the flag-gated
-- sequence runner (src/lib/sequences.ts) and the public unsubscribe endpoint.
-- Unlike 0087 (which added always-on `clients` consent columns read on a broad
-- query surface), these are NOT an always-on read path, so this migration is NOT
-- deploy-order critical — it can be applied dark anytime. Still apply via the
-- idempotent direct `d1 execute --file` pattern; do NOT blanket
-- `migrations apply --remote` (the d1_migrations tracker is out of sync —
-- Active-Learning Log). Reconcile the tracker separately.
--
-- ROLLBACK NOTE: do NOT drop email_suppressions on a feature rollback — a
-- client's unsubscribe must survive a toggle (same rule as sms_suppressions).

-- Consent/compliance suppression list for sequence email. email = PRIMARY KEY
-- (dedupe); every write is INSERT ON CONFLICT DO NOTHING (attacker-chosen input
-- → insert-not-update). Only ever grows on an unsubscribe POST (fail-safe).
CREATE TABLE IF NOT EXISTS email_suppressions (
  email TEXT PRIMARY KEY NOT NULL,
  suppressed_at TEXT NOT NULL,
  source TEXT,
  note TEXT
);

-- Enrollment state. UNIQUE(sequence_key, anchor_key) makes auto-enroll
-- idempotent (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  client_id TEXT,
  sequence_key TEXT NOT NULL,
  anchor_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  enrolled_by TEXT NOT NULL DEFAULT 'system',
  enrolled_at TEXT NOT NULL,
  stopped_at TEXT,
  stop_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sequence_enrollment
  ON sequence_enrollments(sequence_key, anchor_key);
CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_status
  ON sequence_enrollments(status, sequence_key);
CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_project
  ON sequence_enrollments(project_id, status);

-- The at-most-once ledger. UNIQUE(dedupe_key) makes a double-fire a DB-level
-- impossibility. status: claimed(terminal-unknown) | done | failed(provably-not-
-- sent, retryable) | superseded.
CREATE TABLE IF NOT EXISTS sequence_sends (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  client_id TEXT,
  enrollment_id TEXT,
  sequence_key TEXT NOT NULL,
  step_key TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  communication_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  fired_at TEXT NOT NULL,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sequence_sends_dedupe
  ON sequence_sends(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_sequence_sends_client_fired
  ON sequence_sends(client_id, fired_at);
CREATE INDEX IF NOT EXISTS idx_sequence_sends_status
  ON sequence_sends(status, fired_at);
