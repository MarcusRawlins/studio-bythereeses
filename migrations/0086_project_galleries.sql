-- Phase 7a: provider-agnostic gallery delivery links.
--
-- Additive, backward-compatible. A project may have >1 gallery (engagement +
-- wedding + sneak-peek), so this is a child table, not columns on projects.
-- 7a stores an EXTERNAL provider delivery URL only — no owned assets, no R2
-- object, no provider API. status defaults to 'draft' so a freshly-attached
-- gallery is admin-only until explicitly marked 'delivered'.
--
-- passcode is stored plaintext because it is a display convenience the studio
-- types in from the provider's own gallery settings — it is not a Studio auth
-- secret and grants no Studio access; it is only ever shown to an
-- already-authenticated portal client.
CREATE TABLE IF NOT EXISTS project_galleries (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  passcode TEXT,
  delivered_at TEXT,
  expires_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_galleries_project ON project_galleries(project_id);
CREATE INDEX IF NOT EXISTS idx_project_galleries_project_status
  ON project_galleries(project_id, status);
