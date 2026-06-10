CREATE TRIGGER IF NOT EXISTS trg_questionnaires_identity_canon_insert
BEFORE INSERT ON questionnaires
FOR EACH ROW
WHEN NEW.title IS NULL
  OR trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR NEW.status NOT IN ('active', 'draft', 'archived')
  OR NEW.external_question_count < 0
  OR NEW.last_response_count < 0
BEGIN
  SELECT CASE
    WHEN NEW.title IS NULL OR trim(NEW.title) = '' OR NEW.title <> trim(NEW.title)
      THEN RAISE(ABORT, 'questionnaire title must be trimmed non-empty text')
    WHEN NEW.status NOT IN ('active', 'draft', 'archived')
      THEN RAISE(ABORT, 'questionnaire status must be canonical')
    ELSE RAISE(ABORT, 'questionnaire counts must be canonical non-negative integers')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_questionnaires_identity_canon_update
BEFORE UPDATE OF title, status, external_question_count, last_response_count ON questionnaires
FOR EACH ROW
WHEN NEW.title IS NULL
  OR trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR NEW.status NOT IN ('active', 'draft', 'archived')
  OR NEW.external_question_count < 0
  OR NEW.last_response_count < 0
BEGIN
  SELECT CASE
    WHEN NEW.title IS NULL OR trim(NEW.title) = '' OR NEW.title <> trim(NEW.title)
      THEN RAISE(ABORT, 'questionnaire title must be trimmed non-empty text')
    WHEN NEW.status NOT IN ('active', 'draft', 'archived')
      THEN RAISE(ABORT, 'questionnaire status must be canonical')
    ELSE RAISE(ABORT, 'questionnaire counts must be canonical non-negative integers')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_questionnaires_detail_text_canon_insert
BEFORE INSERT ON questionnaires
FOR EACH ROW
WHEN (NEW.description IS NOT NULL AND (trim(NEW.description) = '' OR NEW.description <> trim(NEW.description)))
  OR (NEW.source_form_url IS NOT NULL AND (trim(NEW.source_form_url) = '' OR NEW.source_form_url <> trim(NEW.source_form_url)))
  OR (NEW.response_sheet_url IS NOT NULL AND (trim(NEW.response_sheet_url) = '' OR NEW.response_sheet_url <> trim(NEW.response_sheet_url)))
  OR (NEW.response_sheet_name IS NOT NULL AND (trim(NEW.response_sheet_name) = '' OR NEW.response_sheet_name <> trim(NEW.response_sheet_name)))
  OR (NEW.last_imported_at IS NOT NULL AND (trim(NEW.last_imported_at) = '' OR NEW.last_imported_at <> trim(NEW.last_imported_at)))
BEGIN
  SELECT RAISE(ABORT, 'questionnaire detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_questionnaires_detail_text_canon_update
BEFORE UPDATE OF description, source_form_url, response_sheet_url, response_sheet_name, last_imported_at ON questionnaires
FOR EACH ROW
WHEN (NEW.description IS NOT NULL AND (trim(NEW.description) = '' OR NEW.description <> trim(NEW.description)))
  OR (NEW.source_form_url IS NOT NULL AND (trim(NEW.source_form_url) = '' OR NEW.source_form_url <> trim(NEW.source_form_url)))
  OR (NEW.response_sheet_url IS NOT NULL AND (trim(NEW.response_sheet_url) = '' OR NEW.response_sheet_url <> trim(NEW.response_sheet_url)))
  OR (NEW.response_sheet_name IS NOT NULL AND (trim(NEW.response_sheet_name) = '' OR NEW.response_sheet_name <> trim(NEW.response_sheet_name)))
  OR (NEW.last_imported_at IS NOT NULL AND (trim(NEW.last_imported_at) = '' OR NEW.last_imported_at <> trim(NEW.last_imported_at)))
BEGIN
  SELECT RAISE(ABORT, 'questionnaire detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_questionnaire_questions_identity_canon_insert
BEFORE INSERT ON questionnaire_questions
FOR EACH ROW
WHEN NEW.title IS NULL
  OR trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR NEW.type NOT IN ('section', 'short_text', 'paragraph', 'multiple_choice', 'checkboxes', 'dropdown', 'linear_scale')
  OR NEW.required NOT IN (0, 1)
  OR NEW.sort_order < 0
BEGIN
  SELECT CASE
    WHEN NEW.title IS NULL OR trim(NEW.title) = '' OR NEW.title <> trim(NEW.title)
      THEN RAISE(ABORT, 'questionnaire question title must be trimmed non-empty text')
    WHEN NEW.type NOT IN ('section', 'short_text', 'paragraph', 'multiple_choice', 'checkboxes', 'dropdown', 'linear_scale')
      THEN RAISE(ABORT, 'questionnaire question type must be canonical')
    WHEN NEW.required NOT IN (0, 1)
      THEN RAISE(ABORT, 'questionnaire question required flag must be canonical')
    ELSE RAISE(ABORT, 'questionnaire question sort order must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_questionnaire_questions_identity_canon_update
BEFORE UPDATE OF title, type, required, sort_order ON questionnaire_questions
FOR EACH ROW
WHEN NEW.title IS NULL
  OR trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR NEW.type NOT IN ('section', 'short_text', 'paragraph', 'multiple_choice', 'checkboxes', 'dropdown', 'linear_scale')
  OR NEW.required NOT IN (0, 1)
  OR NEW.sort_order < 0
BEGIN
  SELECT CASE
    WHEN NEW.title IS NULL OR trim(NEW.title) = '' OR NEW.title <> trim(NEW.title)
      THEN RAISE(ABORT, 'questionnaire question title must be trimmed non-empty text')
    WHEN NEW.type NOT IN ('section', 'short_text', 'paragraph', 'multiple_choice', 'checkboxes', 'dropdown', 'linear_scale')
      THEN RAISE(ABORT, 'questionnaire question type must be canonical')
    WHEN NEW.required NOT IN (0, 1)
      THEN RAISE(ABORT, 'questionnaire question required flag must be canonical')
    ELSE RAISE(ABORT, 'questionnaire question sort order must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_questionnaire_questions_detail_text_canon_insert
BEFORE INSERT ON questionnaire_questions
FOR EACH ROW
WHEN NEW.description IS NOT NULL
  AND (trim(NEW.description) = '' OR NEW.description <> trim(NEW.description))
BEGIN
  SELECT RAISE(ABORT, 'questionnaire question detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_questionnaire_questions_detail_text_canon_update
BEFORE UPDATE OF description ON questionnaire_questions
FOR EACH ROW
WHEN NEW.description IS NOT NULL
  AND (trim(NEW.description) = '' OR NEW.description <> trim(NEW.description))
BEGIN
  SELECT RAISE(ABORT, 'questionnaire question detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_questionnaire_questions_options_canon_insert
BEFORE INSERT ON questionnaire_questions
FOR EACH ROW
WHEN NEW.options_json IS NOT NULL
  AND (
    trim(NEW.options_json) = ''
    OR NEW.options_json <> trim(NEW.options_json)
    OR json_valid(NEW.options_json) = 0
    OR json_type(NEW.options_json) <> 'array'
  )
BEGIN
  SELECT RAISE(ABORT, 'questionnaire question options must be null or canonical json array text');
END;

CREATE TRIGGER IF NOT EXISTS trg_questionnaire_questions_options_canon_update
BEFORE UPDATE OF options_json ON questionnaire_questions
FOR EACH ROW
WHEN NEW.options_json IS NOT NULL
  AND (
    trim(NEW.options_json) = ''
    OR NEW.options_json <> trim(NEW.options_json)
    OR json_valid(NEW.options_json) = 0
    OR json_type(NEW.options_json) <> 'array'
  )
BEGIN
  SELECT RAISE(ABORT, 'questionnaire question options must be null or canonical json array text');
END;
