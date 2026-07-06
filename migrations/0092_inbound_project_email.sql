-- Phase 14: two-way per-project email. Additive, idempotent.
-- inbound_message_id dedupes replayed inbound client replies (INSERT ON CONFLICT
-- DO NOTHING, never UPDATE from inbound). Separate from provider_message_id
-- (which holds the Twilio SID / Resend outbound id) to keep inbound dedupe clean.
ALTER TABLE project_communications ADD COLUMN inbound_message_id TEXT;
-- Dedupe is scoped to the THREAD, not globally: one client emailing two of their
-- projects' reply tokens (reply+<tokenA>@ AND reply+<tokenB>@) makes Cloudflare
-- invoke the Worker once per recipient with the SAME Message-ID. A global unique
-- index would let project A's row win and project B's identical Message-ID hit
-- ON CONFLICT DO NOTHING → 2xx → Worker does not forward → the message never
-- reaches project B and never reaches the human fallback = a silent cross-project
-- drop (Finding MEDIUM 2). Scoping to (project_id, inbound_message_id) makes a
-- replay to the SAME project an idempotent no-op while a genuine two-project
-- message correctly appends to both threads.
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_communications_project_inbound_message_id
  ON project_communications(project_id, inbound_message_id);
