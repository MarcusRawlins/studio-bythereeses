ALTER TABLE scheduler_bookings ADD COLUMN payment_source_type TEXT;
ALTER TABLE scheduler_bookings ADD COLUMN payment_source_id TEXT;

CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_payment_source
  ON scheduler_bookings(payment_source_type, payment_source_id);
