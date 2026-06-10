CREATE UNIQUE INDEX IF NOT EXISTS idx_questionnaire_responses_project_client_unique
  ON questionnaire_responses(questionnaire_id, project_id, COALESCE(client_id, ''))
  WHERE project_id IS NOT NULL;
