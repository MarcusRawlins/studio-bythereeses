CREATE TABLE IF NOT EXISTS google_calendar_connections (
  id TEXT PRIMARY KEY NOT NULL,
  google_account_email TEXT NOT NULL,
  display_name TEXT,
  refresh_token TEXT NOT NULL,
  scope TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_google_calendar_connections_email
  ON google_calendar_connections(google_account_email);

CREATE INDEX IF NOT EXISTS idx_google_calendar_connections_revoked
  ON google_calendar_connections(revoked_at);
