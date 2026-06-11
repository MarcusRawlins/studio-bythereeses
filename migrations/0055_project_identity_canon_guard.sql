CREATE TRIGGER IF NOT EXISTS trg_projects_identity_canon_insert
BEFORE INSERT ON projects
FOR EACH ROW
WHEN trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
  OR trim(NEW.type) = ''
  OR NEW.type <> trim(NEW.type)
  OR NEW.stage NOT IN (
    'inquiry',
    'proposal_sent',
    'retainer_paid',
    'planning',
    'editing',
    'delivered',
    'completed'
  )
  OR NEW.status NOT IN ('active', 'on_hold', 'completed', 'archived')
BEGIN
  SELECT CASE
    WHEN trim(NEW.name) = ''
      OR NEW.name <> trim(NEW.name)
    THEN RAISE(ABORT, 'project name must be trimmed non-empty text')
    WHEN trim(NEW.type) = ''
      OR NEW.type <> trim(NEW.type)
    THEN RAISE(ABORT, 'project type must be trimmed non-empty text')
    WHEN NEW.stage NOT IN (
      'inquiry',
      'proposal_sent',
      'retainer_paid',
      'planning',
      'editing',
      'delivered',
      'completed'
    )
    THEN RAISE(ABORT, 'project stage must be canonical')
    ELSE RAISE(ABORT, 'project status must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_projects_identity_canon_update
BEFORE UPDATE OF name, type, stage, status ON projects
FOR EACH ROW
WHEN trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
  OR trim(NEW.type) = ''
  OR NEW.type <> trim(NEW.type)
  OR NEW.stage NOT IN (
    'inquiry',
    'proposal_sent',
    'retainer_paid',
    'planning',
    'editing',
    'delivered',
    'completed'
  )
  OR NEW.status NOT IN ('active', 'on_hold', 'completed', 'archived')
BEGIN
  SELECT CASE
    WHEN trim(NEW.name) = ''
      OR NEW.name <> trim(NEW.name)
    THEN RAISE(ABORT, 'project name must be trimmed non-empty text')
    WHEN trim(NEW.type) = ''
      OR NEW.type <> trim(NEW.type)
    THEN RAISE(ABORT, 'project type must be trimmed non-empty text')
    WHEN NEW.stage NOT IN (
      'inquiry',
      'proposal_sent',
      'retainer_paid',
      'planning',
      'editing',
      'delivered',
      'completed'
    )
    THEN RAISE(ABORT, 'project stage must be canonical')
    ELSE RAISE(ABORT, 'project status must be canonical')
  END;
END;
