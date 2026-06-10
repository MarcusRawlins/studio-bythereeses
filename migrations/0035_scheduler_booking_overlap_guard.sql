CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_confirmed_time
  ON scheduler_bookings(start_at, end_at)
  WHERE status = 'confirmed';

CREATE TRIGGER IF NOT EXISTS scheduler_bookings_no_confirmed_overlap_insert
BEFORE INSERT ON scheduler_bookings
WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'scheduler booking overlaps existing confirmed booking')
  WHERE EXISTS (
    SELECT 1
    FROM scheduler_bookings
    WHERE status = 'confirmed'
      AND NEW.start_at < end_at
      AND NEW.end_at > start_at
  );
END;

CREATE TRIGGER IF NOT EXISTS scheduler_bookings_no_confirmed_overlap_update
BEFORE UPDATE OF start_at, end_at, status ON scheduler_bookings
WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'scheduler booking overlaps existing confirmed booking')
  WHERE EXISTS (
    SELECT 1
    FROM scheduler_bookings
    WHERE id <> NEW.id
      AND status = 'confirmed'
      AND NEW.start_at < end_at
      AND NEW.end_at > start_at
  );
END;
