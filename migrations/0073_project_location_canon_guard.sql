CREATE TRIGGER IF NOT EXISTS trg_project_locations_identity_canon_insert
BEFORE INSERT ON project_locations
FOR EACH ROW
WHEN NEW.type IS NULL
  OR trim(NEW.type) = ''
  OR NEW.type <> trim(NEW.type)
  OR NEW.name IS NULL
  OR trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
BEGIN
  SELECT CASE
    WHEN NEW.type IS NULL OR trim(NEW.type) = '' OR NEW.type <> trim(NEW.type)
      THEN RAISE(ABORT, 'project location type must be trimmed non-empty text')
    ELSE RAISE(ABORT, 'project location name must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_locations_identity_canon_update
BEFORE UPDATE OF type, name ON project_locations
FOR EACH ROW
WHEN NEW.type IS NULL
  OR trim(NEW.type) = ''
  OR NEW.type <> trim(NEW.type)
  OR NEW.name IS NULL
  OR trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
BEGIN
  SELECT CASE
    WHEN NEW.type IS NULL OR trim(NEW.type) = '' OR NEW.type <> trim(NEW.type)
      THEN RAISE(ABORT, 'project location type must be trimmed non-empty text')
    ELSE RAISE(ABORT, 'project location name must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_locations_detail_text_canon_insert
BEFORE INSERT ON project_locations
FOR EACH ROW
WHEN (NEW.address IS NOT NULL AND (trim(NEW.address) = '' OR NEW.address <> trim(NEW.address)))
  OR (NEW.city IS NOT NULL AND (trim(NEW.city) = '' OR NEW.city <> trim(NEW.city)))
  OR (NEW.state IS NOT NULL AND (trim(NEW.state) = '' OR NEW.state <> trim(NEW.state)))
  OR (NEW.notes IS NOT NULL AND (trim(NEW.notes) = '' OR NEW.notes <> trim(NEW.notes)))
BEGIN
  SELECT RAISE(ABORT, 'project location detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_locations_detail_text_canon_update
BEFORE UPDATE OF address, city, state, notes ON project_locations
FOR EACH ROW
WHEN (NEW.address IS NOT NULL AND (trim(NEW.address) = '' OR NEW.address <> trim(NEW.address)))
  OR (NEW.city IS NOT NULL AND (trim(NEW.city) = '' OR NEW.city <> trim(NEW.city)))
  OR (NEW.state IS NOT NULL AND (trim(NEW.state) = '' OR NEW.state <> trim(NEW.state)))
  OR (NEW.notes IS NOT NULL AND (trim(NEW.notes) = '' OR NEW.notes <> trim(NEW.notes)))
BEGIN
  SELECT RAISE(ABORT, 'project location detail text must be null or trimmed non-empty text');
END;
