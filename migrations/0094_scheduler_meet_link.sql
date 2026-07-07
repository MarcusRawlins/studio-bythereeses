-- CR-4: per-booking auto-generated Google Meet links. Additive + idempotent.
-- Dark behind SCHEDULER_MEET_LINKS flag (checked in app code, not here) — this column
-- is simply unused (NULL) until the flag is on and a booking's meeting type has
-- locationType = 'google_meet'. No enum/constraint change: "google_meet" is just a new
-- accepted value for the existing scheduler_meeting_types.location_type free-text column.
ALTER TABLE scheduler_bookings ADD COLUMN meeting_join_url TEXT;
