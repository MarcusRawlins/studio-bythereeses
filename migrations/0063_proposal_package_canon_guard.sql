CREATE TRIGGER IF NOT EXISTS trg_proposals_identity_canon_insert
BEFORE INSERT ON proposals
FOR EACH ROW
WHEN NEW.title IS NULL
  OR trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR NEW.status NOT IN ('draft', 'ready', 'sent', 'viewed', 'accepted', 'declined', 'expired')
  OR NEW.contract_status NOT IN ('not_started', 'drafted', 'ready', 'signed')
  OR NEW.invoice_status NOT IN ('not_created', 'created')
  OR (NEW.total_cents IS NOT NULL AND NEW.total_cents < 0)
BEGIN
  SELECT CASE
    WHEN NEW.title IS NULL OR trim(NEW.title) = '' OR NEW.title <> trim(NEW.title)
      THEN RAISE(ABORT, 'proposal title must be trimmed non-empty text')
    WHEN NEW.status NOT IN ('draft', 'ready', 'sent', 'viewed', 'accepted', 'declined', 'expired')
      THEN RAISE(ABORT, 'proposal status must be canonical')
    WHEN NEW.contract_status NOT IN ('not_started', 'drafted', 'ready', 'signed')
      THEN RAISE(ABORT, 'proposal contract status must be canonical')
    WHEN NEW.invoice_status NOT IN ('not_created', 'created')
      THEN RAISE(ABORT, 'proposal invoice status must be canonical')
    ELSE RAISE(ABORT, 'proposal totals must be canonical non-negative integers')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_proposals_identity_canon_update
BEFORE UPDATE OF title, status, contract_status, invoice_status, total_cents ON proposals
FOR EACH ROW
WHEN NEW.title IS NULL
  OR trim(NEW.title) = ''
  OR NEW.title <> trim(NEW.title)
  OR NEW.status NOT IN ('draft', 'ready', 'sent', 'viewed', 'accepted', 'declined', 'expired')
  OR NEW.contract_status NOT IN ('not_started', 'drafted', 'ready', 'signed')
  OR NEW.invoice_status NOT IN ('not_created', 'created')
  OR (NEW.total_cents IS NOT NULL AND NEW.total_cents < 0)
BEGIN
  SELECT CASE
    WHEN NEW.title IS NULL OR trim(NEW.title) = '' OR NEW.title <> trim(NEW.title)
      THEN RAISE(ABORT, 'proposal title must be trimmed non-empty text')
    WHEN NEW.status NOT IN ('draft', 'ready', 'sent', 'viewed', 'accepted', 'declined', 'expired')
      THEN RAISE(ABORT, 'proposal status must be canonical')
    WHEN NEW.contract_status NOT IN ('not_started', 'drafted', 'ready', 'signed')
      THEN RAISE(ABORT, 'proposal contract status must be canonical')
    WHEN NEW.invoice_status NOT IN ('not_created', 'created')
      THEN RAISE(ABORT, 'proposal invoice status must be canonical')
    ELSE RAISE(ABORT, 'proposal totals must be canonical non-negative integers')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_proposals_detail_text_canon_insert
BEFORE INSERT ON proposals
FOR EACH ROW
WHEN (NEW.package_name IS NOT NULL AND (trim(NEW.package_name) = '' OR NEW.package_name <> trim(NEW.package_name)))
  OR (NEW.valid_until IS NOT NULL AND (trim(NEW.valid_until) = '' OR NEW.valid_until <> trim(NEW.valid_until)))
  OR (NEW.scope_summary IS NOT NULL AND (trim(NEW.scope_summary) = '' OR NEW.scope_summary <> trim(NEW.scope_summary)))
  OR (NEW.contract_template_id IS NOT NULL AND (trim(NEW.contract_template_id) = '' OR NEW.contract_template_id <> trim(NEW.contract_template_id)))
  OR (NEW.contract_title IS NOT NULL AND (trim(NEW.contract_title) = '' OR NEW.contract_title <> trim(NEW.contract_title)))
  OR (NEW.contract_body IS NOT NULL AND (trim(NEW.contract_body) = '' OR NEW.contract_body <> trim(NEW.contract_body)))
  OR (NEW.sent_at IS NOT NULL AND (trim(NEW.sent_at) = '' OR NEW.sent_at <> trim(NEW.sent_at)))
  OR (NEW.accepted_at IS NOT NULL AND (trim(NEW.accepted_at) = '' OR NEW.accepted_at <> trim(NEW.accepted_at)))
  OR (NEW.signed_at IS NOT NULL AND (trim(NEW.signed_at) = '' OR NEW.signed_at <> trim(NEW.signed_at)))
  OR (NEW.signer_name IS NOT NULL AND (trim(NEW.signer_name) = '' OR NEW.signer_name <> trim(NEW.signer_name)))
  OR (NEW.signer_email IS NOT NULL AND (trim(NEW.signer_email) = '' OR NEW.signer_email <> trim(NEW.signer_email) OR NEW.signer_email <> lower(NEW.signer_email)))
  OR (NEW.signature_ip IS NOT NULL AND (trim(NEW.signature_ip) = '' OR NEW.signature_ip <> trim(NEW.signature_ip)))
  OR (NEW.signature_user_agent IS NOT NULL AND (trim(NEW.signature_user_agent) = '' OR NEW.signature_user_agent <> trim(NEW.signature_user_agent)))
  OR (NEW.signature_consent_text IS NOT NULL AND (trim(NEW.signature_consent_text) = '' OR NEW.signature_consent_text <> trim(NEW.signature_consent_text)))
  OR (NEW.signature_consent_version IS NOT NULL AND (trim(NEW.signature_consent_version) = '' OR NEW.signature_consent_version <> trim(NEW.signature_consent_version)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
BEGIN
  SELECT CASE
    WHEN NEW.signer_email IS NOT NULL
      AND (trim(NEW.signer_email) = '' OR NEW.signer_email <> trim(NEW.signer_email) OR NEW.signer_email <> lower(NEW.signer_email))
    THEN RAISE(ABORT, 'proposal signer email must be lowercase and trimmed')
    ELSE RAISE(ABORT, 'proposal detail text must be null or trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_proposals_detail_text_canon_update
BEFORE UPDATE OF package_name, valid_until, scope_summary, contract_template_id, contract_title, contract_body, sent_at, accepted_at, signed_at, signer_name, signer_email, signature_ip, signature_user_agent, signature_consent_text, signature_consent_version, source_type, source_id ON proposals
FOR EACH ROW
WHEN (NEW.package_name IS NOT NULL AND (trim(NEW.package_name) = '' OR NEW.package_name <> trim(NEW.package_name)))
  OR (NEW.valid_until IS NOT NULL AND (trim(NEW.valid_until) = '' OR NEW.valid_until <> trim(NEW.valid_until)))
  OR (NEW.scope_summary IS NOT NULL AND (trim(NEW.scope_summary) = '' OR NEW.scope_summary <> trim(NEW.scope_summary)))
  OR (NEW.contract_template_id IS NOT NULL AND (trim(NEW.contract_template_id) = '' OR NEW.contract_template_id <> trim(NEW.contract_template_id)))
  OR (NEW.contract_title IS NOT NULL AND (trim(NEW.contract_title) = '' OR NEW.contract_title <> trim(NEW.contract_title)))
  OR (NEW.contract_body IS NOT NULL AND (trim(NEW.contract_body) = '' OR NEW.contract_body <> trim(NEW.contract_body)))
  OR (NEW.sent_at IS NOT NULL AND (trim(NEW.sent_at) = '' OR NEW.sent_at <> trim(NEW.sent_at)))
  OR (NEW.accepted_at IS NOT NULL AND (trim(NEW.accepted_at) = '' OR NEW.accepted_at <> trim(NEW.accepted_at)))
  OR (NEW.signed_at IS NOT NULL AND (trim(NEW.signed_at) = '' OR NEW.signed_at <> trim(NEW.signed_at)))
  OR (NEW.signer_name IS NOT NULL AND (trim(NEW.signer_name) = '' OR NEW.signer_name <> trim(NEW.signer_name)))
  OR (NEW.signer_email IS NOT NULL AND (trim(NEW.signer_email) = '' OR NEW.signer_email <> trim(NEW.signer_email) OR NEW.signer_email <> lower(NEW.signer_email)))
  OR (NEW.signature_ip IS NOT NULL AND (trim(NEW.signature_ip) = '' OR NEW.signature_ip <> trim(NEW.signature_ip)))
  OR (NEW.signature_user_agent IS NOT NULL AND (trim(NEW.signature_user_agent) = '' OR NEW.signature_user_agent <> trim(NEW.signature_user_agent)))
  OR (NEW.signature_consent_text IS NOT NULL AND (trim(NEW.signature_consent_text) = '' OR NEW.signature_consent_text <> trim(NEW.signature_consent_text)))
  OR (NEW.signature_consent_version IS NOT NULL AND (trim(NEW.signature_consent_version) = '' OR NEW.signature_consent_version <> trim(NEW.signature_consent_version)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
BEGIN
  SELECT CASE
    WHEN NEW.signer_email IS NOT NULL
      AND (trim(NEW.signer_email) = '' OR NEW.signer_email <> trim(NEW.signer_email) OR NEW.signer_email <> lower(NEW.signer_email))
    THEN RAISE(ABORT, 'proposal signer email must be lowercase and trimmed')
    ELSE RAISE(ABORT, 'proposal detail text must be null or trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_proposals_selected_options_canon_insert
BEFORE INSERT ON proposals
FOR EACH ROW
WHEN NEW.selected_optional_line_item_ids_json IS NOT NULL
  AND (
    trim(NEW.selected_optional_line_item_ids_json) = ''
    OR NEW.selected_optional_line_item_ids_json <> trim(NEW.selected_optional_line_item_ids_json)
    OR json_valid(NEW.selected_optional_line_item_ids_json) = 0
    OR json_type(NEW.selected_optional_line_item_ids_json) <> 'array'
  )
BEGIN
  SELECT RAISE(ABORT, 'proposal selected options must be null or canonical json array text');
END;

CREATE TRIGGER IF NOT EXISTS trg_proposals_selected_options_canon_update
BEFORE UPDATE OF selected_optional_line_item_ids_json ON proposals
FOR EACH ROW
WHEN NEW.selected_optional_line_item_ids_json IS NOT NULL
  AND (
    trim(NEW.selected_optional_line_item_ids_json) = ''
    OR NEW.selected_optional_line_item_ids_json <> trim(NEW.selected_optional_line_item_ids_json)
    OR json_valid(NEW.selected_optional_line_item_ids_json) = 0
    OR json_type(NEW.selected_optional_line_item_ids_json) <> 'array'
  )
BEGIN
  SELECT RAISE(ABORT, 'proposal selected options must be null or canonical json array text');
END;

CREATE TRIGGER IF NOT EXISTS trg_proposal_line_items_identity_canon_insert
BEFORE INSERT ON proposal_line_items
FOR EACH ROW
WHEN NEW.name IS NULL
  OR trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
  OR (NEW.description IS NOT NULL AND (trim(NEW.description) = '' OR NEW.description <> trim(NEW.description)))
  OR NEW.quantity < 1
  OR NEW.unit_price_cents < 0
  OR NEW.is_optional NOT IN (0, 1)
  OR NEW.sort_order < 0
BEGIN
  SELECT CASE
    WHEN NEW.name IS NULL OR trim(NEW.name) = '' OR NEW.name <> trim(NEW.name)
      THEN RAISE(ABORT, 'proposal line item name must be trimmed non-empty text')
    WHEN NEW.description IS NOT NULL AND (trim(NEW.description) = '' OR NEW.description <> trim(NEW.description))
      THEN RAISE(ABORT, 'proposal line item description must be null or trimmed non-empty text')
    WHEN NEW.quantity < 1
      THEN RAISE(ABORT, 'proposal line item quantity must be canonical')
    WHEN NEW.unit_price_cents < 0
      THEN RAISE(ABORT, 'proposal line item price must be canonical')
    WHEN NEW.is_optional NOT IN (0, 1)
      THEN RAISE(ABORT, 'proposal line item optional flag must be canonical')
    ELSE RAISE(ABORT, 'proposal line item sort order must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_proposal_line_items_identity_canon_update
BEFORE UPDATE OF name, description, quantity, unit_price_cents, is_optional, sort_order ON proposal_line_items
FOR EACH ROW
WHEN NEW.name IS NULL
  OR trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
  OR (NEW.description IS NOT NULL AND (trim(NEW.description) = '' OR NEW.description <> trim(NEW.description)))
  OR NEW.quantity < 1
  OR NEW.unit_price_cents < 0
  OR NEW.is_optional NOT IN (0, 1)
  OR NEW.sort_order < 0
BEGIN
  SELECT CASE
    WHEN NEW.name IS NULL OR trim(NEW.name) = '' OR NEW.name <> trim(NEW.name)
      THEN RAISE(ABORT, 'proposal line item name must be trimmed non-empty text')
    WHEN NEW.description IS NOT NULL AND (trim(NEW.description) = '' OR NEW.description <> trim(NEW.description))
      THEN RAISE(ABORT, 'proposal line item description must be null or trimmed non-empty text')
    WHEN NEW.quantity < 1
      THEN RAISE(ABORT, 'proposal line item quantity must be canonical')
    WHEN NEW.unit_price_cents < 0
      THEN RAISE(ABORT, 'proposal line item price must be canonical')
    WHEN NEW.is_optional NOT IN (0, 1)
      THEN RAISE(ABORT, 'proposal line item optional flag must be canonical')
    ELSE RAISE(ABORT, 'proposal line item sort order must be canonical')
  END;
END;
