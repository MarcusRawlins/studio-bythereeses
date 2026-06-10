CREATE INDEX IF NOT EXISTS idx_agent_tasks_active_dedupe
  ON agent_tasks(project_id, source_type, source_id, title, status, created_at);
