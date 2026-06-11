ALTER TABLE project_events ADD COLUMN source_type TEXT;
ALTER TABLE project_events ADD COLUMN source_id TEXT;

CREATE INDEX IF NOT EXISTS idx_project_events_project_source
  ON project_events(project_id, source_type, source_id);
