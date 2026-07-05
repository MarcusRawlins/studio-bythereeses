-- Phase 6.5 — portal self-service email magic-link login.
--
-- Additive, backward-compatible. `kind` defaults to 'session' so every existing
-- portal token keeps its exact behavior; `consumed_at` / `request_batch_id` are
-- nullable and only used by the new magic-request lifecycle.
ALTER TABLE portal_access_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'session';
ALTER TABLE portal_access_tokens ADD COLUMN consumed_at TEXT;
ALTER TABLE portal_access_tokens ADD COLUMN request_batch_id TEXT;

-- Per-email rate query (count recent magic-request batches for a client).
CREATE INDEX IF NOT EXISTS idx_portal_tokens_kind_client
  ON portal_access_tokens (client_id, kind, created_at);

-- [N5] SQLite cannot ALTER a trigger, and `CREATE TRIGGER IF NOT EXISTS`
-- silently no-ops when a same-named trigger already exists (from migration
-- 0069). So the 0069 portal-token detail-text canon guards must be DROPped and
-- re-CREATEd to (a) fold `consumed_at` into both the `UPDATE OF` column list AND
-- the `WHEN` predicate (consumePortalMagicLink writes it, so the guard must fire
-- on that column) and (b) add a `kind` domain guard. The identity/project canon
-- triggers are unchanged.
DROP TRIGGER IF EXISTS trg_portal_access_tokens_detail_text_canon_insert;
DROP TRIGGER IF EXISTS trg_portal_access_tokens_detail_text_canon_update;

CREATE TRIGGER trg_portal_access_tokens_detail_text_canon_insert
BEFORE INSERT ON portal_access_tokens
FOR EACH ROW
WHEN (NEW.label IS NOT NULL AND (trim(NEW.label) = '' OR NEW.label <> trim(NEW.label)))
  OR (NEW.revoked_at IS NOT NULL AND (trim(NEW.revoked_at) = '' OR NEW.revoked_at <> trim(NEW.revoked_at)))
  OR (NEW.last_used_at IS NOT NULL AND (trim(NEW.last_used_at) = '' OR NEW.last_used_at <> trim(NEW.last_used_at)))
  OR (NEW.last_used_ip IS NOT NULL AND (trim(NEW.last_used_ip) = '' OR NEW.last_used_ip <> trim(NEW.last_used_ip)))
  OR (NEW.consumed_at IS NOT NULL AND (trim(NEW.consumed_at) = '' OR NEW.consumed_at <> trim(NEW.consumed_at)))
  OR NEW.kind IS NULL
  OR NEW.kind NOT IN ('session', 'magic_request')
BEGIN
  SELECT RAISE(ABORT, 'portal access token detail text must be null or trimmed non-empty text and kind must be canonical');
END;

CREATE TRIGGER trg_portal_access_tokens_detail_text_canon_update
BEFORE UPDATE OF label, revoked_at, last_used_at, last_used_ip, consumed_at, kind ON portal_access_tokens
FOR EACH ROW
WHEN (NEW.label IS NOT NULL AND (trim(NEW.label) = '' OR NEW.label <> trim(NEW.label)))
  OR (NEW.revoked_at IS NOT NULL AND (trim(NEW.revoked_at) = '' OR NEW.revoked_at <> trim(NEW.revoked_at)))
  OR (NEW.last_used_at IS NOT NULL AND (trim(NEW.last_used_at) = '' OR NEW.last_used_at <> trim(NEW.last_used_at)))
  OR (NEW.last_used_ip IS NOT NULL AND (trim(NEW.last_used_ip) = '' OR NEW.last_used_ip <> trim(NEW.last_used_ip)))
  OR (NEW.consumed_at IS NOT NULL AND (trim(NEW.consumed_at) = '' OR NEW.consumed_at <> trim(NEW.consumed_at)))
  OR NEW.kind IS NULL
  OR NEW.kind NOT IN ('session', 'magic_request')
BEGIN
  SELECT RAISE(ABORT, 'portal access token detail text must be null or trimmed non-empty text and kind must be canonical');
END;
