CREATE TRIGGER IF NOT EXISTS trg_clients_name_canon_insert
BEFORE INSERT ON clients
FOR EACH ROW
WHEN trim(NEW.first_name) = ''
  OR NEW.first_name <> trim(NEW.first_name)
  OR (
    NEW.last_name IS NOT NULL
    AND (trim(NEW.last_name) = '' OR NEW.last_name <> trim(NEW.last_name))
  )
  OR (
    NEW.preferred_name IS NOT NULL
    AND (trim(NEW.preferred_name) = '' OR NEW.preferred_name <> trim(NEW.preferred_name))
  )
BEGIN
  SELECT CASE
    WHEN trim(NEW.first_name) = ''
      OR NEW.first_name <> trim(NEW.first_name)
    THEN RAISE(ABORT, 'client first name must be trimmed non-empty text')
    ELSE RAISE(ABORT, 'client optional names must be null or trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_clients_name_canon_update
BEFORE UPDATE OF first_name, last_name, preferred_name ON clients
FOR EACH ROW
WHEN trim(NEW.first_name) = ''
  OR NEW.first_name <> trim(NEW.first_name)
  OR (
    NEW.last_name IS NOT NULL
    AND (trim(NEW.last_name) = '' OR NEW.last_name <> trim(NEW.last_name))
  )
  OR (
    NEW.preferred_name IS NOT NULL
    AND (trim(NEW.preferred_name) = '' OR NEW.preferred_name <> trim(NEW.preferred_name))
  )
BEGIN
  SELECT CASE
    WHEN trim(NEW.first_name) = ''
      OR NEW.first_name <> trim(NEW.first_name)
    THEN RAISE(ABORT, 'client first name must be trimmed non-empty text')
    ELSE RAISE(ABORT, 'client optional names must be null or trimmed non-empty text')
  END;
END;
