CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_active_dedupe_unique
  ON agent_tasks(project_id, source_type, source_id, title)
  WHERE status IN ('queued', 'in_progress')
    AND project_id IS NOT NULL
    AND source_type IS NOT NULL
    AND source_type <> ''
    AND source_id IS NOT NULL
    AND source_id <> '';
