-- Phase 10 — intelligence/forecasting admin settings. Additive + idempotent.
-- Reports-only; safe code defaults apply when NULL. app_settings is read on
-- always-on paths, so this migration is DEPLOY-ORDER-CRITICAL (apply before Worker).
ALTER TABLE app_settings ADD COLUMN forecast_horizon_months INTEGER;      -- code default 3
ALTER TABLE app_settings ADD COLUMN forecast_trailing_months INTEGER;     -- code default 6
ALTER TABLE app_settings ADD COLUMN monthly_capacity_target INTEGER;      -- code default NULL (no target)
ALTER TABLE app_settings ADD COLUMN lead_source_taxonomy_json TEXT;       -- code default '{}' (identity map)
