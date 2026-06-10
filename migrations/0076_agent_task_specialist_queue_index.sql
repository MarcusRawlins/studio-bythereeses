CREATE INDEX IF NOT EXISTS idx_agent_tasks_specialist_queue
  ON agent_tasks(status, assigned_agent, project_id, created_at);
