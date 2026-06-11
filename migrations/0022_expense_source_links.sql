ALTER TABLE expenses ADD COLUMN source_type TEXT;
ALTER TABLE expenses ADD COLUMN source_id TEXT;

CREATE INDEX IF NOT EXISTS idx_expenses_source
  ON expenses(source_type, source_id);
