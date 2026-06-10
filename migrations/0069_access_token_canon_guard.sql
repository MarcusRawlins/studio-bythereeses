CREATE TRIGGER IF NOT EXISTS trg_proposal_access_tokens_identity_canon_insert
BEFORE INSERT ON proposal_access_tokens
FOR EACH ROW
WHEN NEW.token_hash IS NULL
  OR length(NEW.token_hash) <> 64
  OR NEW.token_hash <> trim(NEW.token_hash)
  OR NEW.token_hash <> lower(NEW.token_hash)
  OR NEW.token_hash GLOB '*[^0-9a-f]*'
  OR NEW.expires_at IS NULL
  OR trim(NEW.expires_at) = ''
  OR NEW.expires_at <> trim(NEW.expires_at)
BEGIN
  SELECT CASE
    WHEN NEW.token_hash IS NULL
      OR length(NEW.token_hash) <> 64
      OR NEW.token_hash <> trim(NEW.token_hash)
      OR NEW.token_hash <> lower(NEW.token_hash)
      OR NEW.token_hash GLOB '*[^0-9a-f]*'
      THEN RAISE(ABORT, 'proposal access token hash must be canonical sha256 hex text')
    ELSE RAISE(ABORT, 'proposal access token expiry must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_proposal_access_tokens_identity_canon_update
BEFORE UPDATE OF token_hash, expires_at ON proposal_access_tokens
FOR EACH ROW
WHEN NEW.token_hash IS NULL
  OR length(NEW.token_hash) <> 64
  OR NEW.token_hash <> trim(NEW.token_hash)
  OR NEW.token_hash <> lower(NEW.token_hash)
  OR NEW.token_hash GLOB '*[^0-9a-f]*'
  OR NEW.expires_at IS NULL
  OR trim(NEW.expires_at) = ''
  OR NEW.expires_at <> trim(NEW.expires_at)
BEGIN
  SELECT CASE
    WHEN NEW.token_hash IS NULL
      OR length(NEW.token_hash) <> 64
      OR NEW.token_hash <> trim(NEW.token_hash)
      OR NEW.token_hash <> lower(NEW.token_hash)
      OR NEW.token_hash GLOB '*[^0-9a-f]*'
      THEN RAISE(ABORT, 'proposal access token hash must be canonical sha256 hex text')
    ELSE RAISE(ABORT, 'proposal access token expiry must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_proposal_access_tokens_detail_text_canon_insert
BEFORE INSERT ON proposal_access_tokens
FOR EACH ROW
WHEN (NEW.label IS NOT NULL AND (trim(NEW.label) = '' OR NEW.label <> trim(NEW.label)))
  OR (NEW.sent_at IS NOT NULL AND (trim(NEW.sent_at) = '' OR NEW.sent_at <> trim(NEW.sent_at)))
  OR (NEW.viewed_at IS NOT NULL AND (trim(NEW.viewed_at) = '' OR NEW.viewed_at <> trim(NEW.viewed_at)))
  OR (NEW.revoked_at IS NOT NULL AND (trim(NEW.revoked_at) = '' OR NEW.revoked_at <> trim(NEW.revoked_at)))
  OR (NEW.last_used_at IS NOT NULL AND (trim(NEW.last_used_at) = '' OR NEW.last_used_at <> trim(NEW.last_used_at)))
  OR (NEW.last_used_ip IS NOT NULL AND (trim(NEW.last_used_ip) = '' OR NEW.last_used_ip <> trim(NEW.last_used_ip)))
BEGIN
  SELECT RAISE(ABORT, 'proposal access token detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_proposal_access_tokens_detail_text_canon_update
BEFORE UPDATE OF label, sent_at, viewed_at, revoked_at, last_used_at, last_used_ip ON proposal_access_tokens
FOR EACH ROW
WHEN (NEW.label IS NOT NULL AND (trim(NEW.label) = '' OR NEW.label <> trim(NEW.label)))
  OR (NEW.sent_at IS NOT NULL AND (trim(NEW.sent_at) = '' OR NEW.sent_at <> trim(NEW.sent_at)))
  OR (NEW.viewed_at IS NOT NULL AND (trim(NEW.viewed_at) = '' OR NEW.viewed_at <> trim(NEW.viewed_at)))
  OR (NEW.revoked_at IS NOT NULL AND (trim(NEW.revoked_at) = '' OR NEW.revoked_at <> trim(NEW.revoked_at)))
  OR (NEW.last_used_at IS NOT NULL AND (trim(NEW.last_used_at) = '' OR NEW.last_used_at <> trim(NEW.last_used_at)))
  OR (NEW.last_used_ip IS NOT NULL AND (trim(NEW.last_used_ip) = '' OR NEW.last_used_ip <> trim(NEW.last_used_ip)))
BEGIN
  SELECT RAISE(ABORT, 'proposal access token detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_proposal_access_tokens_project_canon_insert
BEFORE INSERT ON proposal_access_tokens
FOR EACH ROW
WHEN NOT EXISTS (
    SELECT 1
    FROM proposals
    WHERE proposals.id = NEW.proposal_id
      AND proposals.project_id = NEW.project_id
  )
  OR (
    NEW.client_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM project_participants
      WHERE project_participants.project_id = NEW.project_id
        AND project_participants.client_id = NEW.client_id
    )
  )
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM proposals
      WHERE proposals.id = NEW.proposal_id
        AND proposals.project_id = NEW.project_id
    )
      THEN RAISE(ABORT, 'proposal access token project must match proposal project')
    ELSE RAISE(ABORT, 'proposal access token client must belong to token project')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_proposal_access_tokens_project_canon_update
BEFORE UPDATE OF proposal_id, project_id, client_id ON proposal_access_tokens
FOR EACH ROW
WHEN NOT EXISTS (
    SELECT 1
    FROM proposals
    WHERE proposals.id = NEW.proposal_id
      AND proposals.project_id = NEW.project_id
  )
  OR (
    NEW.client_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM project_participants
      WHERE project_participants.project_id = NEW.project_id
        AND project_participants.client_id = NEW.client_id
    )
  )
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM proposals
      WHERE proposals.id = NEW.proposal_id
        AND proposals.project_id = NEW.project_id
    )
      THEN RAISE(ABORT, 'proposal access token project must match proposal project')
    ELSE RAISE(ABORT, 'proposal access token client must belong to token project')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_portal_access_tokens_identity_canon_insert
BEFORE INSERT ON portal_access_tokens
FOR EACH ROW
WHEN NEW.token_hash IS NULL
  OR length(NEW.token_hash) <> 64
  OR NEW.token_hash <> trim(NEW.token_hash)
  OR NEW.token_hash <> lower(NEW.token_hash)
  OR NEW.token_hash GLOB '*[^0-9a-f]*'
  OR NEW.expires_at IS NULL
  OR trim(NEW.expires_at) = ''
  OR NEW.expires_at <> trim(NEW.expires_at)
BEGIN
  SELECT CASE
    WHEN NEW.token_hash IS NULL
      OR length(NEW.token_hash) <> 64
      OR NEW.token_hash <> trim(NEW.token_hash)
      OR NEW.token_hash <> lower(NEW.token_hash)
      OR NEW.token_hash GLOB '*[^0-9a-f]*'
      THEN RAISE(ABORT, 'portal access token hash must be canonical sha256 hex text')
    ELSE RAISE(ABORT, 'portal access token expiry must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_portal_access_tokens_identity_canon_update
BEFORE UPDATE OF token_hash, expires_at ON portal_access_tokens
FOR EACH ROW
WHEN NEW.token_hash IS NULL
  OR length(NEW.token_hash) <> 64
  OR NEW.token_hash <> trim(NEW.token_hash)
  OR NEW.token_hash <> lower(NEW.token_hash)
  OR NEW.token_hash GLOB '*[^0-9a-f]*'
  OR NEW.expires_at IS NULL
  OR trim(NEW.expires_at) = ''
  OR NEW.expires_at <> trim(NEW.expires_at)
BEGIN
  SELECT CASE
    WHEN NEW.token_hash IS NULL
      OR length(NEW.token_hash) <> 64
      OR NEW.token_hash <> trim(NEW.token_hash)
      OR NEW.token_hash <> lower(NEW.token_hash)
      OR NEW.token_hash GLOB '*[^0-9a-f]*'
      THEN RAISE(ABORT, 'portal access token hash must be canonical sha256 hex text')
    ELSE RAISE(ABORT, 'portal access token expiry must be trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_portal_access_tokens_detail_text_canon_insert
BEFORE INSERT ON portal_access_tokens
FOR EACH ROW
WHEN (NEW.label IS NOT NULL AND (trim(NEW.label) = '' OR NEW.label <> trim(NEW.label)))
  OR (NEW.revoked_at IS NOT NULL AND (trim(NEW.revoked_at) = '' OR NEW.revoked_at <> trim(NEW.revoked_at)))
  OR (NEW.last_used_at IS NOT NULL AND (trim(NEW.last_used_at) = '' OR NEW.last_used_at <> trim(NEW.last_used_at)))
  OR (NEW.last_used_ip IS NOT NULL AND (trim(NEW.last_used_ip) = '' OR NEW.last_used_ip <> trim(NEW.last_used_ip)))
BEGIN
  SELECT RAISE(ABORT, 'portal access token detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_portal_access_tokens_detail_text_canon_update
BEFORE UPDATE OF label, revoked_at, last_used_at, last_used_ip ON portal_access_tokens
FOR EACH ROW
WHEN (NEW.label IS NOT NULL AND (trim(NEW.label) = '' OR NEW.label <> trim(NEW.label)))
  OR (NEW.revoked_at IS NOT NULL AND (trim(NEW.revoked_at) = '' OR NEW.revoked_at <> trim(NEW.revoked_at)))
  OR (NEW.last_used_at IS NOT NULL AND (trim(NEW.last_used_at) = '' OR NEW.last_used_at <> trim(NEW.last_used_at)))
  OR (NEW.last_used_ip IS NOT NULL AND (trim(NEW.last_used_ip) = '' OR NEW.last_used_ip <> trim(NEW.last_used_ip)))
BEGIN
  SELECT RAISE(ABORT, 'portal access token detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_portal_access_tokens_project_canon_insert
BEFORE INSERT ON portal_access_tokens
FOR EACH ROW
WHEN NEW.client_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM project_participants
    WHERE project_participants.project_id = NEW.project_id
      AND project_participants.client_id = NEW.client_id
  )
BEGIN
  SELECT RAISE(ABORT, 'portal access token client must belong to token project');
END;

CREATE TRIGGER IF NOT EXISTS trg_portal_access_tokens_project_canon_update
BEFORE UPDATE OF project_id, client_id ON portal_access_tokens
FOR EACH ROW
WHEN NEW.client_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM project_participants
    WHERE project_participants.project_id = NEW.project_id
      AND project_participants.client_id = NEW.client_id
  )
BEGIN
  SELECT RAISE(ABORT, 'portal access token client must belong to token project');
END;
