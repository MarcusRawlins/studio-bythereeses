UPDATE questionnaire_questions
SET sort_order = sort_order + 4
WHERE questionnaire_id = 'questionnaire-photography-timeline-vision'
  AND sort_order >= 5
  AND NOT EXISTS (
    SELECT 1
    FROM questionnaire_questions
    WHERE id = 'questionnaire-photography-timeline-vision-native-bride-instagram'
  );

UPDATE questionnaire_questions
SET title = 'Bride''s full name',
  updated_at = CURRENT_TIMESTAMP
WHERE questionnaire_id = 'questionnaire-photography-timeline-vision'
  AND title = 'Bride''s Name & Instagram';

UPDATE questionnaire_questions
SET title = 'Bride''s email',
  sort_order = 3,
  updated_at = CURRENT_TIMESTAMP
WHERE questionnaire_id = 'questionnaire-photography-timeline-vision'
  AND title = 'Bride''s Email & Phone Number';

UPDATE questionnaire_questions
SET title = 'Groom''s full name',
  sort_order = 5,
  updated_at = CURRENT_TIMESTAMP
WHERE questionnaire_id = 'questionnaire-photography-timeline-vision'
  AND title = 'Groom''s Name & Instagram';

UPDATE questionnaire_questions
SET title = 'Groom''s email',
  sort_order = 7,
  updated_at = CURRENT_TIMESTAMP
WHERE questionnaire_id = 'questionnaire-photography-timeline-vision'
  AND title = 'Groom''s Email & Phone Number';

INSERT OR IGNORE INTO questionnaire_questions (
  id,
  questionnaire_id,
  title,
  description,
  type,
  required,
  options_json,
  sort_order,
  created_at,
  updated_at
) VALUES
  (
    'questionnaire-photography-timeline-vision-native-bride-instagram',
    'questionnaire-photography-timeline-vision',
    'Bride''s Instagram',
    'Used for client profile details and social/vendor tagging.',
    'short_text',
    0,
    NULL,
    2,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'questionnaire-photography-timeline-vision-native-bride-phone',
    'questionnaire-photography-timeline-vision',
    'Bride''s phone number',
    'Used for client contact details.',
    'short_text',
    0,
    NULL,
    4,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'questionnaire-photography-timeline-vision-native-groom-instagram',
    'questionnaire-photography-timeline-vision',
    'Groom''s Instagram',
    'Used for client profile details and social/vendor tagging.',
    'short_text',
    0,
    NULL,
    6,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'questionnaire-photography-timeline-vision-native-groom-phone',
    'questionnaire-photography-timeline-vision',
    'Groom''s phone number',
    'Used for client contact details.',
    'short_text',
    0,
    NULL,
    8,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );
