CREATE TABLE IF NOT EXISTS proposal_access_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  expires_at TEXT NOT NULL,
  sent_at TEXT,
  viewed_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  last_used_ip TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proposal_tokens_proposal ON proposal_access_tokens(proposal_id);
CREATE INDEX IF NOT EXISTS idx_proposal_tokens_project ON proposal_access_tokens(project_id);
CREATE INDEX IF NOT EXISTS idx_proposal_tokens_expires ON proposal_access_tokens(expires_at);
