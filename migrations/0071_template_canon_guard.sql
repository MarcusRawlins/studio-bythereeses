CREATE TRIGGER IF NOT EXISTS trg_templates_identity_canon_insert
BEFORE INSERT ON templates
FOR EACH ROW
WHEN NEW.type NOT IN ('email', 'questionnaire', 'contract', 'workflow')
  OR NEW.name IS NULL
  OR trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
  OR NEW.body IS NULL
  OR trim(NEW.body) = ''
  OR NEW.body <> trim(NEW.body)
  OR NEW.status NOT IN ('active', 'draft', 'archived')
BEGIN
  SELECT CASE
    WHEN NEW.type NOT IN ('email', 'questionnaire', 'contract', 'workflow')
      THEN RAISE(ABORT, 'template type must be canonical')
    WHEN NEW.name IS NULL OR trim(NEW.name) = '' OR NEW.name <> trim(NEW.name)
      THEN RAISE(ABORT, 'template name must be trimmed non-empty text')
    WHEN NEW.body IS NULL OR trim(NEW.body) = '' OR NEW.body <> trim(NEW.body)
      THEN RAISE(ABORT, 'template body must be trimmed non-empty text')
    ELSE RAISE(ABORT, 'template status must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_templates_identity_canon_update
BEFORE UPDATE OF type, name, body, status ON templates
FOR EACH ROW
WHEN NEW.type NOT IN ('email', 'questionnaire', 'contract', 'workflow')
  OR NEW.name IS NULL
  OR trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
  OR NEW.body IS NULL
  OR trim(NEW.body) = ''
  OR NEW.body <> trim(NEW.body)
  OR NEW.status NOT IN ('active', 'draft', 'archived')
BEGIN
  SELECT CASE
    WHEN NEW.type NOT IN ('email', 'questionnaire', 'contract', 'workflow')
      THEN RAISE(ABORT, 'template type must be canonical')
    WHEN NEW.name IS NULL OR trim(NEW.name) = '' OR NEW.name <> trim(NEW.name)
      THEN RAISE(ABORT, 'template name must be trimmed non-empty text')
    WHEN NEW.body IS NULL OR trim(NEW.body) = '' OR NEW.body <> trim(NEW.body)
      THEN RAISE(ABORT, 'template body must be trimmed non-empty text')
    ELSE RAISE(ABORT, 'template status must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_templates_detail_text_canon_insert
BEFORE INSERT ON templates
FOR EACH ROW
WHEN (NEW.trigger IS NOT NULL AND (trim(NEW.trigger) = '' OR NEW.trigger <> trim(NEW.trigger)))
  OR (NEW.subject IS NOT NULL AND (trim(NEW.subject) = '' OR NEW.subject <> trim(NEW.subject)))
BEGIN
  SELECT RAISE(ABORT, 'template detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_templates_detail_text_canon_update
BEFORE UPDATE OF trigger, subject ON templates
FOR EACH ROW
WHEN (NEW.trigger IS NOT NULL AND (trim(NEW.trigger) = '' OR NEW.trigger <> trim(NEW.trigger)))
  OR (NEW.subject IS NOT NULL AND (trim(NEW.subject) = '' OR NEW.subject <> trim(NEW.subject)))
BEGIN
  SELECT RAISE(ABORT, 'template detail text must be null or trimmed non-empty text');
END;
