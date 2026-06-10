CREATE TRIGGER IF NOT EXISTS trg_app_settings_identity_canon_insert
BEFORE INSERT ON app_settings
FOR EACH ROW
WHEN NEW.business_name IS NULL
  OR trim(NEW.business_name) = ''
  OR NEW.business_name <> trim(NEW.business_name)
  OR NEW.public_brand_name IS NULL
  OR trim(NEW.public_brand_name) = ''
  OR NEW.public_brand_name <> trim(NEW.public_brand_name)
  OR NEW.contact_email IS NULL
  OR trim(NEW.contact_email) = ''
  OR NEW.contact_email <> trim(NEW.contact_email)
  OR NEW.contact_email <> lower(NEW.contact_email)
  OR NEW.timezone IS NULL
  OR trim(NEW.timezone) = ''
  OR NEW.timezone <> trim(NEW.timezone)
BEGIN
  SELECT CASE
    WHEN NEW.business_name IS NULL OR trim(NEW.business_name) = '' OR NEW.business_name <> trim(NEW.business_name)
      THEN RAISE(ABORT, 'app setting business name must be trimmed non-empty text')
    WHEN NEW.public_brand_name IS NULL OR trim(NEW.public_brand_name) = '' OR NEW.public_brand_name <> trim(NEW.public_brand_name)
      THEN RAISE(ABORT, 'app setting public brand name must be trimmed non-empty text')
    WHEN NEW.contact_email IS NULL
      OR trim(NEW.contact_email) = ''
      OR NEW.contact_email <> trim(NEW.contact_email)
      OR NEW.contact_email <> lower(NEW.contact_email)
      THEN RAISE(ABORT, 'app setting contact email must be lowercase and trimmed')
    ELSE RAISE(ABORT, 'app setting timezone must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_app_settings_identity_canon_update
BEFORE UPDATE OF business_name, public_brand_name, contact_email, timezone ON app_settings
FOR EACH ROW
WHEN NEW.business_name IS NULL
  OR trim(NEW.business_name) = ''
  OR NEW.business_name <> trim(NEW.business_name)
  OR NEW.public_brand_name IS NULL
  OR trim(NEW.public_brand_name) = ''
  OR NEW.public_brand_name <> trim(NEW.public_brand_name)
  OR NEW.contact_email IS NULL
  OR trim(NEW.contact_email) = ''
  OR NEW.contact_email <> trim(NEW.contact_email)
  OR NEW.contact_email <> lower(NEW.contact_email)
  OR NEW.timezone IS NULL
  OR trim(NEW.timezone) = ''
  OR NEW.timezone <> trim(NEW.timezone)
BEGIN
  SELECT CASE
    WHEN NEW.business_name IS NULL OR trim(NEW.business_name) = '' OR NEW.business_name <> trim(NEW.business_name)
      THEN RAISE(ABORT, 'app setting business name must be trimmed non-empty text')
    WHEN NEW.public_brand_name IS NULL OR trim(NEW.public_brand_name) = '' OR NEW.public_brand_name <> trim(NEW.public_brand_name)
      THEN RAISE(ABORT, 'app setting public brand name must be trimmed non-empty text')
    WHEN NEW.contact_email IS NULL
      OR trim(NEW.contact_email) = ''
      OR NEW.contact_email <> trim(NEW.contact_email)
      OR NEW.contact_email <> lower(NEW.contact_email)
      THEN RAISE(ABORT, 'app setting contact email must be lowercase and trimmed')
    ELSE RAISE(ABORT, 'app setting timezone must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_app_settings_detail_text_canon_insert
BEFORE INSERT ON app_settings
FOR EACH ROW
WHEN (NEW.website_url IS NOT NULL AND (trim(NEW.website_url) = '' OR NEW.website_url <> trim(NEW.website_url)))
  OR (NEW.instagram_url IS NOT NULL AND (trim(NEW.instagram_url) = '' OR NEW.instagram_url <> trim(NEW.instagram_url)))
BEGIN
  SELECT RAISE(ABORT, 'app setting detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_app_settings_detail_text_canon_update
BEFORE UPDATE OF website_url, instagram_url ON app_settings
FOR EACH ROW
WHEN (NEW.website_url IS NOT NULL AND (trim(NEW.website_url) = '' OR NEW.website_url <> trim(NEW.website_url)))
  OR (NEW.instagram_url IS NOT NULL AND (trim(NEW.instagram_url) = '' OR NEW.instagram_url <> trim(NEW.instagram_url)))
BEGIN
  SELECT RAISE(ABORT, 'app setting detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_app_settings_payment_methods_canon_insert
BEFORE INSERT ON app_settings
FOR EACH ROW
WHEN NEW.payment_methods_json IS NULL
  OR trim(NEW.payment_methods_json) = ''
  OR NEW.payment_methods_json <> trim(NEW.payment_methods_json)
  OR json_valid(NEW.payment_methods_json) = 0
  OR json_type(NEW.payment_methods_json) <> 'object'
BEGIN
  SELECT RAISE(ABORT, 'app setting payment methods must be canonical json object text');
END;

CREATE TRIGGER IF NOT EXISTS trg_app_settings_payment_methods_canon_update
BEFORE UPDATE OF payment_methods_json ON app_settings
FOR EACH ROW
WHEN NEW.payment_methods_json IS NULL
  OR trim(NEW.payment_methods_json) = ''
  OR NEW.payment_methods_json <> trim(NEW.payment_methods_json)
  OR json_valid(NEW.payment_methods_json) = 0
  OR json_type(NEW.payment_methods_json) <> 'object'
BEGIN
  SELECT RAISE(ABORT, 'app setting payment methods must be canonical json object text');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_settings_identity_canon_insert
BEFORE INSERT ON scheduler_settings
FOR EACH ROW
WHEN NEW.timezone IS NULL
  OR trim(NEW.timezone) = ''
  OR NEW.timezone <> trim(NEW.timezone)
  OR NEW.booking_window_days < 1
  OR NEW.minimum_notice_minutes < 0
BEGIN
  SELECT CASE
    WHEN NEW.timezone IS NULL OR trim(NEW.timezone) = '' OR NEW.timezone <> trim(NEW.timezone)
      THEN RAISE(ABORT, 'scheduler setting timezone must be trimmed non-empty text')
    WHEN NEW.booking_window_days < 1
      THEN RAISE(ABORT, 'scheduler setting booking window must be positive')
    ELSE RAISE(ABORT, 'scheduler setting minimum notice must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_settings_identity_canon_update
BEFORE UPDATE OF timezone, booking_window_days, minimum_notice_minutes ON scheduler_settings
FOR EACH ROW
WHEN NEW.timezone IS NULL
  OR trim(NEW.timezone) = ''
  OR NEW.timezone <> trim(NEW.timezone)
  OR NEW.booking_window_days < 1
  OR NEW.minimum_notice_minutes < 0
BEGIN
  SELECT CASE
    WHEN NEW.timezone IS NULL OR trim(NEW.timezone) = '' OR NEW.timezone <> trim(NEW.timezone)
      THEN RAISE(ABORT, 'scheduler setting timezone must be trimmed non-empty text')
    WHEN NEW.booking_window_days < 1
      THEN RAISE(ABORT, 'scheduler setting booking window must be positive')
    ELSE RAISE(ABORT, 'scheduler setting minimum notice must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_settings_detail_text_canon_insert
BEFORE INSERT ON scheduler_settings
FOR EACH ROW
WHEN (NEW.google_calendar_ids IS NOT NULL AND (trim(NEW.google_calendar_ids) = '' OR NEW.google_calendar_ids <> trim(NEW.google_calendar_ids)))
  OR (NEW.google_create_calendar_id IS NOT NULL AND (trim(NEW.google_create_calendar_id) = '' OR NEW.google_create_calendar_id <> trim(NEW.google_create_calendar_id)))
  OR (NEW.zoom_join_url IS NOT NULL AND (trim(NEW.zoom_join_url) = '' OR NEW.zoom_join_url <> trim(NEW.zoom_join_url)))
BEGIN
  SELECT RAISE(ABORT, 'scheduler setting detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_settings_detail_text_canon_update
BEFORE UPDATE OF google_calendar_ids, google_create_calendar_id, zoom_join_url ON scheduler_settings
FOR EACH ROW
WHEN (NEW.google_calendar_ids IS NOT NULL AND (trim(NEW.google_calendar_ids) = '' OR NEW.google_calendar_ids <> trim(NEW.google_calendar_ids)))
  OR (NEW.google_create_calendar_id IS NOT NULL AND (trim(NEW.google_create_calendar_id) = '' OR NEW.google_create_calendar_id <> trim(NEW.google_create_calendar_id)))
  OR (NEW.zoom_join_url IS NOT NULL AND (trim(NEW.zoom_join_url) = '' OR NEW.zoom_join_url <> trim(NEW.zoom_join_url)))
BEGIN
  SELECT RAISE(ABORT, 'scheduler setting detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_settings_availability_canon_insert
BEFORE INSERT ON scheduler_settings
FOR EACH ROW
WHEN NEW.availability_json IS NULL
  OR trim(NEW.availability_json) = ''
  OR NEW.availability_json <> trim(NEW.availability_json)
  OR json_valid(NEW.availability_json) = 0
  OR json_type(NEW.availability_json) <> 'array'
BEGIN
  SELECT RAISE(ABORT, 'scheduler setting availability must be canonical json array text');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_settings_availability_canon_update
BEFORE UPDATE OF availability_json ON scheduler_settings
FOR EACH ROW
WHEN NEW.availability_json IS NULL
  OR trim(NEW.availability_json) = ''
  OR NEW.availability_json <> trim(NEW.availability_json)
  OR json_valid(NEW.availability_json) = 0
  OR json_type(NEW.availability_json) <> 'array'
BEGIN
  SELECT RAISE(ABORT, 'scheduler setting availability must be canonical json array text');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_meeting_types_identity_canon_insert
BEFORE INSERT ON scheduler_meeting_types
FOR EACH ROW
WHEN NEW.slug IS NULL
  OR trim(NEW.slug) = ''
  OR NEW.slug <> trim(NEW.slug)
  OR NEW.slug <> lower(NEW.slug)
  OR instr(NEW.slug, ' ') > 0
  OR NEW.name IS NULL
  OR trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
  OR NEW.duration_minutes < 1
  OR NEW.buffer_minutes < 0
  OR NEW.location_type IS NULL
  OR trim(NEW.location_type) = ''
  OR NEW.location_type <> trim(NEW.location_type)
  OR NEW.collect_payment NOT IN (0, 1)
  OR NEW.sms_opt_in_enabled NOT IN (0, 1)
  OR NEW.is_active NOT IN (0, 1)
  OR (NEW.price_cents IS NOT NULL AND NEW.price_cents < 0)
BEGIN
  SELECT CASE
    WHEN NEW.slug IS NULL
      OR trim(NEW.slug) = ''
      OR NEW.slug <> trim(NEW.slug)
      OR NEW.slug <> lower(NEW.slug)
      OR instr(NEW.slug, ' ') > 0
      THEN RAISE(ABORT, 'scheduler meeting type slug must be lowercase and trimmed')
    WHEN NEW.name IS NULL OR trim(NEW.name) = '' OR NEW.name <> trim(NEW.name)
      THEN RAISE(ABORT, 'scheduler meeting type name must be trimmed non-empty text')
    WHEN NEW.duration_minutes < 1
      THEN RAISE(ABORT, 'scheduler meeting type duration must be positive')
    WHEN NEW.buffer_minutes < 0
      THEN RAISE(ABORT, 'scheduler meeting type buffer must be canonical')
    WHEN NEW.location_type IS NULL OR trim(NEW.location_type) = '' OR NEW.location_type <> trim(NEW.location_type)
      THEN RAISE(ABORT, 'scheduler meeting type location type must be trimmed non-empty text')
    WHEN NEW.collect_payment NOT IN (0, 1)
      OR NEW.sms_opt_in_enabled NOT IN (0, 1)
      OR NEW.is_active NOT IN (0, 1)
      THEN RAISE(ABORT, 'scheduler meeting type boolean fields must be canonical')
    ELSE RAISE(ABORT, 'scheduler meeting type price must be canonical non-negative integer')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_meeting_types_identity_canon_update
BEFORE UPDATE OF slug, name, duration_minutes, buffer_minutes, location_type, collect_payment, sms_opt_in_enabled, is_active, price_cents ON scheduler_meeting_types
FOR EACH ROW
WHEN NEW.slug IS NULL
  OR trim(NEW.slug) = ''
  OR NEW.slug <> trim(NEW.slug)
  OR NEW.slug <> lower(NEW.slug)
  OR instr(NEW.slug, ' ') > 0
  OR NEW.name IS NULL
  OR trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
  OR NEW.duration_minutes < 1
  OR NEW.buffer_minutes < 0
  OR NEW.location_type IS NULL
  OR trim(NEW.location_type) = ''
  OR NEW.location_type <> trim(NEW.location_type)
  OR NEW.collect_payment NOT IN (0, 1)
  OR NEW.sms_opt_in_enabled NOT IN (0, 1)
  OR NEW.is_active NOT IN (0, 1)
  OR (NEW.price_cents IS NOT NULL AND NEW.price_cents < 0)
BEGIN
  SELECT CASE
    WHEN NEW.slug IS NULL
      OR trim(NEW.slug) = ''
      OR NEW.slug <> trim(NEW.slug)
      OR NEW.slug <> lower(NEW.slug)
      OR instr(NEW.slug, ' ') > 0
      THEN RAISE(ABORT, 'scheduler meeting type slug must be lowercase and trimmed')
    WHEN NEW.name IS NULL OR trim(NEW.name) = '' OR NEW.name <> trim(NEW.name)
      THEN RAISE(ABORT, 'scheduler meeting type name must be trimmed non-empty text')
    WHEN NEW.duration_minutes < 1
      THEN RAISE(ABORT, 'scheduler meeting type duration must be positive')
    WHEN NEW.buffer_minutes < 0
      THEN RAISE(ABORT, 'scheduler meeting type buffer must be canonical')
    WHEN NEW.location_type IS NULL OR trim(NEW.location_type) = '' OR NEW.location_type <> trim(NEW.location_type)
      THEN RAISE(ABORT, 'scheduler meeting type location type must be trimmed non-empty text')
    WHEN NEW.collect_payment NOT IN (0, 1)
      OR NEW.sms_opt_in_enabled NOT IN (0, 1)
      OR NEW.is_active NOT IN (0, 1)
      THEN RAISE(ABORT, 'scheduler meeting type boolean fields must be canonical')
    ELSE RAISE(ABORT, 'scheduler meeting type price must be canonical non-negative integer')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_meeting_types_detail_text_canon_insert
BEFORE INSERT ON scheduler_meeting_types
FOR EACH ROW
WHEN (NEW.description IS NOT NULL AND (trim(NEW.description) = '' OR NEW.description <> trim(NEW.description)))
  OR (NEW.location_label IS NOT NULL AND (trim(NEW.location_label) = '' OR NEW.location_label <> trim(NEW.location_label)))
  OR (NEW.zoom_join_url IS NOT NULL AND (trim(NEW.zoom_join_url) = '' OR NEW.zoom_join_url <> trim(NEW.zoom_join_url)))
  OR (NEW.stripe_payment_link IS NOT NULL AND (trim(NEW.stripe_payment_link) = '' OR NEW.stripe_payment_link <> trim(NEW.stripe_payment_link)))
  OR (NEW.confirmation_message IS NOT NULL AND (trim(NEW.confirmation_message) = '' OR NEW.confirmation_message <> trim(NEW.confirmation_message)))
BEGIN
  SELECT RAISE(ABORT, 'scheduler meeting type detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_meeting_types_detail_text_canon_update
BEFORE UPDATE OF description, location_label, zoom_join_url, stripe_payment_link, confirmation_message ON scheduler_meeting_types
FOR EACH ROW
WHEN (NEW.description IS NOT NULL AND (trim(NEW.description) = '' OR NEW.description <> trim(NEW.description)))
  OR (NEW.location_label IS NOT NULL AND (trim(NEW.location_label) = '' OR NEW.location_label <> trim(NEW.location_label)))
  OR (NEW.zoom_join_url IS NOT NULL AND (trim(NEW.zoom_join_url) = '' OR NEW.zoom_join_url <> trim(NEW.zoom_join_url)))
  OR (NEW.stripe_payment_link IS NOT NULL AND (trim(NEW.stripe_payment_link) = '' OR NEW.stripe_payment_link <> trim(NEW.stripe_payment_link)))
  OR (NEW.confirmation_message IS NOT NULL AND (trim(NEW.confirmation_message) = '' OR NEW.confirmation_message <> trim(NEW.confirmation_message)))
BEGIN
  SELECT RAISE(ABORT, 'scheduler meeting type detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_meeting_types_questions_canon_insert
BEFORE INSERT ON scheduler_meeting_types
FOR EACH ROW
WHEN NEW.invitee_questions_json IS NOT NULL
  AND (
    trim(NEW.invitee_questions_json) = ''
    OR NEW.invitee_questions_json <> trim(NEW.invitee_questions_json)
    OR json_valid(NEW.invitee_questions_json) = 0
    OR json_type(NEW.invitee_questions_json) <> 'array'
  )
BEGIN
  SELECT RAISE(ABORT, 'scheduler meeting type questions must be null or canonical json array text');
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_meeting_types_questions_canon_update
BEFORE UPDATE OF invitee_questions_json ON scheduler_meeting_types
FOR EACH ROW
WHEN NEW.invitee_questions_json IS NOT NULL
  AND (
    trim(NEW.invitee_questions_json) = ''
    OR NEW.invitee_questions_json <> trim(NEW.invitee_questions_json)
    OR json_valid(NEW.invitee_questions_json) = 0
    OR json_type(NEW.invitee_questions_json) <> 'array'
  )
BEGIN
  SELECT RAISE(ABORT, 'scheduler meeting type questions must be null or canonical json array text');
END;
