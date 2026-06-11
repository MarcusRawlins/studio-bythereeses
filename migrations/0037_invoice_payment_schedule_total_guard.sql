CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_schedule_total_insert
BEFORE INSERT ON invoice_payments
FOR EACH ROW
WHEN
  NEW.amount_cents < 0
  OR (
    SELECT COALESCE(SUM(amount_cents), 0)
    FROM invoice_payments
    WHERE invoice_id = NEW.invoice_id
  ) + NEW.amount_cents > COALESCE((
    SELECT total_cents
    FROM invoices
    WHERE id = NEW.invoice_id
  ), 0)
BEGIN
  SELECT RAISE(ABORT, 'invoice payment schedule exceeds invoice total');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_schedule_total_update
BEFORE UPDATE OF invoice_id, amount_cents ON invoice_payments
FOR EACH ROW
WHEN
  NEW.amount_cents < 0
  OR (
    SELECT COALESCE(SUM(amount_cents), 0)
    FROM invoice_payments
    WHERE invoice_id = NEW.invoice_id
      AND id <> OLD.id
  ) + NEW.amount_cents > COALESCE((
    SELECT total_cents
    FROM invoices
    WHERE id = NEW.invoice_id
  ), 0)
BEGIN
  SELECT RAISE(ABORT, 'invoice payment schedule exceeds invoice total');
END;
