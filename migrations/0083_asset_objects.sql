CREATE TABLE IF NOT EXISTS asset_objects (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  proposal_id TEXT REFERENCES proposals(id) ON DELETE SET NULL,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_asset_objects_project_kind ON asset_objects(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_asset_objects_proposal ON asset_objects(proposal_id);
