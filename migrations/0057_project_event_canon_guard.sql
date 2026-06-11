CREATE TRIGGER IF NOT EXISTS trg_project_events_identity_canon_insert
BEFORE INSERT ON project_events
FOR EACH ROW
WHEN trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR trim(NEW.type) = ''
  OR NEW.type <> trim(NEW.type)
  OR NEW.calendar_sync_status NOT IN (
    'not_connected',
    'needs_google_connection',
    'synced',
    'sync_failed'
  )
BEGIN
  SELECT CASE
    WHEN trim(NEW.title) = ''
      OR NEW.title <> trim(NEW.title)
    THEN RAISE(ABORT, 'project event title must be trimmed non-empty text')
    WHEN trim(NEW.type) = ''
      OR NEW.type <> trim(NEW.type)
    THEN RAISE(ABORT, 'project event type must be trimmed non-empty text')
    ELSE RAISE(ABORT, 'project event calendar sync status must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_events_identity_canon_update
BEFORE UPDATE OF title, type, calendar_sync_status ON project_events
FOR EACH ROW
WHEN trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR trim(NEW.type) = ''
  OR NEW.type <> trim(NEW.type)
  OR NEW.calendar_sync_status NOT IN (
    'not_connected',
    'needs_google_connection',
    'synced',
    'sync_failed'
  )
BEGIN
  SELECT CASE
    WHEN trim(NEW.title) = ''
      OR NEW.title <> trim(NEW.title)
    THEN RAISE(ABORT, 'project event title must be trimmed non-empty text')
    WHEN trim(NEW.type) = ''
      OR NEW.type <> trim(NEW.type)
    THEN RAISE(ABORT, 'project event type must be trimmed non-empty text')
    ELSE RAISE(ABORT, 'project event calendar sync status must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_events_detail_text_canon_insert
BEFORE INSERT ON project_events
FOR EACH ROW
WHEN (
    NEW.event_date IS NOT NULL
    AND (trim(NEW.event_date) = '' OR NEW.event_date <> trim(NEW.event_date))
  )
  OR (
    NEW.venue_name IS NOT NULL
    AND (trim(NEW.venue_name) = '' OR NEW.venue_name <> trim(NEW.venue_name))
  )
  OR (
    NEW.venue_address IS NOT NULL
    AND (trim(NEW.venue_address) = '' OR NEW.venue_address <> trim(NEW.venue_address))
  )
  OR (
    NEW.city IS NOT NULL
    AND (trim(NEW.city) = '' OR NEW.city <> trim(NEW.city))
  )
  OR (
    NEW.state IS NOT NULL
    AND (trim(NEW.state) = '' OR NEW.state <> trim(NEW.state))
  )
BEGIN
  SELECT RAISE(ABORT, 'project event detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_events_detail_text_canon_update
BEFORE UPDATE OF event_date, venue_name, venue_address, city, state ON project_events
FOR EACH ROW
WHEN (
    NEW.event_date IS NOT NULL
    AND (trim(NEW.event_date) = '' OR NEW.event_date <> trim(NEW.event_date))
  )
  OR (
    NEW.venue_name IS NOT NULL
    AND (trim(NEW.venue_name) = '' OR NEW.venue_name <> trim(NEW.venue_name))
  )
  OR (
    NEW.venue_address IS NOT NULL
    AND (trim(NEW.venue_address) = '' OR NEW.venue_address <> trim(NEW.venue_address))
  )
  OR (
    NEW.city IS NOT NULL
    AND (trim(NEW.city) = '' OR NEW.city <> trim(NEW.city))
  )
  OR (
    NEW.state IS NOT NULL
    AND (trim(NEW.state) = '' OR NEW.state <> trim(NEW.state))
  )
BEGIN
  SELECT RAISE(ABORT, 'project event detail text must be null or trimmed non-empty text');
END;
