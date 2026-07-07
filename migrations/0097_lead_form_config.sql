-- 0097: Phase 19 embeddable lead-form config. Additive (a bare ADD COLUMN — D1 tracks applied
-- migrations, and local dev uses addColumnIfMissing in src/db/client.ts, so it is not re-run).
-- NON-CANONICAL: this column holds a display/config artifact; losing it reverts to code defaults,
-- no business state.
ALTER TABLE app_settings ADD COLUMN lead_form_config_json TEXT;
