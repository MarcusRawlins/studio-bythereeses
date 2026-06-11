ALTER TABLE clients ADD COLUMN instagram_handle TEXT;
ALTER TABLE clients ADD COLUMN communication_preference TEXT;
ALTER TABLE clients ADD COLUMN referral_source TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_instagram_handle
  ON clients(instagram_handle);

CREATE TRIGGER IF NOT EXISTS trg_clients_profile_fields_canon_insert
BEFORE INSERT ON clients
FOR EACH ROW
WHEN (
    NEW.instagram_handle IS NOT NULL
    AND (
      trim(NEW.instagram_handle) = ''
      OR NEW.instagram_handle <> trim(NEW.instagram_handle)
      OR substr(NEW.instagram_handle, 1, 1) <> '@'
    )
  )
  OR (
    NEW.communication_preference IS NOT NULL
    AND (
      trim(NEW.communication_preference) = ''
      OR NEW.communication_preference <> trim(NEW.communication_preference)
    )
  )
  OR (
    NEW.referral_source IS NOT NULL
    AND (
      trim(NEW.referral_source) = ''
      OR NEW.referral_source <> trim(NEW.referral_source)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'client profile fields must be null or canonical trimmed text');
END;

CREATE TRIGGER IF NOT EXISTS trg_clients_profile_fields_canon_update
BEFORE UPDATE OF instagram_handle, communication_preference, referral_source ON clients
FOR EACH ROW
WHEN (
    NEW.instagram_handle IS NOT NULL
    AND (
      trim(NEW.instagram_handle) = ''
      OR NEW.instagram_handle <> trim(NEW.instagram_handle)
      OR substr(NEW.instagram_handle, 1, 1) <> '@'
    )
  )
  OR (
    NEW.communication_preference IS NOT NULL
    AND (
      trim(NEW.communication_preference) = ''
      OR NEW.communication_preference <> trim(NEW.communication_preference)
    )
  )
  OR (
    NEW.referral_source IS NOT NULL
    AND (
      trim(NEW.referral_source) = ''
      OR NEW.referral_source <> trim(NEW.referral_source)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'client profile fields must be null or canonical trimmed text');
END;
