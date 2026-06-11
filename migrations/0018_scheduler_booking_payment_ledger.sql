ALTER TABLE scheduler_bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE scheduler_bookings ADD COLUMN payment_method TEXT;
ALTER TABLE scheduler_bookings ADD COLUMN paid_at TEXT;
ALTER TABLE scheduler_bookings ADD COLUMN paid_amount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_bookings ADD COLUMN client_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_bookings ADD COLUMN processing_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_bookings ADD COLUMN gross_collected_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_bookings ADD COLUMN net_deposit_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_bookings ADD COLUMN external_payment_id TEXT;
ALTER TABLE scheduler_bookings ADD COLUMN payment_link TEXT;
ALTER TABLE scheduler_bookings ADD COLUMN payment_notes TEXT;

UPDATE scheduler_bookings
SET payment_link = (
  SELECT scheduler_meeting_types.stripe_payment_link
  FROM scheduler_meeting_types
  WHERE scheduler_meeting_types.id = scheduler_bookings.meeting_type_id
)
WHERE payment_link IS NULL;

CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_payment_status_paid ON scheduler_bookings(payment_status, paid_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_external_payment ON scheduler_bookings(external_payment_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_project_payment ON scheduler_bookings(project_id, payment_status, paid_at);
