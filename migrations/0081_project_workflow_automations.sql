CREATE TABLE IF NOT EXISTS project_workflow_runs (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_key TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  selected_step_keys_json TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'Tyler',
  started_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_workflow_runs_project_key
  ON project_workflow_runs(project_id, workflow_key);

CREATE INDEX IF NOT EXISTS idx_project_workflow_runs_project_status
  ON project_workflow_runs(project_id, status);

CREATE TABLE IF NOT EXISTS project_workflow_steps (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_run_id TEXT NOT NULL REFERENCES project_workflow_runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  assigned_agent TEXT NOT NULL,
  trigger_label TEXT,
  status TEXT NOT NULL DEFAULT 'configured',
  automation_enabled INTEGER NOT NULL DEFAULT 1,
  agent_task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_workflow_steps_run_key
  ON project_workflow_steps(workflow_run_id, step_key);

CREATE INDEX IF NOT EXISTS idx_project_workflow_steps_project_status
  ON project_workflow_steps(project_id, status, sort_order);

CREATE TRIGGER IF NOT EXISTS trg_project_workflow_runs_canon_insert
BEFORE INSERT ON project_workflow_runs
FOR EACH ROW
WHEN NEW.workflow_key IS NULL
  OR trim(NEW.workflow_key) = ''
  OR NEW.workflow_key <> trim(NEW.workflow_key)
  OR NEW.workflow_name IS NULL
  OR trim(NEW.workflow_name) = ''
  OR NEW.workflow_name <> trim(NEW.workflow_name)
  OR NEW.status NOT IN ('active', 'paused', 'completed', 'cancelled')
  OR json_valid(NEW.selected_step_keys_json) = 0
  OR json_type(NEW.selected_step_keys_json) <> 'array'
BEGIN
  SELECT RAISE(ABORT, 'project workflow run must be canonical');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_workflow_runs_canon_update
BEFORE UPDATE OF workflow_key, workflow_name, status, selected_step_keys_json ON project_workflow_runs
FOR EACH ROW
WHEN NEW.workflow_key IS NULL
  OR trim(NEW.workflow_key) = ''
  OR NEW.workflow_key <> trim(NEW.workflow_key)
  OR NEW.workflow_name IS NULL
  OR trim(NEW.workflow_name) = ''
  OR NEW.workflow_name <> trim(NEW.workflow_name)
  OR NEW.status NOT IN ('active', 'paused', 'completed', 'cancelled')
  OR json_valid(NEW.selected_step_keys_json) = 0
  OR json_type(NEW.selected_step_keys_json) <> 'array'
BEGIN
  SELECT RAISE(ABORT, 'project workflow run must be canonical');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_workflow_steps_canon_insert
BEFORE INSERT ON project_workflow_steps
FOR EACH ROW
WHEN NEW.step_key IS NULL
  OR trim(NEW.step_key) = ''
  OR NEW.step_key <> trim(NEW.step_key)
  OR NEW.title IS NULL
  OR trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR NEW.instructions IS NULL
  OR trim(NEW.instructions) = ''
  OR NEW.instructions <> trim(NEW.instructions)
  OR NEW.assigned_agent IS NULL
  OR trim(NEW.assigned_agent) = ''
  OR NEW.assigned_agent <> trim(NEW.assigned_agent)
  OR NEW.status NOT IN ('configured', 'queued', 'in_progress', 'completed', 'skipped', 'cancelled')
  OR NEW.automation_enabled NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'project workflow step must be canonical');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_workflow_steps_canon_update
BEFORE UPDATE OF step_key, title, instructions, assigned_agent, status, automation_enabled ON project_workflow_steps
FOR EACH ROW
WHEN NEW.step_key IS NULL
  OR trim(NEW.step_key) = ''
  OR NEW.step_key <> trim(NEW.step_key)
  OR NEW.title IS NULL
  OR trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR NEW.instructions IS NULL
  OR trim(NEW.instructions) = ''
  OR NEW.instructions <> trim(NEW.instructions)
  OR NEW.assigned_agent IS NULL
  OR trim(NEW.assigned_agent) = ''
  OR NEW.assigned_agent <> trim(NEW.assigned_agent)
  OR NEW.status NOT IN ('configured', 'queued', 'in_progress', 'completed', 'skipped', 'cancelled')
  OR NEW.automation_enabled NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'project workflow step must be canonical');
END;
