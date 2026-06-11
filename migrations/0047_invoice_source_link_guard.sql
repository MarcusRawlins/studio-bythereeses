CREATE TRIGGER IF NOT EXISTS trg_invoices_source_link_insert
BEFORE INSERT ON invoices
FOR EACH ROW
WHEN (NEW.source_type IS NULL OR trim(NEW.source_type) = '')
  AND NEW.source_id IS NOT NULL
  AND trim(NEW.source_id) <> ''
BEGIN
  SELECT RAISE(ABORT, 'invoice source links require sourceType when sourceId is set');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_source_link_update
BEFORE UPDATE OF source_type, source_id ON invoices
FOR EACH ROW
WHEN (NEW.source_type IS NULL OR trim(NEW.source_type) = '')
  AND NEW.source_id IS NOT NULL
  AND trim(NEW.source_id) <> ''
BEGIN
  SELECT RAISE(ABORT, 'invoice source links require sourceType when sourceId is set');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_project_source_insert
BEFORE INSERT ON invoices
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
  SELECT RAISE(ABORT, 'invoice project_source links must point to a source in the same project');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_project_source_update
BEFORE UPDATE OF project_id, source_type, source_id ON invoices
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
  SELECT RAISE(ABORT, 'invoice project_source links must point to a source in the same project');
END;
