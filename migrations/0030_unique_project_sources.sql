CREATE UNIQUE INDEX IF NOT EXISTS idx_project_sources_project_source_unique
  ON project_sources(project_id, source_type, source_id)
  WHERE source_type IS NOT NULL
    AND source_type <> ''
    AND source_id IS NOT NULL
    AND source_id <> '';
