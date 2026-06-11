DROP TRIGGER IF EXISTS trg_templates_identity_canon_insert;
DROP TRIGGER IF EXISTS trg_templates_identity_canon_update;

CREATE TRIGGER IF NOT EXISTS trg_templates_identity_canon_insert
BEFORE INSERT ON templates
FOR EACH ROW
WHEN NEW.type NOT IN ('email', 'questionnaire', 'contract', 'proposal_package', 'workflow', 'reminder')
  OR NEW.name IS NULL
  OR trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
  OR NEW.body IS NULL
  OR trim(NEW.body) = ''
  OR NEW.body <> trim(NEW.body)
  OR NEW.status NOT IN ('active', 'draft', 'archived')
BEGIN
  SELECT CASE
    WHEN NEW.type NOT IN ('email', 'questionnaire', 'contract', 'proposal_package', 'workflow', 'reminder')
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
WHEN NEW.type NOT IN ('email', 'questionnaire', 'contract', 'proposal_package', 'workflow', 'reminder')
  OR NEW.name IS NULL
  OR trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
  OR NEW.body IS NULL
  OR trim(NEW.body) = ''
  OR NEW.body <> trim(NEW.body)
  OR NEW.status NOT IN ('active', 'draft', 'archived')
BEGIN
  SELECT CASE
    WHEN NEW.type NOT IN ('email', 'questionnaire', 'contract', 'proposal_package', 'workflow', 'reminder')
      THEN RAISE(ABORT, 'template type must be canonical')
    WHEN NEW.name IS NULL OR trim(NEW.name) = '' OR NEW.name <> trim(NEW.name)
      THEN RAISE(ABORT, 'template name must be trimmed non-empty text')
    WHEN NEW.body IS NULL OR trim(NEW.body) = '' OR NEW.body <> trim(NEW.body)
      THEN RAISE(ABORT, 'template body must be trimmed non-empty text')
    ELSE RAISE(ABORT, 'template status must be canonical')
  END;
END;
