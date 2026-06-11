CREATE UNIQUE INDEX IF NOT EXISTS idx_project_participants_unique_project_client
  ON project_participants(project_id, client_id);

CREATE INDEX IF NOT EXISTS idx_project_participants_project_primary
  ON project_participants(project_id, is_primary_contact);

CREATE INDEX IF NOT EXISTS idx_questionnaire_responses_project_client
  ON questionnaire_responses(project_id, client_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_project_client
  ON scheduler_bookings(project_id, client_id, start_at);

CREATE INDEX IF NOT EXISTS idx_proposals_project_status_created
  ON proposals(project_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_invoices_project_status_due
  ON invoices(project_id, status, due_date);

CREATE INDEX IF NOT EXISTS idx_activity_logs_project_created
  ON activity_logs(project_id, created_at);
