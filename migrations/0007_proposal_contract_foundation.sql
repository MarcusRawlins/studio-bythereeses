ALTER TABLE proposals ADD COLUMN contract_template_id TEXT;
ALTER TABLE proposals ADD COLUMN contract_title TEXT;
ALTER TABLE proposals ADD COLUMN contract_body TEXT;

CREATE INDEX IF NOT EXISTS idx_templates_type_status ON templates(type, status);
