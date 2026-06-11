CREATE INDEX IF NOT EXISTS idx_project_timeline_items_project_source
  ON project_timeline_items(project_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_project_sources_project_source
  ON project_sources(project_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_project_communications_project_source
  ON project_communications(project_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_proposals_project_source
  ON proposals(project_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_invoices_project_source
  ON invoices(project_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice_source
  ON invoice_payments(invoice_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_project_payment_source
  ON scheduler_bookings(project_id, payment_source_type, payment_source_id);

CREATE INDEX IF NOT EXISTS idx_expenses_project_source
  ON expenses(project_id, source_type, source_id);
