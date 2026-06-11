ALTER TABLE invoice_payments ADD COLUMN source_type TEXT;
ALTER TABLE invoice_payments ADD COLUMN source_id TEXT;

CREATE INDEX IF NOT EXISTS idx_invoice_payments_source
  ON invoice_payments(source_type, source_id);
