CREATE TABLE IF NOT EXISTS project_sources (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  summary TEXT,
  occurred_at TEXT,
  external_url TEXT,
  captured_by TEXT,
  source_type TEXT,
  source_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_sources_project_kind
  ON project_sources(project_id, kind, occurred_at, created_at);

CREATE INDEX IF NOT EXISTS idx_project_sources_source
  ON project_sources(source_type, source_id);
