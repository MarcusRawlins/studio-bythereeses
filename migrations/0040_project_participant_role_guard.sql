CREATE TRIGGER IF NOT EXISTS trg_project_participants_primary_role_insert
BEFORE INSERT ON project_participants
FOR EACH ROW
WHEN lower(trim(NEW.role)) = 'primary' AND NEW.is_primary_contact = 0
BEGIN
  SELECT RAISE(ABORT, 'primary participant role requires primary-contact flag');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_participants_primary_role_update
BEFORE UPDATE OF role, is_primary_contact ON project_participants
FOR EACH ROW
WHEN lower(trim(NEW.role)) = 'primary' AND NEW.is_primary_contact = 0
BEGIN
  SELECT RAISE(ABORT, 'primary participant role requires primary-contact flag');
END;
