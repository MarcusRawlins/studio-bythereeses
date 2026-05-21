CREATE TABLE IF NOT EXISTS questionnaires (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source_form_url TEXT,
  response_sheet_url TEXT,
  response_sheet_name TEXT,
  external_question_count INTEGER NOT NULL DEFAULT 0,
  last_response_count INTEGER NOT NULL DEFAULT 0,
  last_imported_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS questionnaire_questions (
  id TEXT PRIMARY KEY NOT NULL,
  questionnaire_id TEXT NOT NULL REFERENCES questionnaires(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL DEFAULT 'short_text',
  required INTEGER NOT NULL DEFAULT 0,
  options_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS questionnaire_responses (
  id TEXT PRIMARY KEY NOT NULL,
  questionnaire_id TEXT NOT NULL REFERENCES questionnaires(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  respondent_name TEXT,
  respondent_email TEXT,
  submitted_at TEXT,
  source_response_id TEXT,
  answers_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_questionnaires_status ON questionnaires(status);
CREATE INDEX IF NOT EXISTS idx_questionnaire_questions_questionnaire ON questionnaire_questions(questionnaire_id);
CREATE INDEX IF NOT EXISTS idx_questionnaire_questions_order ON questionnaire_questions(questionnaire_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_questionnaire_responses_questionnaire ON questionnaire_responses(questionnaire_id);
CREATE INDEX IF NOT EXISTS idx_questionnaire_responses_project ON questionnaire_responses(project_id);
CREATE INDEX IF NOT EXISTS idx_questionnaire_responses_client ON questionnaire_responses(client_id);
CREATE INDEX IF NOT EXISTS idx_questionnaire_responses_submitted ON questionnaire_responses(submitted_at);
