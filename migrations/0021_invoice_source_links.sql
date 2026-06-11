ALTER TABLE invoices ADD COLUMN source_type TEXT;
ALTER TABLE invoices ADD COLUMN source_id TEXT;

CREATE INDEX IF NOT EXISTS idx_invoices_source
  ON invoices(source_type, source_id);
