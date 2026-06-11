ALTER TABLE invoice_payments ADD COLUMN paid_amount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_payments ADD COLUMN client_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_payments ADD COLUMN processing_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_payments ADD COLUMN gross_collected_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_payments ADD COLUMN net_deposit_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_payments ADD COLUMN external_payment_id TEXT;

UPDATE invoice_payments
SET
  paid_amount_cents = CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END,
  gross_collected_cents = CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END,
  net_deposit_cents = CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END
WHERE paid_amount_cents = 0
  AND client_fee_cents = 0
  AND processing_fee_cents = 0
  AND gross_collected_cents = 0
  AND net_deposit_cents = 0;

CREATE INDEX IF NOT EXISTS idx_invoice_payments_status_paid
  ON invoice_payments(status, paid_at);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_external_payment
  ON invoice_payments(external_payment_id);
