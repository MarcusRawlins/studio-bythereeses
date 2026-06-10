CREATE TRIGGER IF NOT EXISTS trg_project_participants_role_canon_insert
BEFORE INSERT ON project_participants
FOR EACH ROW
WHEN NEW.role IS NULL
  OR trim(NEW.role) = ''
  OR NEW.role <> trim(NEW.role)
BEGIN
  SELECT RAISE(ABORT, 'project participant role must be trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_participants_role_canon_update
BEFORE UPDATE OF role ON project_participants
FOR EACH ROW
WHEN NEW.role IS NULL
  OR trim(NEW.role) = ''
  OR NEW.role <> trim(NEW.role)
BEGIN
  SELECT RAISE(ABORT, 'project participant role must be trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_participants_primary_flag_canon_insert
BEFORE INSERT ON project_participants
FOR EACH ROW
WHEN NEW.is_primary_contact NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'project participant primary flag must be canonical');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_participants_primary_flag_canon_update
BEFORE UPDATE OF is_primary_contact ON project_participants
FOR EACH ROW
WHEN NEW.is_primary_contact NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'project participant primary flag must be canonical');
END;
