CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_paid_amount_insert
BEFORE INSERT ON invoice_payments
FOR EACH ROW
WHEN NEW.paid_amount_cents < 0 OR NEW.paid_amount_cents > NEW.amount_cents
BEGIN
  SELECT RAISE(ABORT, 'invoice payment paid amount exceeds scheduled amount');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_paid_amount_update
BEFORE UPDATE OF amount_cents, paid_amount_cents ON invoice_payments
FOR EACH ROW
WHEN NEW.paid_amount_cents < 0 OR NEW.paid_amount_cents > NEW.amount_cents
BEGIN
  SELECT RAISE(ABORT, 'invoice payment paid amount exceeds scheduled amount');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_paid_state_insert
BEFORE INSERT ON invoices
FOR EACH ROW
WHEN
  NEW.amount_paid_cents < 0
  OR NEW.amount_paid_cents > NEW.total_cents
  OR (NEW.status = 'paid' AND (NEW.total_cents <= 0 OR NEW.amount_paid_cents < NEW.total_cents))
  OR (NEW.status = 'partially_paid' AND (NEW.amount_paid_cents <= 0 OR NEW.amount_paid_cents >= NEW.total_cents))
BEGIN
  SELECT RAISE(ABORT, 'invoice paid state does not match paid amount');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_paid_state_update
BEFORE UPDATE OF status, total_cents, amount_paid_cents ON invoices
FOR EACH ROW
WHEN
  NEW.amount_paid_cents < 0
  OR NEW.amount_paid_cents > NEW.total_cents
  OR (NEW.status = 'paid' AND (NEW.total_cents <= 0 OR NEW.amount_paid_cents < NEW.total_cents))
  OR (NEW.status = 'partially_paid' AND (NEW.amount_paid_cents <= 0 OR NEW.amount_paid_cents >= NEW.total_cents))
BEGIN
  SELECT RAISE(ABORT, 'invoice paid state does not match paid amount');
END;
