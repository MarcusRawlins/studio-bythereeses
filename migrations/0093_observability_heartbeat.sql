-- Phase 21: observability heartbeat + alert dedupe. Additive + idempotent.
-- NON-CANONICAL: nothing here moves money or mutates a business record. These tables
-- are operational only; losing them loses history, never business state. NOT on an
-- always-on business read path, so this can migrate anytime (dark) — but apply it
-- before the monitor Worker deploy so recordJobRun writes land.
--
-- NOTE: numbered 0093 (not 0092 as the original spec draft said) — 0092 was taken by
-- Phase 14 (0092_inbound_project_email.sql) before this phase merged.

CREATE TABLE IF NOT EXISTS job_runs (
  job_name             TEXT PRIMARY KEY NOT NULL,
  last_run_at          TEXT,
  last_success_at      TEXT,
  last_status          TEXT,
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL
);

-- Immediate-alert dedupe: fire a CRITICAL email ONCE per condition instance, re-arm on clear.
CREATE TABLE IF NOT EXISTS health_alerts (
  alert_key     TEXT PRIMARY KEY NOT NULL,  -- e.g. 'critical:refund_stuck:<initiationId>'
  severity      TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_sent_at  TEXT,
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_health_alerts_unresolved ON health_alerts(resolved_at);
