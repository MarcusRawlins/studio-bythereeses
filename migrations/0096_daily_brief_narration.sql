-- Phase 18 — AI daily brief narration cache (dark behind DAILY_BRIEF_ENABLED). NON-CANONICAL,
-- current-state, one row per day, styled identically to job_runs (schema.ts:638-646): safe to
-- lose, upserted by day_key, never a business record. See docs/specs/phase-18-ai-daily-brief.md §3.3.
CREATE TABLE IF NOT EXISTS daily_brief_narrations (
  day_key       TEXT PRIMARY KEY NOT NULL,  -- YYYY-MM-DD in America/New_York
  narrative     TEXT NOT NULL,              -- agent-composed prose, capped (see route.ts)
  generated_at  TEXT NOT NULL
);
