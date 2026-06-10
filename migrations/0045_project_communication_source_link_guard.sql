CREATE TRIGGER IF NOT EXISTS trg_project_communications_source_link_insert
BEFORE INSERT ON project_communications
FOR EACH ROW
WHEN (NEW.source_type IS NULL OR trim(NEW.source_type) = '')
  AND NEW.source_id IS NOT NULL
  AND trim(NEW.source_id) <> ''
BEGIN
  SELECT RAISE(ABORT, 'project communication source links require sourceType when sourceId is set');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_communications_source_link_update
BEFORE UPDATE OF source_type, source_id ON project_communications
FOR EACH ROW
WHEN (NEW.source_type IS NULL OR trim(NEW.source_type) = '')
  AND NEW.source_id IS NOT NULL
  AND trim(NEW.source_id) <> ''
BEGIN
  SELECT RAISE(ABORT, 'project communication source links require sourceType when sourceId is set');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_communications_project_source_insert
BEFORE INSERT ON project_communications
FOR EACH ROW
WHEN NEW.source_type = 'project_source'
  AND (
    NEW.project_id IS NULL
    OR trim(NEW.project_id) = ''
    OR NEW.source_id IS NULL
    OR trim(NEW.source_id) = ''
    OR NOT EXISTS (
      SELECT 1
      FROM project_sources
      WHERE project_sources.id = NEW.source_id
        AND project_sources.project_id = NEW.project_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project communication project_source links must point to a source in the same project');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_communications_project_source_update
BEFORE UPDATE OF project_id, source_type, source_id ON project_communications
FOR EACH ROW
WHEN NEW.source_type = 'project_source'
  AND (
    NEW.project_id IS NULL
    OR trim(NEW.project_id) = ''
    OR NEW.source_id IS NULL
    OR trim(NEW.source_id) = ''
    OR NOT EXISTS (
      SELECT 1
      FROM project_sources
      WHERE project_sources.id = NEW.source_id
        AND project_sources.project_id = NEW.project_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project communication project_source links must point to a source in the same project');
END;
