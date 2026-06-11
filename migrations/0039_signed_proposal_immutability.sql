CREATE TRIGGER IF NOT EXISTS trg_proposals_signed_immutable
BEFORE UPDATE OF
  title,
  status,
  package_name,
  total_cents,
  valid_until,
  scope_summary,
  sent_at,
  accepted_at,
  signed_at,
  signer_name,
  signer_email,
  signature_ip,
  signature_user_agent,
  signature_consent_text,
  signature_consent_version,
  contract_status,
  contract_template_id,
  contract_title,
  contract_body,
  selected_optional_line_item_ids_json
ON proposals
FOR EACH ROW
WHEN
  OLD.accepted_at IS NOT NULL
  OR OLD.signed_at IS NOT NULL
  OR OLD.status = 'accepted'
  OR OLD.contract_status = 'signed'
BEGIN
  SELECT RAISE(ABORT, 'signed proposal package is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_proposal_line_items_signed_insert
BEFORE INSERT ON proposal_line_items
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM proposals
  WHERE id = NEW.proposal_id
    AND (
      accepted_at IS NOT NULL
      OR signed_at IS NOT NULL
      OR status = 'accepted'
      OR contract_status = 'signed'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'signed proposal line items are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_proposal_line_items_signed_update
BEFORE UPDATE OF name, description, quantity, unit_price_cents, is_optional, sort_order ON proposal_line_items
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM proposals
  WHERE id = OLD.proposal_id
    AND (
      accepted_at IS NOT NULL
      OR signed_at IS NOT NULL
      OR status = 'accepted'
      OR contract_status = 'signed'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'signed proposal line items are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_proposal_line_items_signed_delete
BEFORE DELETE ON proposal_line_items
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM proposals
  WHERE id = OLD.proposal_id
    AND (
      accepted_at IS NOT NULL
      OR signed_at IS NOT NULL
      OR status = 'accepted'
      OR contract_status = 'signed'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'signed proposal line items are immutable');
END;
