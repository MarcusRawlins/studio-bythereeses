-- Phase 8b: SMS (Twilio) — TCPA consent + number-level suppression + delivery status.
--
-- ALWAYS-ON schema change. The five clients consent columns are read by the SMS
-- send helper's consent gate on an always-on code path (the gate runs whenever a
-- send is attempted, independent of the SMS_ENABLED flag — the flag only decides
-- whether the transport fires). Selecting a client row is a broad, existing query
-- surface, so this migration MUST be applied to prod BEFORE the Worker deploy or
-- existing client reads risk `no such column`. Apply first, verify the columns +
-- row sanity, then deploy the Worker (Active-Learning Log: migration ordering).
--
-- All statements are additive and idempotent-friendly. SQLite allows NOT NULL on
-- ADD COLUMN only with a DEFAULT; sms_opt_in has one, so this is safe and does not
-- rewrite the table. Every existing client is opted-OUT (default 0) until an
-- explicit opt-in — the legally safe default (no client is swept into consent).
--
-- Apply on prod via the idempotent direct `d1 execute --file` pattern; do NOT
-- blanket `migrations apply --remote` (the d1_migrations tracker is out of sync).

ALTER TABLE clients ADD COLUMN sms_opt_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN sms_consent_source TEXT;
ALTER TABLE clients ADD COLUMN sms_consent_at TEXT;
ALTER TABLE clients ADD COLUMN sms_opt_out_at TEXT;
ALTER TABLE clients ADD COLUMN sms_last_consent_note TEXT;

-- Delivery-status persistence on project_communications so Twilio status
-- callbacks can advance a row we already own, keyed by the stored Message SID.
ALTER TABLE project_communications ADD COLUMN provider_message_id TEXT;
ALTER TABLE project_communications ADD COLUMN delivery_status TEXT;

-- Number-level suppression store. A STOP can arrive from a number that matches no
-- current client (or fails E.164 normalization); the send gate consults this table
-- independently of the client columns. INSERT-only from inbound STOP
-- (ON CONFLICT DO NOTHING — earliest STOP is authoritative); a START deletes the
-- row. phone_e164 is the PRIMARY KEY so a replayed STOP is an idempotent no-op.
CREATE TABLE IF NOT EXISTS sms_suppressions (
  phone_e164 TEXT PRIMARY KEY NOT NULL,
  stopped_at TEXT NOT NULL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_project_communications_provider_message_id
  ON project_communications(provider_message_id);
