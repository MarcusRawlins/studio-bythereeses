ALTER TABLE proposals ADD COLUMN source_type TEXT;
ALTER TABLE proposals ADD COLUMN source_id TEXT;

CREATE INDEX IF NOT EXISTS idx_proposals_source
  ON proposals(source_type, source_id);
