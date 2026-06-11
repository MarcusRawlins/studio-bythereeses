CREATE TRIGGER IF NOT EXISTS trg_invoices_identity_canon_insert
BEFORE INSERT ON invoices
FOR EACH ROW
WHEN NEW.invoice_number IS NULL
  OR trim(NEW.invoice_number) = ''
  OR NEW.invoice_number <> trim(NEW.invoice_number)
  OR NEW.status NOT IN ('draft', 'sent', 'overdue', 'void', 'paid', 'partially_paid')
  OR NEW.total_cents < 0
  OR NEW.amount_paid_cents < 0
BEGIN
  SELECT CASE
    WHEN NEW.invoice_number IS NULL OR trim(NEW.invoice_number) = '' OR NEW.invoice_number <> trim(NEW.invoice_number)
      THEN RAISE(ABORT, 'invoice number must be trimmed non-empty text')
    WHEN NEW.status NOT IN ('draft', 'sent', 'overdue', 'void', 'paid', 'partially_paid')
      THEN RAISE(ABORT, 'invoice status must be canonical')
    ELSE RAISE(ABORT, 'invoice totals must be canonical non-negative integers')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_identity_canon_update
BEFORE UPDATE OF invoice_number, status, total_cents, amount_paid_cents ON invoices
FOR EACH ROW
WHEN NEW.invoice_number IS NULL
  OR trim(NEW.invoice_number) = ''
  OR NEW.invoice_number <> trim(NEW.invoice_number)
  OR NEW.status NOT IN ('draft', 'sent', 'overdue', 'void', 'paid', 'partially_paid')
  OR NEW.total_cents < 0
  OR NEW.amount_paid_cents < 0
BEGIN
  SELECT CASE
    WHEN NEW.invoice_number IS NULL OR trim(NEW.invoice_number) = '' OR NEW.invoice_number <> trim(NEW.invoice_number)
      THEN RAISE(ABORT, 'invoice number must be trimmed non-empty text')
    WHEN NEW.status NOT IN ('draft', 'sent', 'overdue', 'void', 'paid', 'partially_paid')
      THEN RAISE(ABORT, 'invoice status must be canonical')
    ELSE RAISE(ABORT, 'invoice totals must be canonical non-negative integers')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_fee_canon_insert
BEFORE INSERT ON invoices
FOR EACH ROW
WHEN NEW.card_fee_policy NOT IN ('studio_absorbs', 'client_pays')
  OR NEW.card_fee_percent_bps < 0
  OR NEW.card_fee_fixed_cents < 0
  OR NEW.card_fee_amount_cents < 0
BEGIN
  SELECT CASE
    WHEN NEW.card_fee_policy NOT IN ('studio_absorbs', 'client_pays')
      THEN RAISE(ABORT, 'invoice card fee policy must be canonical')
    ELSE RAISE(ABORT, 'invoice card fee amounts must be canonical non-negative integers')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_fee_canon_update
BEFORE UPDATE OF card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents ON invoices
FOR EACH ROW
WHEN NEW.card_fee_policy NOT IN ('studio_absorbs', 'client_pays')
  OR NEW.card_fee_percent_bps < 0
  OR NEW.card_fee_fixed_cents < 0
  OR NEW.card_fee_amount_cents < 0
BEGIN
  SELECT CASE
    WHEN NEW.card_fee_policy NOT IN ('studio_absorbs', 'client_pays')
      THEN RAISE(ABORT, 'invoice card fee policy must be canonical')
    ELSE RAISE(ABORT, 'invoice card fee amounts must be canonical non-negative integers')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_detail_text_canon_insert
BEFORE INSERT ON invoices
FOR EACH ROW
WHEN (NEW.due_date IS NOT NULL AND (trim(NEW.due_date) = '' OR NEW.due_date <> trim(NEW.due_date)))
  OR (NEW.payment_notes IS NOT NULL AND (trim(NEW.payment_notes) = '' OR NEW.payment_notes <> trim(NEW.payment_notes)))
  OR (NEW.stripe_payment_link IS NOT NULL AND (trim(NEW.stripe_payment_link) = '' OR NEW.stripe_payment_link <> trim(NEW.stripe_payment_link)))
  OR (NEW.zelle_info IS NOT NULL AND (trim(NEW.zelle_info) = '' OR NEW.zelle_info <> trim(NEW.zelle_info)))
  OR (NEW.venmo_info IS NOT NULL AND (trim(NEW.venmo_info) = '' OR NEW.venmo_info <> trim(NEW.venmo_info)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
  OR (NEW.sent_at IS NOT NULL AND (trim(NEW.sent_at) = '' OR NEW.sent_at <> trim(NEW.sent_at)))
  OR (NEW.paid_at IS NOT NULL AND (trim(NEW.paid_at) = '' OR NEW.paid_at <> trim(NEW.paid_at)))
BEGIN
  SELECT RAISE(ABORT, 'invoice detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_detail_text_canon_update
BEFORE UPDATE OF due_date, payment_notes, stripe_payment_link, zelle_info, venmo_info, source_type, source_id, sent_at, paid_at ON invoices
FOR EACH ROW
WHEN (NEW.due_date IS NOT NULL AND (trim(NEW.due_date) = '' OR NEW.due_date <> trim(NEW.due_date)))
  OR (NEW.payment_notes IS NOT NULL AND (trim(NEW.payment_notes) = '' OR NEW.payment_notes <> trim(NEW.payment_notes)))
  OR (NEW.stripe_payment_link IS NOT NULL AND (trim(NEW.stripe_payment_link) = '' OR NEW.stripe_payment_link <> trim(NEW.stripe_payment_link)))
  OR (NEW.zelle_info IS NOT NULL AND (trim(NEW.zelle_info) = '' OR NEW.zelle_info <> trim(NEW.zelle_info)))
  OR (NEW.venmo_info IS NOT NULL AND (trim(NEW.venmo_info) = '' OR NEW.venmo_info <> trim(NEW.venmo_info)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
  OR (NEW.sent_at IS NOT NULL AND (trim(NEW.sent_at) = '' OR NEW.sent_at <> trim(NEW.sent_at)))
  OR (NEW.paid_at IS NOT NULL AND (trim(NEW.paid_at) = '' OR NEW.paid_at <> trim(NEW.paid_at)))
BEGIN
  SELECT RAISE(ABORT, 'invoice detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_accepted_methods_canon_insert
BEFORE INSERT ON invoices
FOR EACH ROW
WHEN NEW.accepted_payment_methods_json IS NOT NULL
  AND (
    trim(NEW.accepted_payment_methods_json) = ''
    OR NEW.accepted_payment_methods_json <> trim(NEW.accepted_payment_methods_json)
    OR json_valid(NEW.accepted_payment_methods_json) = 0
    OR json_type(NEW.accepted_payment_methods_json) <> 'array'
  )
BEGIN
  SELECT RAISE(ABORT, 'invoice accepted payment methods must be null or canonical json array text');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_accepted_methods_canon_update
BEFORE UPDATE OF accepted_payment_methods_json ON invoices
FOR EACH ROW
WHEN NEW.accepted_payment_methods_json IS NOT NULL
  AND (
    trim(NEW.accepted_payment_methods_json) = ''
    OR NEW.accepted_payment_methods_json <> trim(NEW.accepted_payment_methods_json)
    OR json_valid(NEW.accepted_payment_methods_json) = 0
    OR json_type(NEW.accepted_payment_methods_json) <> 'array'
  )
BEGIN
  SELECT RAISE(ABORT, 'invoice accepted payment methods must be null or canonical json array text');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_identity_canon_insert
BEFORE INSERT ON invoice_payments
FOR EACH ROW
WHEN NEW.label IS NULL
  OR trim(NEW.label) = ''
  OR NEW.label <> trim(NEW.label)
  OR NEW.status NOT IN ('pending', 'paid', 'waived', 'refunded')
  OR NEW.amount_cents < 0
BEGIN
  SELECT CASE
    WHEN NEW.label IS NULL OR trim(NEW.label) = '' OR NEW.label <> trim(NEW.label)
      THEN RAISE(ABORT, 'invoice payment label must be trimmed non-empty text')
    WHEN NEW.status NOT IN ('pending', 'paid', 'waived', 'refunded')
      THEN RAISE(ABORT, 'invoice payment status must be canonical')
    ELSE RAISE(ABORT, 'invoice payment amount must be canonical non-negative integer')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_identity_canon_update
BEFORE UPDATE OF label, status, amount_cents ON invoice_payments
FOR EACH ROW
WHEN NEW.label IS NULL
  OR trim(NEW.label) = ''
  OR NEW.label <> trim(NEW.label)
  OR NEW.status NOT IN ('pending', 'paid', 'waived', 'refunded')
  OR NEW.amount_cents < 0
BEGIN
  SELECT CASE
    WHEN NEW.label IS NULL OR trim(NEW.label) = '' OR NEW.label <> trim(NEW.label)
      THEN RAISE(ABORT, 'invoice payment label must be trimmed non-empty text')
    WHEN NEW.status NOT IN ('pending', 'paid', 'waived', 'refunded')
      THEN RAISE(ABORT, 'invoice payment status must be canonical')
    ELSE RAISE(ABORT, 'invoice payment amount must be canonical non-negative integer')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_ledger_canon_insert
BEFORE INSERT ON invoice_payments
FOR EACH ROW
WHEN NEW.paid_amount_cents < 0
  OR NEW.client_fee_cents < 0
  OR NEW.processing_fee_cents < 0
  OR NEW.gross_collected_cents < 0
  OR NEW.net_deposit_cents < 0
BEGIN
  SELECT RAISE(ABORT, 'invoice payment ledger amounts must be canonical non-negative integers');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_ledger_canon_update
BEFORE UPDATE OF paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents ON invoice_payments
FOR EACH ROW
WHEN NEW.paid_amount_cents < 0
  OR NEW.client_fee_cents < 0
  OR NEW.processing_fee_cents < 0
  OR NEW.gross_collected_cents < 0
  OR NEW.net_deposit_cents < 0
BEGIN
  SELECT RAISE(ABORT, 'invoice payment ledger amounts must be canonical non-negative integers');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_detail_text_canon_insert
BEFORE INSERT ON invoice_payments
FOR EACH ROW
WHEN (NEW.due_date IS NOT NULL AND (trim(NEW.due_date) = '' OR NEW.due_date <> trim(NEW.due_date)))
  OR (NEW.paid_at IS NOT NULL AND (trim(NEW.paid_at) = '' OR NEW.paid_at <> trim(NEW.paid_at)))
  OR (NEW.payment_method IS NOT NULL AND (trim(NEW.payment_method) = '' OR NEW.payment_method <> trim(NEW.payment_method)))
  OR (NEW.external_payment_id IS NOT NULL AND (trim(NEW.external_payment_id) = '' OR NEW.external_payment_id <> trim(NEW.external_payment_id)))
  OR (NEW.notes IS NOT NULL AND (trim(NEW.notes) = '' OR NEW.notes <> trim(NEW.notes)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
BEGIN
  SELECT RAISE(ABORT, 'invoice payment detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_payments_detail_text_canon_update
BEFORE UPDATE OF due_date, paid_at, payment_method, external_payment_id, notes, source_type, source_id ON invoice_payments
FOR EACH ROW
WHEN (NEW.due_date IS NOT NULL AND (trim(NEW.due_date) = '' OR NEW.due_date <> trim(NEW.due_date)))
  OR (NEW.paid_at IS NOT NULL AND (trim(NEW.paid_at) = '' OR NEW.paid_at <> trim(NEW.paid_at)))
  OR (NEW.payment_method IS NOT NULL AND (trim(NEW.payment_method) = '' OR NEW.payment_method <> trim(NEW.payment_method)))
  OR (NEW.external_payment_id IS NOT NULL AND (trim(NEW.external_payment_id) = '' OR NEW.external_payment_id <> trim(NEW.external_payment_id)))
  OR (NEW.notes IS NOT NULL AND (trim(NEW.notes) = '' OR NEW.notes <> trim(NEW.notes)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
BEGIN
  SELECT RAISE(ABORT, 'invoice payment detail text must be null or trimmed non-empty text');
END;
