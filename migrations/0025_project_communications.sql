CREATE TABLE IF NOT EXISTS project_communications (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  direction TEXT NOT NULL DEFAULT 'outbound',
  channel TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL DEFAULT 'draft',
  subject TEXT,
  body TEXT NOT NULL,
  recipient_name TEXT,
  recipient_email TEXT,
  scheduled_for TEXT,
  sent_at TEXT,
  source_type TEXT,
  source_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_communications_project_status
  ON project_communications(project_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_project_communications_source
  ON project_communications(source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_project_communications_recipient
  ON project_communications(recipient_email, created_at);
