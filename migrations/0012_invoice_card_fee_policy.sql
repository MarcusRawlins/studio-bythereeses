ALTER TABLE invoices ADD COLUMN card_fee_policy TEXT NOT NULL DEFAULT 'studio_absorbs';
ALTER TABLE invoices ADD COLUMN card_fee_percent_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN card_fee_fixed_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN card_fee_amount_cents INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_invoices_card_fee_policy
  ON invoices(card_fee_policy);
