CREATE INDEX IF NOT EXISTS idx_activity_logs_action_created
  ON activity_logs(action, created_at);

CREATE TRIGGER IF NOT EXISTS trg_activity_logs_identity_canon_insert
BEFORE INSERT ON activity_logs
FOR EACH ROW
WHEN NEW.action IS NULL
  OR trim(NEW.action) = ''
  OR NEW.action <> trim(NEW.action)
  OR NEW.actor_type NOT IN ('admin', 'client', 'system', 'agent')
  OR NEW.created_at IS NULL
  OR trim(NEW.created_at) = ''
  OR NEW.created_at <> trim(NEW.created_at)
BEGIN
  SELECT CASE
    WHEN NEW.action IS NULL OR trim(NEW.action) = '' OR NEW.action <> trim(NEW.action)
      THEN RAISE(ABORT, 'activity log action must be trimmed non-empty text')
    WHEN NEW.actor_type NOT IN ('admin', 'client', 'system', 'agent')
      THEN RAISE(ABORT, 'activity log actor type must be canonical')
    ELSE RAISE(ABORT, 'activity log created timestamp must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_activity_logs_identity_canon_update
BEFORE UPDATE OF action, actor_type, created_at ON activity_logs
FOR EACH ROW
WHEN NEW.action IS NULL
  OR trim(NEW.action) = ''
  OR NEW.action <> trim(NEW.action)
  OR NEW.actor_type NOT IN ('admin', 'client', 'system', 'agent')
  OR NEW.created_at IS NULL
  OR trim(NEW.created_at) = ''
  OR NEW.created_at <> trim(NEW.created_at)
BEGIN
  SELECT CASE
    WHEN NEW.action IS NULL OR trim(NEW.action) = '' OR NEW.action <> trim(NEW.action)
      THEN RAISE(ABORT, 'activity log action must be trimmed non-empty text')
    WHEN NEW.actor_type NOT IN ('admin', 'client', 'system', 'agent')
      THEN RAISE(ABORT, 'activity log actor type must be canonical')
    ELSE RAISE(ABORT, 'activity log created timestamp must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_activity_logs_detail_text_canon_insert
BEFORE INSERT ON activity_logs
FOR EACH ROW
WHEN NEW.actor_name IS NOT NULL
  AND (trim(NEW.actor_name) = '' OR NEW.actor_name <> trim(NEW.actor_name))
BEGIN
  SELECT RAISE(ABORT, 'activity log detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_activity_logs_detail_text_canon_update
BEFORE UPDATE OF actor_name ON activity_logs
FOR EACH ROW
WHEN NEW.actor_name IS NOT NULL
  AND (trim(NEW.actor_name) = '' OR NEW.actor_name <> trim(NEW.actor_name))
BEGIN
  SELECT RAISE(ABORT, 'activity log detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_activity_logs_metadata_canon_insert
BEFORE INSERT ON activity_logs
FOR EACH ROW
WHEN NEW.metadata IS NOT NULL
  AND (
    trim(NEW.metadata) = ''
    OR NEW.metadata <> trim(NEW.metadata)
    OR json_valid(NEW.metadata) = 0
    OR json_type(NEW.metadata) <> 'object'
  )
BEGIN
  SELECT RAISE(ABORT, 'activity log metadata must be null or canonical json object text');
END;

CREATE TRIGGER IF NOT EXISTS trg_activity_logs_metadata_canon_update
BEFORE UPDATE OF metadata ON activity_logs
FOR EACH ROW
WHEN NEW.metadata IS NOT NULL
  AND (
    trim(NEW.metadata) = ''
    OR NEW.metadata <> trim(NEW.metadata)
    OR json_valid(NEW.metadata) = 0
    OR json_type(NEW.metadata) <> 'object'
  )
BEGIN
  SELECT RAISE(ABORT, 'activity log metadata must be null or canonical json object text');
END;
