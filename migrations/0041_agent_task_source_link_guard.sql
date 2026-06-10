CREATE TRIGGER IF NOT EXISTS trg_agent_tasks_source_link_insert
BEFORE INSERT ON agent_tasks
FOR EACH ROW
WHEN (NEW.source_type IS NULL OR trim(NEW.source_type) = '')
  AND NEW.source_id IS NOT NULL
  AND trim(NEW.source_id) <> ''
BEGIN
  SELECT RAISE(ABORT, 'agent task source links require sourceType when sourceId is set');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_tasks_source_link_update
BEFORE UPDATE OF source_type, source_id ON agent_tasks
FOR EACH ROW
WHEN (NEW.source_type IS NULL OR trim(NEW.source_type) = '')
  AND NEW.source_id IS NOT NULL
  AND trim(NEW.source_id) <> ''
BEGIN
  SELECT RAISE(ABORT, 'agent task source links require sourceType when sourceId is set');
END;
