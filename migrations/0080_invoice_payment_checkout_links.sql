ALTER TABLE invoice_payments ADD COLUMN stripe_checkout_url TEXT;
ALTER TABLE invoice_payments ADD COLUMN stripe_checkout_session_id TEXT;
ALTER TABLE invoice_payments ADD COLUMN stripe_checkout_status TEXT NOT NULL DEFAULT 'not_created';

CREATE INDEX IF NOT EXISTS idx_invoice_payments_stripe_checkout_session
  ON invoice_payments(stripe_checkout_session_id);

CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_checkout_canon_insert
BEFORE INSERT ON invoice_payments
FOR EACH ROW
WHEN NEW.stripe_checkout_status NOT IN ('not_created', 'link_ready', 'paid', 'expired', 'void')
  OR (NEW.stripe_checkout_url IS NOT NULL AND (trim(NEW.stripe_checkout_url) = '' OR NEW.stripe_checkout_url <> trim(NEW.stripe_checkout_url)))
  OR (NEW.stripe_checkout_session_id IS NOT NULL AND (trim(NEW.stripe_checkout_session_id) = '' OR NEW.stripe_checkout_session_id <> trim(NEW.stripe_checkout_session_id)))
BEGIN
  SELECT CASE
    WHEN NEW.stripe_checkout_status NOT IN ('not_created', 'link_ready', 'paid', 'expired', 'void')
      THEN RAISE(ABORT, 'invoice payment checkout status must be canonical')
    ELSE RAISE(ABORT, 'invoice payment checkout fields must be null or trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_checkout_canon_update
BEFORE UPDATE OF stripe_checkout_url, stripe_checkout_session_id, stripe_checkout_status ON invoice_payments
FOR EACH ROW
WHEN NEW.stripe_checkout_status NOT IN ('not_created', 'link_ready', 'paid', 'expired', 'void')
  OR (NEW.stripe_checkout_url IS NOT NULL AND (trim(NEW.stripe_checkout_url) = '' OR NEW.stripe_checkout_url <> trim(NEW.stripe_checkout_url)))
  OR (NEW.stripe_checkout_session_id IS NOT NULL AND (trim(NEW.stripe_checkout_session_id) = '' OR NEW.stripe_checkout_session_id <> trim(NEW.stripe_checkout_session_id)))
BEGIN
  SELECT CASE
    WHEN NEW.stripe_checkout_status NOT IN ('not_created', 'link_ready', 'paid', 'expired', 'void')
      THEN RAISE(ABORT, 'invoice payment checkout status must be canonical')
    ELSE RAISE(ABORT, 'invoice payment checkout fields must be null or trimmed non-empty text')
  END;
END;
