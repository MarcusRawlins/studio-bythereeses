CREATE UNIQUE INDEX IF NOT EXISTS idx_google_calendar_connections_active_email_unique
  ON google_calendar_connections(google_account_email)
  WHERE revoked_at IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_google_calendar_connections_identity_canon_insert
BEFORE INSERT ON google_calendar_connections
FOR EACH ROW
WHEN NEW.google_account_email IS NULL
  OR trim(NEW.google_account_email) = ''
  OR NEW.google_account_email <> trim(NEW.google_account_email)
  OR NEW.google_account_email <> lower(NEW.google_account_email)
  OR NEW.refresh_token IS NULL
  OR trim(NEW.refresh_token) = ''
  OR NEW.refresh_token <> trim(NEW.refresh_token)
  OR NEW.created_at IS NULL
  OR trim(NEW.created_at) = ''
  OR NEW.created_at <> trim(NEW.created_at)
  OR NEW.updated_at IS NULL
  OR trim(NEW.updated_at) = ''
  OR NEW.updated_at <> trim(NEW.updated_at)
BEGIN
  SELECT CASE
    WHEN NEW.google_account_email IS NULL
      OR trim(NEW.google_account_email) = ''
      OR NEW.google_account_email <> trim(NEW.google_account_email)
      OR NEW.google_account_email <> lower(NEW.google_account_email)
      THEN RAISE(ABORT, 'Google calendar account email must be lowercase and trimmed')
    WHEN NEW.refresh_token IS NULL
      OR trim(NEW.refresh_token) = ''
      OR NEW.refresh_token <> trim(NEW.refresh_token)
      THEN RAISE(ABORT, 'Google calendar refresh token must be trimmed non-empty text')
    ELSE RAISE(ABORT, 'Google calendar connection timestamps must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_google_calendar_connections_identity_canon_update
BEFORE UPDATE OF google_account_email, refresh_token, created_at, updated_at ON google_calendar_connections
FOR EACH ROW
WHEN NEW.google_account_email IS NULL
  OR trim(NEW.google_account_email) = ''
  OR NEW.google_account_email <> trim(NEW.google_account_email)
  OR NEW.google_account_email <> lower(NEW.google_account_email)
  OR NEW.refresh_token IS NULL
  OR trim(NEW.refresh_token) = ''
  OR NEW.refresh_token <> trim(NEW.refresh_token)
  OR NEW.created_at IS NULL
  OR trim(NEW.created_at) = ''
  OR NEW.created_at <> trim(NEW.created_at)
  OR NEW.updated_at IS NULL
  OR trim(NEW.updated_at) = ''
  OR NEW.updated_at <> trim(NEW.updated_at)
BEGIN
  SELECT CASE
    WHEN NEW.google_account_email IS NULL
      OR trim(NEW.google_account_email) = ''
      OR NEW.google_account_email <> trim(NEW.google_account_email)
      OR NEW.google_account_email <> lower(NEW.google_account_email)
      THEN RAISE(ABORT, 'Google calendar account email must be lowercase and trimmed')
    WHEN NEW.refresh_token IS NULL
      OR trim(NEW.refresh_token) = ''
      OR NEW.refresh_token <> trim(NEW.refresh_token)
      THEN RAISE(ABORT, 'Google calendar refresh token must be trimmed non-empty text')
    ELSE RAISE(ABORT, 'Google calendar connection timestamps must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_google_calendar_connections_detail_text_canon_insert
BEFORE INSERT ON google_calendar_connections
FOR EACH ROW
WHEN (NEW.display_name IS NOT NULL AND (trim(NEW.display_name) = '' OR NEW.display_name <> trim(NEW.display_name)))
  OR (NEW.scope IS NOT NULL AND (trim(NEW.scope) = '' OR NEW.scope <> trim(NEW.scope)))
  OR (NEW.revoked_at IS NOT NULL AND (trim(NEW.revoked_at) = '' OR NEW.revoked_at <> trim(NEW.revoked_at)))
BEGIN
  SELECT RAISE(ABORT, 'Google calendar connection detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_google_calendar_connections_detail_text_canon_update
BEFORE UPDATE OF display_name, scope, revoked_at ON google_calendar_connections
FOR EACH ROW
WHEN (NEW.display_name IS NOT NULL AND (trim(NEW.display_name) = '' OR NEW.display_name <> trim(NEW.display_name)))
  OR (NEW.scope IS NOT NULL AND (trim(NEW.scope) = '' OR NEW.scope <> trim(NEW.scope)))
  OR (NEW.revoked_at IS NOT NULL AND (trim(NEW.revoked_at) = '' OR NEW.revoked_at <> trim(NEW.revoked_at)))
BEGIN
  SELECT RAISE(ABORT, 'Google calendar connection detail text must be null or trimmed non-empty text');
END;
