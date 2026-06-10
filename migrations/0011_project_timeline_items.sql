CREATE TABLE IF NOT EXISTS project_timeline_items (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  start_at TEXT,
  end_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source_type TEXT,
  source_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_timeline_items_project_sort
  ON project_timeline_items(project_id, sort_order, start_at);

CREATE INDEX IF NOT EXISTS idx_project_timeline_items_project_start
  ON project_timeline_items(project_id, start_at);

CREATE INDEX IF NOT EXISTS idx_project_timeline_items_source
  ON project_timeline_items(source_type, source_id);
