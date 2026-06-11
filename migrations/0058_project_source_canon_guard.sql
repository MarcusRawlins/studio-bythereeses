CREATE TRIGGER IF NOT EXISTS trg_project_sources_identity_canon_insert
BEFORE INSERT ON project_sources
FOR EACH ROW
WHEN NEW.kind IS NULL
  OR trim(NEW.kind) = ''
  OR NEW.kind <> trim(NEW.kind)
  OR NEW.title IS NULL
  OR trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR NEW.body IS NULL
  OR trim(NEW.body) = ''
  OR NEW.body <> trim(NEW.body)
BEGIN
  SELECT CASE
    WHEN NEW.kind IS NULL OR trim(NEW.kind) = '' OR NEW.kind <> trim(NEW.kind)
      THEN RAISE(ABORT, 'project source kind must be trimmed non-empty text')
    WHEN NEW.title IS NULL OR trim(NEW.title) = '' OR NEW.title <> trim(NEW.title)
      THEN RAISE(ABORT, 'project source title must be trimmed non-empty text')
    WHEN NEW.body IS NULL OR trim(NEW.body) = '' OR NEW.body <> trim(NEW.body)
      THEN RAISE(ABORT, 'project source body must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_sources_identity_canon_update
BEFORE UPDATE OF kind, title, body ON project_sources
FOR EACH ROW
WHEN NEW.kind IS NULL
  OR trim(NEW.kind) = ''
  OR NEW.kind <> trim(NEW.kind)
  OR NEW.title IS NULL
  OR trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR NEW.body IS NULL
  OR trim(NEW.body) = ''
  OR NEW.body <> trim(NEW.body)
BEGIN
  SELECT CASE
    WHEN NEW.kind IS NULL OR trim(NEW.kind) = '' OR NEW.kind <> trim(NEW.kind)
      THEN RAISE(ABORT, 'project source kind must be trimmed non-empty text')
    WHEN NEW.title IS NULL OR trim(NEW.title) = '' OR NEW.title <> trim(NEW.title)
      THEN RAISE(ABORT, 'project source title must be trimmed non-empty text')
    WHEN NEW.body IS NULL OR trim(NEW.body) = '' OR NEW.body <> trim(NEW.body)
      THEN RAISE(ABORT, 'project source body must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_sources_detail_text_canon_insert
BEFORE INSERT ON project_sources
FOR EACH ROW
WHEN (NEW.summary IS NOT NULL AND (trim(NEW.summary) = '' OR NEW.summary <> trim(NEW.summary)))
  OR (NEW.occurred_at IS NOT NULL AND (trim(NEW.occurred_at) = '' OR NEW.occurred_at <> trim(NEW.occurred_at)))
  OR (NEW.external_url IS NOT NULL AND (trim(NEW.external_url) = '' OR NEW.external_url <> trim(NEW.external_url)))
  OR (NEW.captured_by IS NOT NULL AND (trim(NEW.captured_by) = '' OR NEW.captured_by <> trim(NEW.captured_by)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
BEGIN
  SELECT RAISE(ABORT, 'project source detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_sources_detail_text_canon_update
BEFORE UPDATE OF summary, occurred_at, external_url, captured_by, source_type, source_id ON project_sources
FOR EACH ROW
WHEN (NEW.summary IS NOT NULL AND (trim(NEW.summary) = '' OR NEW.summary <> trim(NEW.summary)))
  OR (NEW.occurred_at IS NOT NULL AND (trim(NEW.occurred_at) = '' OR NEW.occurred_at <> trim(NEW.occurred_at)))
  OR (NEW.external_url IS NOT NULL AND (trim(NEW.external_url) = '' OR NEW.external_url <> trim(NEW.external_url)))
  OR (NEW.captured_by IS NOT NULL AND (trim(NEW.captured_by) = '' OR NEW.captured_by <> trim(NEW.captured_by)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
BEGIN
  SELECT RAISE(ABORT, 'project source detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_sources_metadata_canon_insert
BEFORE INSERT ON project_sources
FOR EACH ROW
WHEN NEW.metadata_json IS NOT NULL
  AND (
    trim(NEW.metadata_json) = ''
    OR NEW.metadata_json <> trim(NEW.metadata_json)
    OR json_valid(NEW.metadata_json) = 0
  )
BEGIN
  SELECT RAISE(ABORT, 'project source metadata must be null or canonical json text');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_sources_metadata_canon_update
BEFORE UPDATE OF metadata_json ON project_sources
FOR EACH ROW
WHEN NEW.metadata_json IS NOT NULL
  AND (
    trim(NEW.metadata_json) = ''
    OR NEW.metadata_json <> trim(NEW.metadata_json)
    OR json_valid(NEW.metadata_json) = 0
  )
BEGIN
  SELECT RAISE(ABORT, 'project source metadata must be null or canonical json text');
END;
