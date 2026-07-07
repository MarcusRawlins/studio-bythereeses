-- 0095: Phase 23 questionnaire autofill review-and-apply. Additive + idempotent. NON-CANONICAL:
-- these columns hold a review artifact + an optional mapping hint; losing them loses no business state.
ALTER TABLE questionnaire_responses ADD COLUMN suggested_changes_json TEXT;
ALTER TABLE questionnaire_responses ADD COLUMN suggested_changes_computed_at TEXT;
ALTER TABLE questionnaire_questions ADD COLUMN semantic_key TEXT;
