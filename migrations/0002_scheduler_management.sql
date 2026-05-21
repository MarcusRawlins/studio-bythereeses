ALTER TABLE scheduler_bookings ADD COLUMN cancelled_at TEXT;
ALTER TABLE scheduler_bookings ADD COLUMN cancellation_reason TEXT;
ALTER TABLE scheduler_bookings ADD COLUMN rescheduled_from_booking_id TEXT;
ALTER TABLE scheduler_bookings ADD COLUMN reminder_sent_at TEXT;
ALTER TABLE scheduler_bookings ADD COLUMN google_calendar_id TEXT;

CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_status_start
  ON scheduler_bookings(status, start_at);

CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_client
  ON scheduler_bookings(client_id);

CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_project
  ON scheduler_bookings(project_id);
