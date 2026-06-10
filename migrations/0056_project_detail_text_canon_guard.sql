CREATE TRIGGER IF NOT EXISTS trg_projects_detail_text_canon_insert
BEFORE INSERT ON projects
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
  OR (
    NEW.notes IS NOT NULL
    AND (trim(NEW.notes) = '' OR NEW.notes <> trim(NEW.notes))
  )
BEGIN
  SELECT RAISE(ABORT, 'project detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_projects_detail_text_canon_update
BEFORE UPDATE OF event_date, venue_name, venue_address, city, state, notes ON projects
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
  OR (
    NEW.notes IS NOT NULL
    AND (trim(NEW.notes) = '' OR NEW.notes <> trim(NEW.notes))
  )
BEGIN
  SELECT RAISE(ABORT, 'project detail text must be null or trimmed non-empty text');
END;
