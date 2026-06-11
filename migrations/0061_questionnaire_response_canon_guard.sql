CREATE TRIGGER IF NOT EXISTS trg_questionnaire_responses_answers_canon_insert
BEFORE INSERT ON questionnaire_responses
FOR EACH ROW
WHEN NEW.answers_json IS NULL
  OR trim(NEW.answers_json) = ''
  OR NEW.answers_json <> trim(NEW.answers_json)
  OR json_valid(NEW.answers_json) = 0
  OR json_type(NEW.answers_json) <> 'array'
BEGIN
  SELECT RAISE(ABORT, 'questionnaire response answers must be canonical json array text');
END;

CREATE TRIGGER IF NOT EXISTS trg_questionnaire_responses_answers_canon_update
BEFORE UPDATE OF answers_json ON questionnaire_responses
FOR EACH ROW
WHEN NEW.answers_json IS NULL
  OR trim(NEW.answers_json) = ''
  OR NEW.answers_json <> trim(NEW.answers_json)
  OR json_valid(NEW.answers_json) = 0
  OR json_type(NEW.answers_json) <> 'array'
BEGIN
  SELECT RAISE(ABORT, 'questionnaire response answers must be canonical json array text');
END;

CREATE TRIGGER IF NOT EXISTS trg_questionnaire_responses_detail_text_canon_insert
BEFORE INSERT ON questionnaire_responses
FOR EACH ROW
WHEN (NEW.respondent_name IS NOT NULL AND (trim(NEW.respondent_name) = '' OR NEW.respondent_name <> trim(NEW.respondent_name)))
  OR (NEW.respondent_email IS NOT NULL AND (trim(NEW.respondent_email) = '' OR NEW.respondent_email <> trim(NEW.respondent_email) OR NEW.respondent_email <> lower(NEW.respondent_email)))
  OR (NEW.submitted_at IS NOT NULL AND (trim(NEW.submitted_at) = '' OR NEW.submitted_at <> trim(NEW.submitted_at)))
  OR (NEW.source_response_id IS NOT NULL AND (trim(NEW.source_response_id) = '' OR NEW.source_response_id <> trim(NEW.source_response_id)))
BEGIN
  SELECT CASE
    WHEN NEW.respondent_email IS NOT NULL
      AND (trim(NEW.respondent_email) = '' OR NEW.respondent_email <> trim(NEW.respondent_email) OR NEW.respondent_email <> lower(NEW.respondent_email))
    THEN RAISE(ABORT, 'questionnaire response respondent email must be lowercase and trimmed')
    ELSE RAISE(ABORT, 'questionnaire response detail text must be null or trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_questionnaire_responses_detail_text_canon_update
BEFORE UPDATE OF respondent_name, respondent_email, submitted_at, source_response_id ON questionnaire_responses
FOR EACH ROW
WHEN (NEW.respondent_name IS NOT NULL AND (trim(NEW.respondent_name) = '' OR NEW.respondent_name <> trim(NEW.respondent_name)))
  OR (NEW.respondent_email IS NOT NULL AND (trim(NEW.respondent_email) = '' OR NEW.respondent_email <> trim(NEW.respondent_email) OR NEW.respondent_email <> lower(NEW.respondent_email)))
  OR (NEW.submitted_at IS NOT NULL AND (trim(NEW.submitted_at) = '' OR NEW.submitted_at <> trim(NEW.submitted_at)))
  OR (NEW.source_response_id IS NOT NULL AND (trim(NEW.source_response_id) = '' OR NEW.source_response_id <> trim(NEW.source_response_id)))
BEGIN
  SELECT CASE
    WHEN NEW.respondent_email IS NOT NULL
      AND (trim(NEW.respondent_email) = '' OR NEW.respondent_email <> trim(NEW.respondent_email) OR NEW.respondent_email <> lower(NEW.respondent_email))
    THEN RAISE(ABORT, 'questionnaire response respondent email must be lowercase and trimmed')
    ELSE RAISE(ABORT, 'questionnaire response detail text must be null or trimmed non-empty text')
  END;
END;
