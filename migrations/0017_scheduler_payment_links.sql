ALTER TABLE scheduler_meeting_types ADD COLUMN stripe_payment_link TEXT;

CREATE INDEX IF NOT EXISTS idx_scheduler_meeting_types_collect_payment
  ON scheduler_meeting_types(collect_payment, is_active);
