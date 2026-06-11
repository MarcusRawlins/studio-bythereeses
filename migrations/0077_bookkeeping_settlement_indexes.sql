CREATE INDEX IF NOT EXISTS idx_invoice_payments_status_paid
  ON invoice_payments(status, paid_at);

CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_payment_status_paid
  ON scheduler_bookings(payment_status, paid_at);

CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_project_payment
  ON scheduler_bookings(project_id, payment_status, paid_at);

CREATE INDEX IF NOT EXISTS idx_expenses_status_paid
  ON expenses(status, paid_at);
