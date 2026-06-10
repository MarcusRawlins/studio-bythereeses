CREATE TRIGGER IF NOT EXISTS trg_clients_phone_canon_insert
BEFORE INSERT ON clients
FOR EACH ROW
WHEN NEW.phone IS NOT NULL
  AND (trim(NEW.phone) = '' OR NEW.phone <> trim(NEW.phone))
BEGIN
  SELECT RAISE(ABORT, 'client phone must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_clients_phone_canon_update
BEFORE UPDATE OF phone ON clients
FOR EACH ROW
WHEN NEW.phone IS NOT NULL
  AND (trim(NEW.phone) = '' OR NEW.phone <> trim(NEW.phone))
BEGIN
  SELECT RAISE(ABORT, 'client phone must be null or trimmed non-empty text');
END;
