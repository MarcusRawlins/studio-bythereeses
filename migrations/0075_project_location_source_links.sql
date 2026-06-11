ALTER TABLE project_locations ADD COLUMN source_type TEXT;
ALTER TABLE project_locations ADD COLUMN source_id TEXT;

CREATE INDEX IF NOT EXISTS idx_project_locations_project_source
  ON project_locations(project_id, source_type, source_id);

CREATE TRIGGER IF NOT EXISTS trg_project_locations_source_pair_insert
BEFORE INSERT ON project_locations
FOR EACH ROW
WHEN (NEW.source_id IS NOT NULL AND (NEW.source_type IS NULL OR trim(NEW.source_type) = ''))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
BEGIN
  SELECT CASE
    WHEN NEW.source_id IS NOT NULL AND (NEW.source_type IS NULL OR trim(NEW.source_type) = '')
      THEN RAISE(ABORT, 'project location source links require sourceType when sourceId is set')
    ELSE RAISE(ABORT, 'project location source links must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_locations_source_pair_update
BEFORE UPDATE OF source_type, source_id ON project_locations
FOR EACH ROW
WHEN (NEW.source_id IS NOT NULL AND (NEW.source_type IS NULL OR trim(NEW.source_type) = ''))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
BEGIN
  SELECT CASE
    WHEN NEW.source_id IS NOT NULL AND (NEW.source_type IS NULL OR trim(NEW.source_type) = '')
      THEN RAISE(ABORT, 'project location source links require sourceType when sourceId is set')
    ELSE RAISE(ABORT, 'project location source links must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_locations_project_source_insert
BEFORE INSERT ON project_locations
FOR EACH ROW
WHEN NEW.source_type = 'project_source'
  AND NOT EXISTS (
    SELECT 1
    FROM project_sources
    WHERE project_sources.id = NEW.source_id
      AND project_sources.project_id = NEW.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Project source not found for this project.');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_locations_project_source_update
BEFORE UPDATE OF project_id, source_type, source_id ON project_locations
FOR EACH ROW
WHEN NEW.source_type = 'project_source'
  AND NOT EXISTS (
    SELECT 1
    FROM project_sources
    WHERE project_sources.id = NEW.source_id
      AND project_sources.project_id = NEW.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Project source not found for this project.');
END;
