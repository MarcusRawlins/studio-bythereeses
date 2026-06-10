CREATE TRIGGER IF NOT EXISTS trg_clients_email_required_insert
BEFORE INSERT ON clients
FOR EACH ROW
WHEN NEW.email IS NULL OR trim(NEW.email) = ''
BEGIN
  SELECT RAISE(ABORT, 'client email is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_clients_email_required_update
BEFORE UPDATE OF email ON clients
FOR EACH ROW
WHEN NEW.email IS NULL OR trim(NEW.email) = ''
BEGIN
  SELECT RAISE(ABORT, 'client email is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_clients_email_canon_insert
BEFORE INSERT ON clients
FOR EACH ROW
WHEN NEW.email IS NOT NULL
  AND trim(NEW.email) <> ''
  AND NEW.email <> lower(trim(NEW.email))
BEGIN
  SELECT RAISE(ABORT, 'client email must be lowercase and trimmed');
END;

CREATE TRIGGER IF NOT EXISTS trg_clients_email_canon_update
BEFORE UPDATE OF email ON clients
FOR EACH ROW
WHEN NEW.email IS NOT NULL
  AND trim(NEW.email) <> ''
  AND NEW.email <> lower(trim(NEW.email))
BEGIN
  SELECT RAISE(ABORT, 'client email must be lowercase and trimmed');
END;
