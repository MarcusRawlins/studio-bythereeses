CREATE TRIGGER IF NOT EXISTS trg_scheduler_bookings_identity_canon_insert
BEFORE INSERT ON scheduler_bookings
FOR EACH ROW
WHEN NEW.attendee_name IS NULL
  OR trim(NEW.attendee_name) = ''
  OR NEW.attendee_name <> trim(NEW.attendee_name)
  OR NEW.attendee_email IS NULL
  OR trim(NEW.attendee_email) = ''
  OR NEW.attendee_email <> trim(NEW.attendee_email)
  OR NEW.attendee_email <> lower(NEW.attendee_email)
  OR NEW.start_at IS NULL
  OR trim(NEW.start_at) = ''
  OR NEW.start_at <> trim(NEW.start_at)
  OR NEW.end_at IS NULL
  OR trim(NEW.end_at) = ''
  OR NEW.end_at <> trim(NEW.end_at)
  OR NEW.end_at <= NEW.start_at
  OR NEW.status NOT IN ('confirmed', 'cancelled')
  OR NEW.source IS NULL
  OR trim(NEW.source) = ''
  OR NEW.source <> trim(NEW.source)
  OR NEW.calendar_sync_status NOT IN ('not_connected', 'local_only', 'synced', 'sync_failed', 'cancelled')
  OR NEW.sms_opt_in NOT IN (0, 1)
BEGIN
  SELECT CASE
    WHEN NEW.attendee_name IS NULL OR trim(NEW.attendee_name) = '' OR NEW.attendee_name <> trim(NEW.attendee_name)
      THEN RAISE(ABORT, 'scheduler booking attendee name must be trimmed non-empty text')
    WHEN NEW.attendee_email IS NULL
      OR trim(NEW.attendee_email) = ''
      OR NEW.attendee_email <> trim(NEW.attendee_email)
      OR NEW.attendee_email <> lower(NEW.attendee_email)
      THEN RAISE(ABORT, 'scheduler booking attendee email must be lowercase and trimmed')
    WHEN NEW.start_at IS NULL
      OR trim(NEW.start_at) = ''
      OR NEW.start_at <> trim(NEW.start_at)
      OR NEW.end_at IS NULL
      OR trim(NEW.end_at) = ''
      OR NEW.end_at <> trim(NEW.end_at)
      OR NEW.end_at <= NEW.start_at
      THEN RAISE(ABORT, 'scheduler booking time window must be canonical')
    WHEN NEW.status NOT IN ('confirmed', 'cancelled')
      THEN RAISE(ABORT, 'scheduler booking status must be canonical')
    WHEN NEW.source IS NULL OR trim(NEW.source) = '' OR NEW.source <> trim(NEW.source)
      THEN RAISE(ABORT, 'scheduler booking source must be trimmed non-empty text')
    WHEN NEW.calendar_sync_status NOT IN ('not_connected', 'local_only', 'synced', 'sync_failed', 'cancelled')
      THEN RAISE(ABORT, 'scheduler booking calendar sync status must be canonical')
    ELSE RAISE(ABORT, 'scheduler booking sms opt-in must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_bookings_identity_canon_update
BEFORE UPDATE OF attendee_name, attendee_email, start_at, end_at, status, source, calendar_sync_status, sms_opt_in ON scheduler_bookings
FOR EACH ROW
WHEN NEW.attendee_name IS NULL
  OR trim(NEW.attendee_name) = ''
  OR NEW.attendee_name <> trim(NEW.attendee_name)
  OR NEW.attendee_email IS NULL
  OR trim(NEW.attendee_email) = ''
  OR NEW.attendee_email <> trim(NEW.attendee_email)
  OR NEW.attendee_email <> lower(NEW.attendee_email)
  OR NEW.start_at IS NULL
  OR trim(NEW.start_at) = ''
  OR NEW.start_at <> trim(NEW.start_at)
  OR NEW.end_at IS NULL
  OR trim(NEW.end_at) = ''
  OR NEW.end_at <> trim(NEW.end_at)
  OR NEW.end_at <= NEW.start_at
  OR NEW.status NOT IN ('confirmed', 'cancelled')
  OR NEW.source IS NULL
  OR trim(NEW.source) = ''
  OR NEW.source <> trim(NEW.source)
  OR NEW.calendar_sync_status NOT IN ('not_connected', 'local_only', 'synced', 'sync_failed', 'cancelled')
  OR NEW.sms_opt_in NOT IN (0, 1)
BEGIN
  SELECT CASE
    WHEN NEW.attendee_name IS NULL OR trim(NEW.attendee_name) = '' OR NEW.attendee_name <> trim(NEW.attendee_name)
      THEN RAISE(ABORT, 'scheduler booking attendee name must be trimmed non-empty text')
    WHEN NEW.attendee_email IS NULL
      OR trim(NEW.attendee_email) = ''
      OR NEW.attendee_email <> trim(NEW.attendee_email)
      OR NEW.attendee_email <> lower(NEW.attendee_email)
      THEN RAISE(ABORT, 'scheduler booking attendee email must be lowercase and trimmed')
    WHEN NEW.start_at IS NULL
      OR trim(NEW.start_at) = ''
      OR NEW.start_at <> trim(NEW.start_at)
      OR NEW.end_at IS NULL
      OR trim(NEW.end_at) = ''
      OR NEW.end_at <> trim(NEW.end_at)
      OR NEW.end_at <= NEW.start_at
      THEN RAISE(ABORT, 'scheduler booking time window must be canonical')
    WHEN NEW.status NOT IN ('confirmed', 'cancelled')
      THEN RAISE(ABORT, 'scheduler booking status must be canonical')
    WHEN NEW.source IS NULL OR trim(NEW.source) = '' OR NEW.source <> trim(NEW.source)
      THEN RAISE(ABORT, 'scheduler booking source must be trimmed non-empty text')
    WHEN NEW.calendar_sync_status NOT IN ('not_connected', 'local_only', 'synced', 'sync_failed', 'cancelled')
      THEN RAISE(ABORT, 'scheduler booking calendar sync status must be canonical')
    ELSE RAISE(ABORT, 'scheduler booking sms opt-in must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_bookings_answers_canon_insert
BEFORE INSERT ON scheduler_bookings
FOR EACH ROW
WHEN NEW.invitee_answers_json IS NOT NULL
  AND (
    trim(NEW.invitee_answers_json) = ''
    OR NEW.invitee_answers_json <> trim(NEW.invitee_answers_json)
    OR json_valid(NEW.invitee_answers_json) = 0
    OR json_type(NEW.invitee_answers_json) <> 'object'
  )
BEGIN
  SELECT RAISE(ABORT, 'scheduler booking invitee answers must be null or canonical json object text');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_bookings_answers_canon_update
BEFORE UPDATE OF invitee_answers_json ON scheduler_bookings
FOR EACH ROW
WHEN NEW.invitee_answers_json IS NOT NULL
  AND (
    trim(NEW.invitee_answers_json) = ''
    OR NEW.invitee_answers_json <> trim(NEW.invitee_answers_json)
    OR json_valid(NEW.invitee_answers_json) = 0
    OR json_type(NEW.invitee_answers_json) <> 'object'
  )
BEGIN
  SELECT RAISE(ABORT, 'scheduler booking invitee answers must be null or canonical json object text');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_bookings_detail_text_canon_insert
BEFORE INSERT ON scheduler_bookings
FOR EACH ROW
WHEN (NEW.attendee_phone IS NOT NULL AND (trim(NEW.attendee_phone) = '' OR NEW.attendee_phone <> trim(NEW.attendee_phone)))
  OR (NEW.notes IS NOT NULL AND (trim(NEW.notes) = '' OR NEW.notes <> trim(NEW.notes)))
  OR (NEW.google_calendar_event_id IS NOT NULL AND (trim(NEW.google_calendar_event_id) = '' OR NEW.google_calendar_event_id <> trim(NEW.google_calendar_event_id)))
  OR (NEW.google_calendar_id IS NOT NULL AND (trim(NEW.google_calendar_id) = '' OR NEW.google_calendar_id <> trim(NEW.google_calendar_id)))
  OR (NEW.cancelled_at IS NOT NULL AND (trim(NEW.cancelled_at) = '' OR NEW.cancelled_at <> trim(NEW.cancelled_at)))
  OR (NEW.cancellation_reason IS NOT NULL AND (trim(NEW.cancellation_reason) = '' OR NEW.cancellation_reason <> trim(NEW.cancellation_reason)))
  OR (NEW.rescheduled_from_booking_id IS NOT NULL AND (trim(NEW.rescheduled_from_booking_id) = '' OR NEW.rescheduled_from_booking_id <> trim(NEW.rescheduled_from_booking_id)))
  OR (NEW.reminder_sent_at IS NOT NULL AND (trim(NEW.reminder_sent_at) = '' OR NEW.reminder_sent_at <> trim(NEW.reminder_sent_at)))
BEGIN
  SELECT RAISE(ABORT, 'scheduler booking detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_bookings_detail_text_canon_update
BEFORE UPDATE OF attendee_phone, notes, google_calendar_event_id, google_calendar_id, cancelled_at, cancellation_reason, rescheduled_from_booking_id, reminder_sent_at ON scheduler_bookings
FOR EACH ROW
WHEN (NEW.attendee_phone IS NOT NULL AND (trim(NEW.attendee_phone) = '' OR NEW.attendee_phone <> trim(NEW.attendee_phone)))
  OR (NEW.notes IS NOT NULL AND (trim(NEW.notes) = '' OR NEW.notes <> trim(NEW.notes)))
  OR (NEW.google_calendar_event_id IS NOT NULL AND (trim(NEW.google_calendar_event_id) = '' OR NEW.google_calendar_event_id <> trim(NEW.google_calendar_event_id)))
  OR (NEW.google_calendar_id IS NOT NULL AND (trim(NEW.google_calendar_id) = '' OR NEW.google_calendar_id <> trim(NEW.google_calendar_id)))
  OR (NEW.cancelled_at IS NOT NULL AND (trim(NEW.cancelled_at) = '' OR NEW.cancelled_at <> trim(NEW.cancelled_at)))
  OR (NEW.cancellation_reason IS NOT NULL AND (trim(NEW.cancellation_reason) = '' OR NEW.cancellation_reason <> trim(NEW.cancellation_reason)))
  OR (NEW.rescheduled_from_booking_id IS NOT NULL AND (trim(NEW.rescheduled_from_booking_id) = '' OR NEW.rescheduled_from_booking_id <> trim(NEW.rescheduled_from_booking_id)))
  OR (NEW.reminder_sent_at IS NOT NULL AND (trim(NEW.reminder_sent_at) = '' OR NEW.reminder_sent_at <> trim(NEW.reminder_sent_at)))
BEGIN
  SELECT RAISE(ABORT, 'scheduler booking detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_bookings_payment_canon_insert
BEFORE INSERT ON scheduler_bookings
FOR EACH ROW
WHEN NEW.payment_status NOT IN ('unpaid', 'paid', 'refunded', 'waived')
  OR NEW.paid_amount_cents < 0
  OR NEW.client_fee_cents < 0
  OR NEW.processing_fee_cents < 0
  OR NEW.gross_collected_cents < 0
  OR NEW.net_deposit_cents < 0
  OR (NEW.payment_method IS NOT NULL AND (trim(NEW.payment_method) = '' OR NEW.payment_method <> trim(NEW.payment_method)))
  OR (NEW.paid_at IS NOT NULL AND (trim(NEW.paid_at) = '' OR NEW.paid_at <> trim(NEW.paid_at)))
  OR (NEW.external_payment_id IS NOT NULL AND (trim(NEW.external_payment_id) = '' OR NEW.external_payment_id <> trim(NEW.external_payment_id)))
  OR (NEW.payment_link IS NOT NULL AND (trim(NEW.payment_link) = '' OR NEW.payment_link <> trim(NEW.payment_link)))
  OR (NEW.payment_notes IS NOT NULL AND (trim(NEW.payment_notes) = '' OR NEW.payment_notes <> trim(NEW.payment_notes)))
  OR (NEW.payment_source_type IS NOT NULL AND (trim(NEW.payment_source_type) = '' OR NEW.payment_source_type <> trim(NEW.payment_source_type)))
  OR (NEW.payment_source_id IS NOT NULL AND (trim(NEW.payment_source_id) = '' OR NEW.payment_source_id <> trim(NEW.payment_source_id)))
BEGIN
  SELECT CASE
    WHEN NEW.payment_status NOT IN ('unpaid', 'paid', 'refunded', 'waived')
      THEN RAISE(ABORT, 'scheduler booking payment status must be canonical')
    WHEN NEW.paid_amount_cents < 0
      OR NEW.client_fee_cents < 0
      OR NEW.processing_fee_cents < 0
      OR NEW.gross_collected_cents < 0
      OR NEW.net_deposit_cents < 0
      THEN RAISE(ABORT, 'scheduler booking payment amounts must be canonical non-negative integers')
    ELSE RAISE(ABORT, 'scheduler booking payment detail text must be null or trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_bookings_payment_canon_update
BEFORE UPDATE OF payment_status, payment_method, paid_at, paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents, external_payment_id, payment_link, payment_notes, payment_source_type, payment_source_id ON scheduler_bookings
FOR EACH ROW
WHEN NEW.payment_status NOT IN ('unpaid', 'paid', 'refunded', 'waived')
  OR NEW.paid_amount_cents < 0
  OR NEW.client_fee_cents < 0
  OR NEW.processing_fee_cents < 0
  OR NEW.gross_collected_cents < 0
  OR NEW.net_deposit_cents < 0
  OR (NEW.payment_method IS NOT NULL AND (trim(NEW.payment_method) = '' OR NEW.payment_method <> trim(NEW.payment_method)))
  OR (NEW.paid_at IS NOT NULL AND (trim(NEW.paid_at) = '' OR NEW.paid_at <> trim(NEW.paid_at)))
  OR (NEW.external_payment_id IS NOT NULL AND (trim(NEW.external_payment_id) = '' OR NEW.external_payment_id <> trim(NEW.external_payment_id)))
  OR (NEW.payment_link IS NOT NULL AND (trim(NEW.payment_link) = '' OR NEW.payment_link <> trim(NEW.payment_link)))
  OR (NEW.payment_notes IS NOT NULL AND (trim(NEW.payment_notes) = '' OR NEW.payment_notes <> trim(NEW.payment_notes)))
  OR (NEW.payment_source_type IS NOT NULL AND (trim(NEW.payment_source_type) = '' OR NEW.payment_source_type <> trim(NEW.payment_source_type)))
  OR (NEW.payment_source_id IS NOT NULL AND (trim(NEW.payment_source_id) = '' OR NEW.payment_source_id <> trim(NEW.payment_source_id)))
BEGIN
  SELECT CASE
    WHEN NEW.payment_status NOT IN ('unpaid', 'paid', 'refunded', 'waived')
      THEN RAISE(ABORT, 'scheduler booking payment status must be canonical')
    WHEN NEW.paid_amount_cents < 0
      OR NEW.client_fee_cents < 0
      OR NEW.processing_fee_cents < 0
      OR NEW.gross_collected_cents < 0
      OR NEW.net_deposit_cents < 0
      THEN RAISE(ABORT, 'scheduler booking payment amounts must be canonical non-negative integers')
    ELSE RAISE(ABORT, 'scheduler booking payment detail text must be null or trimmed non-empty text')
  END;
END;
