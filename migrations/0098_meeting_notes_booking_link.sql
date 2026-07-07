-- 0098: Phase 20 structured meeting/consult notes. Additive, nullable, non-breaking.
-- Links a project_communications "note" channel row to the scheduler_bookings row it was taken
-- during (a consult call). NULL for every existing row and for any note not tied to a specific
-- meeting (e.g. a general project note) — unchanged behavior.
ALTER TABLE project_communications ADD COLUMN booking_id TEXT;

CREATE INDEX IF NOT EXISTS idx_project_communications_booking_id ON project_communications(booking_id);
