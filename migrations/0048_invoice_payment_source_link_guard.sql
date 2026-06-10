CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_source_link_insert
BEFORE INSERT ON invoice_payments
FOR EACH ROW
WHEN (NEW.source_type IS NULL OR trim(NEW.source_type) = '')
  AND NEW.source_id IS NOT NULL
  AND trim(NEW.source_id) <> ''
BEGIN
  SELECT RAISE(ABORT, 'invoice payment source links require sourceType when sourceId is set');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_source_link_update
BEFORE UPDATE OF source_type, source_id ON invoice_payments
FOR EACH ROW
WHEN (NEW.source_type IS NULL OR trim(NEW.source_type) = '')
  AND NEW.source_id IS NOT NULL
  AND trim(NEW.source_id) <> ''
BEGIN
  SELECT RAISE(ABORT, 'invoice payment source links require sourceType when sourceId is set');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_project_source_insert
BEFORE INSERT ON invoice_payments
FOR EACH ROW
WHEN NEW.source_type = 'project_source'
  AND (
    NEW.invoice_id IS NULL
    OR trim(NEW.invoice_id) = ''
    OR NEW.source_id IS NULL
    OR trim(NEW.source_id) = ''
    OR NOT EXISTS (
      SELECT 1
      FROM invoices
      JOIN project_sources
        ON project_sources.id = NEW.source_id
       AND project_sources.project_id = invoices.project_id
      WHERE invoices.id = NEW.invoice_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invoice payment project_source links must point to a source in the invoice project');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_project_source_update
BEFORE UPDATE OF invoice_id, source_type, source_id ON invoice_payments
FOR EACH ROW
WHEN NEW.source_type = 'project_source'
  AND (
    NEW.invoice_id IS NULL
    OR trim(NEW.invoice_id) = ''
    OR NEW.source_id IS NULL
    OR trim(NEW.source_id) = ''
    OR NOT EXISTS (
      SELECT 1
      FROM invoices
      JOIN project_sources
        ON project_sources.id = NEW.source_id
       AND project_sources.project_id = invoices.project_id
      WHERE invoices.id = NEW.invoice_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invoice payment project_source links must point to a source in the invoice project');
END;
