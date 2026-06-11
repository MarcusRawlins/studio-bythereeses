CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  instructions TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  priority TEXT NOT NULL DEFAULT 'normal',
  requested_by TEXT,
  assigned_agent TEXT,
  source_type TEXT,
  source_id TEXT,
  result_summary TEXT,
  output_json TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_project_status
  ON agent_tasks(project_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_created
  ON agent_tasks(status, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_source
  ON agent_tasks(source_type, source_id);
