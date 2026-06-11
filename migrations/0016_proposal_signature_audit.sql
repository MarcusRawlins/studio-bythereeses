ALTER TABLE proposals ADD COLUMN signature_ip TEXT;
ALTER TABLE proposals ADD COLUMN signature_user_agent TEXT;
ALTER TABLE proposals ADD COLUMN signature_consent_text TEXT;
ALTER TABLE proposals ADD COLUMN signature_consent_version TEXT;
ALTER TABLE proposals ADD COLUMN selected_optional_line_item_ids_json TEXT;

CREATE INDEX IF NOT EXISTS idx_proposals_signed_at
  ON proposals(signed_at);
