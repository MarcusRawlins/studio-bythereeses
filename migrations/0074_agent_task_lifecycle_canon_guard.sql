CREATE TRIGGER IF NOT EXISTS trg_agent_tasks_lifecycle_canon_insert
BEFORE INSERT ON agent_tasks
FOR EACH ROW
WHEN NEW.status IN ('completed', 'failed', 'cancelled')
  AND (NEW.completed_at IS NULL OR trim(NEW.completed_at) = '' OR NEW.completed_at <> trim(NEW.completed_at))
BEGIN
  SELECT RAISE(ABORT, 'agent task terminal statuses require completedAt');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_tasks_lifecycle_canon_update
BEFORE UPDATE OF status, completed_at ON agent_tasks
FOR EACH ROW
WHEN NEW.status IN ('completed', 'failed', 'cancelled')
  AND (NEW.completed_at IS NULL OR trim(NEW.completed_at) = '' OR NEW.completed_at <> trim(NEW.completed_at))
BEGIN
  SELECT RAISE(ABORT, 'agent task terminal statuses require completedAt');
END;
