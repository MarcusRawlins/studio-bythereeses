CREATE TRIGGER IF NOT EXISTS trg_agent_tasks_identity_canon_insert
BEFORE INSERT ON agent_tasks
FOR EACH ROW
WHEN NEW.title IS NULL
  OR trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR NEW.status NOT IN ('queued', 'in_progress', 'completed', 'failed', 'cancelled')
  OR NEW.priority NOT IN ('low', 'normal', 'high', 'urgent')
BEGIN
  SELECT CASE
    WHEN NEW.title IS NULL OR trim(NEW.title) = '' OR NEW.title <> trim(NEW.title)
      THEN RAISE(ABORT, 'agent task title must be trimmed non-empty text')
    WHEN NEW.status NOT IN ('queued', 'in_progress', 'completed', 'failed', 'cancelled')
      THEN RAISE(ABORT, 'agent task status must be canonical')
    ELSE RAISE(ABORT, 'agent task priority must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_tasks_identity_canon_update
BEFORE UPDATE OF title, status, priority ON agent_tasks
FOR EACH ROW
WHEN NEW.title IS NULL
  OR trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR NEW.status NOT IN ('queued', 'in_progress', 'completed', 'failed', 'cancelled')
  OR NEW.priority NOT IN ('low', 'normal', 'high', 'urgent')
BEGIN
  SELECT CASE
    WHEN NEW.title IS NULL OR trim(NEW.title) = '' OR NEW.title <> trim(NEW.title)
      THEN RAISE(ABORT, 'agent task title must be trimmed non-empty text')
    WHEN NEW.status NOT IN ('queued', 'in_progress', 'completed', 'failed', 'cancelled')
      THEN RAISE(ABORT, 'agent task status must be canonical')
    ELSE RAISE(ABORT, 'agent task priority must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_tasks_detail_text_canon_insert
BEFORE INSERT ON agent_tasks
FOR EACH ROW
WHEN (NEW.instructions IS NOT NULL AND (trim(NEW.instructions) = '' OR NEW.instructions <> trim(NEW.instructions)))
  OR (NEW.requested_by IS NOT NULL AND (trim(NEW.requested_by) = '' OR NEW.requested_by <> trim(NEW.requested_by)))
  OR (NEW.assigned_agent IS NOT NULL AND (trim(NEW.assigned_agent) = '' OR NEW.assigned_agent <> trim(NEW.assigned_agent)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
  OR (NEW.result_summary IS NOT NULL AND (trim(NEW.result_summary) = '' OR NEW.result_summary <> trim(NEW.result_summary)))
  OR (NEW.error_message IS NOT NULL AND (trim(NEW.error_message) = '' OR NEW.error_message <> trim(NEW.error_message)))
  OR (NEW.started_at IS NOT NULL AND (trim(NEW.started_at) = '' OR NEW.started_at <> trim(NEW.started_at)))
  OR (NEW.completed_at IS NOT NULL AND (trim(NEW.completed_at) = '' OR NEW.completed_at <> trim(NEW.completed_at)))
BEGIN
  SELECT RAISE(ABORT, 'agent task detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_tasks_detail_text_canon_update
BEFORE UPDATE OF instructions, requested_by, assigned_agent, source_type, source_id, result_summary, error_message, started_at, completed_at ON agent_tasks
FOR EACH ROW
WHEN (NEW.instructions IS NOT NULL AND (trim(NEW.instructions) = '' OR NEW.instructions <> trim(NEW.instructions)))
  OR (NEW.requested_by IS NOT NULL AND (trim(NEW.requested_by) = '' OR NEW.requested_by <> trim(NEW.requested_by)))
  OR (NEW.assigned_agent IS NOT NULL AND (trim(NEW.assigned_agent) = '' OR NEW.assigned_agent <> trim(NEW.assigned_agent)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
  OR (NEW.result_summary IS NOT NULL AND (trim(NEW.result_summary) = '' OR NEW.result_summary <> trim(NEW.result_summary)))
  OR (NEW.error_message IS NOT NULL AND (trim(NEW.error_message) = '' OR NEW.error_message <> trim(NEW.error_message)))
  OR (NEW.started_at IS NOT NULL AND (trim(NEW.started_at) = '' OR NEW.started_at <> trim(NEW.started_at)))
  OR (NEW.completed_at IS NOT NULL AND (trim(NEW.completed_at) = '' OR NEW.completed_at <> trim(NEW.completed_at)))
BEGIN
  SELECT RAISE(ABORT, 'agent task detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_tasks_output_canon_insert
BEFORE INSERT ON agent_tasks
FOR EACH ROW
WHEN NEW.output_json IS NOT NULL
  AND (
    trim(NEW.output_json) = ''
    OR NEW.output_json <> trim(NEW.output_json)
    OR json_valid(NEW.output_json) = 0
    OR json_type(NEW.output_json) <> 'object'
  )
BEGIN
  SELECT RAISE(ABORT, 'agent task output must be null or canonical json object text');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_tasks_output_canon_update
BEFORE UPDATE OF output_json ON agent_tasks
FOR EACH ROW
WHEN NEW.output_json IS NOT NULL
  AND (
    trim(NEW.output_json) = ''
    OR NEW.output_json <> trim(NEW.output_json)
    OR json_valid(NEW.output_json) = 0
    OR json_type(NEW.output_json) <> 'object'
  )
BEGIN
  SELECT RAISE(ABORT, 'agent task output must be null or canonical json object text');
END;
