-- Phase 8a: inbound inquiry-email triage staging table.
--
-- This is a PRE-CANONICAL staging table. Inbound, attacker-controlled email
-- lands here and NOWHERE else until Tyler approves. projectId is nullable and
-- unset on ingest (project_sources.project_id is NOT NULL and cannot be reused
-- for un-triaged leads). The drafter writes only the draft_* columns; canonical
-- project/client/communication rows are created only on an explicit admin
-- approval action downstream.
--
-- Dedupe is on the attacker-chosen message_id via a UNIQUE index: ingestion
-- does INSERT ... ON CONFLICT(message_id) DO NOTHING and returns the existing
-- id, and NEVER updates an existing row from inbound data (B2). SQLite treats
-- NULLs as distinct in a UNIQUE index, so a message with no Message-ID is always
-- a fresh (non-deduplicable) row rather than colliding with other NULLs.
CREATE TABLE IF NOT EXISTS inbound_inquiries (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  -- raw (audit) --
  message_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  envelope_from TEXT,
  header_from TEXT,
  to_address TEXT,
  subject TEXT,
  raw_storage_key TEXT,
  body_text TEXT,
  -- auth trust signals (display only, never authz) --
  spf_result TEXT,
  dkim_result TEXT,
  dmarc_result TEXT,
  -- parsed guesses (best-effort, low-trust) --
  parsed_name TEXT,
  parsed_email TEXT,
  parsed_event_date TEXT,
  parsed_venue TEXT,
  parsed_json TEXT,
  -- linkage after approval --
  agent_task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  proposed_project_json TEXT,
  draft_reply_subject TEXT,
  draft_reply_body TEXT,
  dismissed_reason TEXT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_inquiries_message_id ON inbound_inquiries(message_id);
CREATE INDEX IF NOT EXISTS idx_inbound_inquiries_status_created ON inbound_inquiries(status, created_at);
CREATE INDEX IF NOT EXISTS idx_inbound_inquiries_received ON inbound_inquiries(received_at);
CREATE INDEX IF NOT EXISTS idx_inbound_inquiries_parsed_email ON inbound_inquiries(parsed_email);
