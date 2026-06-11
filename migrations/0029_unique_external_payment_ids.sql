CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_payments_external_payment_unique
  ON invoice_payments(external_payment_id)
  WHERE external_payment_id IS NOT NULL AND external_payment_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduler_bookings_external_payment_unique
  ON scheduler_bookings(external_payment_id)
  WHERE external_payment_id IS NOT NULL AND external_payment_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_external_payment_unique
  ON expenses(external_payment_id)
  WHERE external_payment_id IS NOT NULL AND external_payment_id <> '';
