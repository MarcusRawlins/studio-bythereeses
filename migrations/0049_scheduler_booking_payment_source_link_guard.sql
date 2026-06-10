CREATE TRIGGER IF NOT EXISTS trg_scheduler_bookings_payment_source_link_insert
BEFORE INSERT ON scheduler_bookings
FOR EACH ROW
WHEN (NEW.payment_source_type IS NULL OR trim(NEW.payment_source_type) = '')
  AND NEW.payment_source_id IS NOT NULL
  AND trim(NEW.payment_source_id) <> ''
BEGIN
  SELECT RAISE(ABORT, 'scheduler booking payment source links require sourceType when sourceId is set');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_bookings_payment_source_link_update
BEFORE UPDATE OF payment_source_type, payment_source_id ON scheduler_bookings
FOR EACH ROW
WHEN (NEW.payment_source_type IS NULL OR trim(NEW.payment_source_type) = '')
  AND NEW.payment_source_id IS NOT NULL
  AND trim(NEW.payment_source_id) <> ''
BEGIN
  SELECT RAISE(ABORT, 'scheduler booking payment source links require sourceType when sourceId is set');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_bookings_project_payment_source_insert
BEFORE INSERT ON scheduler_bookings
FOR EACH ROW
WHEN NEW.payment_source_type = 'project_source'
  AND (
    NEW.project_id IS NULL
    OR trim(NEW.project_id) = ''
    OR NEW.payment_source_id IS NULL
    OR trim(NEW.payment_source_id) = ''
    OR NOT EXISTS (
      SELECT 1
      FROM project_sources
      WHERE project_sources.id = NEW.payment_source_id
        AND project_sources.project_id = NEW.project_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'scheduler booking payment project_source links must point to a source in the same project');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_bookings_project_payment_source_update
BEFORE UPDATE OF project_id, payment_source_type, payment_source_id ON scheduler_bookings
FOR EACH ROW
WHEN NEW.payment_source_type = 'project_source'
  AND (
    NEW.project_id IS NULL
    OR trim(NEW.project_id) = ''
    OR NEW.payment_source_id IS NULL
    OR trim(NEW.payment_source_id) = ''
    OR NOT EXISTS (
      SELECT 1
      FROM project_sources
      WHERE project_sources.id = NEW.payment_source_id
        AND project_sources.project_id = NEW.project_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'scheduler booking payment project_source links must point to a source in the same project');
END;
