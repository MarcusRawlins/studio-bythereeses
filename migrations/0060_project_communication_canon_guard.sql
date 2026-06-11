CREATE TRIGGER IF NOT EXISTS trg_project_communications_identity_canon_insert
BEFORE INSERT ON project_communications
FOR EACH ROW
WHEN NEW.direction NOT IN ('outbound', 'inbound', 'internal')
  OR NEW.channel NOT IN ('email', 'sms', 'call', 'note')
  OR NEW.status NOT IN ('draft', 'queued', 'sent', 'archived')
  OR NEW.body IS NULL
  OR trim(NEW.body) = ''
  OR NEW.body <> trim(NEW.body)
BEGIN
  SELECT CASE
    WHEN NEW.direction NOT IN ('outbound', 'inbound', 'internal')
      THEN RAISE(ABORT, 'project communication direction must be canonical')
    WHEN NEW.channel NOT IN ('email', 'sms', 'call', 'note')
      THEN RAISE(ABORT, 'project communication channel must be canonical')
    WHEN NEW.status NOT IN ('draft', 'queued', 'sent', 'archived')
      THEN RAISE(ABORT, 'project communication status must be canonical')
    ELSE RAISE(ABORT, 'project communication body must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_communications_identity_canon_update
BEFORE UPDATE OF direction, channel, status, body ON project_communications
FOR EACH ROW
WHEN NEW.direction NOT IN ('outbound', 'inbound', 'internal')
  OR NEW.channel NOT IN ('email', 'sms', 'call', 'note')
  OR NEW.status NOT IN ('draft', 'queued', 'sent', 'archived')
  OR NEW.body IS NULL
  OR trim(NEW.body) = ''
  OR NEW.body <> trim(NEW.body)
BEGIN
  SELECT CASE
    WHEN NEW.direction NOT IN ('outbound', 'inbound', 'internal')
      THEN RAISE(ABORT, 'project communication direction must be canonical')
    WHEN NEW.channel NOT IN ('email', 'sms', 'call', 'note')
      THEN RAISE(ABORT, 'project communication channel must be canonical')
    WHEN NEW.status NOT IN ('draft', 'queued', 'sent', 'archived')
      THEN RAISE(ABORT, 'project communication status must be canonical')
    ELSE RAISE(ABORT, 'project communication body must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_communications_detail_text_canon_insert
BEFORE INSERT ON project_communications
FOR EACH ROW
WHEN (NEW.subject IS NOT NULL AND (trim(NEW.subject) = '' OR NEW.subject <> trim(NEW.subject)))
  OR (NEW.recipient_name IS NOT NULL AND (trim(NEW.recipient_name) = '' OR NEW.recipient_name <> trim(NEW.recipient_name)))
  OR (NEW.recipient_email IS NOT NULL AND (trim(NEW.recipient_email) = '' OR NEW.recipient_email <> trim(NEW.recipient_email) OR NEW.recipient_email <> lower(NEW.recipient_email)))
  OR (NEW.scheduled_for IS NOT NULL AND (trim(NEW.scheduled_for) = '' OR NEW.scheduled_for <> trim(NEW.scheduled_for)))
  OR (NEW.sent_at IS NOT NULL AND (trim(NEW.sent_at) = '' OR NEW.sent_at <> trim(NEW.sent_at)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
  OR (NEW.created_by IS NULL OR trim(NEW.created_by) = '' OR NEW.created_by <> trim(NEW.created_by))
BEGIN
  SELECT CASE
    WHEN NEW.recipient_email IS NOT NULL
      AND (trim(NEW.recipient_email) = '' OR NEW.recipient_email <> trim(NEW.recipient_email) OR NEW.recipient_email <> lower(NEW.recipient_email))
    THEN RAISE(ABORT, 'project communication recipient email must be lowercase and trimmed')
    ELSE RAISE(ABORT, 'project communication detail text must be null or trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_communications_detail_text_canon_update
BEFORE UPDATE OF subject, recipient_name, recipient_email, scheduled_for, sent_at, source_type, source_id, created_by ON project_communications
FOR EACH ROW
WHEN (NEW.subject IS NOT NULL AND (trim(NEW.subject) = '' OR NEW.subject <> trim(NEW.subject)))
  OR (NEW.recipient_name IS NOT NULL AND (trim(NEW.recipient_name) = '' OR NEW.recipient_name <> trim(NEW.recipient_name)))
  OR (NEW.recipient_email IS NOT NULL AND (trim(NEW.recipient_email) = '' OR NEW.recipient_email <> trim(NEW.recipient_email) OR NEW.recipient_email <> lower(NEW.recipient_email)))
  OR (NEW.scheduled_for IS NOT NULL AND (trim(NEW.scheduled_for) = '' OR NEW.scheduled_for <> trim(NEW.scheduled_for)))
  OR (NEW.sent_at IS NOT NULL AND (trim(NEW.sent_at) = '' OR NEW.sent_at <> trim(NEW.sent_at)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
  OR (NEW.created_by IS NULL OR trim(NEW.created_by) = '' OR NEW.created_by <> trim(NEW.created_by))
BEGIN
  SELECT CASE
    WHEN NEW.recipient_email IS NOT NULL
      AND (trim(NEW.recipient_email) = '' OR NEW.recipient_email <> trim(NEW.recipient_email) OR NEW.recipient_email <> lower(NEW.recipient_email))
    THEN RAISE(ABORT, 'project communication recipient email must be lowercase and trimmed')
    ELSE RAISE(ABORT, 'project communication detail text must be null or trimmed non-empty text')
  END;
END;
