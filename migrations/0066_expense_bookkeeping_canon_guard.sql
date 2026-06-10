CREATE TRIGGER IF NOT EXISTS trg_vendors_identity_canon_insert
BEFORE INSERT ON vendors
FOR EACH ROW
WHEN NEW.name IS NULL
  OR trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
  OR NEW.normalized_name IS NULL
  OR trim(NEW.normalized_name) = ''
  OR NEW.normalized_name <> trim(NEW.normalized_name)
  OR NEW.normalized_name <> lower(NEW.normalized_name)
BEGIN
  SELECT CASE
    WHEN NEW.name IS NULL OR trim(NEW.name) = '' OR NEW.name <> trim(NEW.name)
      THEN RAISE(ABORT, 'vendor name must be trimmed non-empty text')
    ELSE RAISE(ABORT, 'vendor normalized name must be lowercase and trimmed')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_vendors_identity_canon_update
BEFORE UPDATE OF name, normalized_name ON vendors
FOR EACH ROW
WHEN NEW.name IS NULL
  OR trim(NEW.name) = ''
  OR NEW.name <> trim(NEW.name)
  OR NEW.normalized_name IS NULL
  OR trim(NEW.normalized_name) = ''
  OR NEW.normalized_name <> trim(NEW.normalized_name)
  OR NEW.normalized_name <> lower(NEW.normalized_name)
BEGIN
  SELECT CASE
    WHEN NEW.name IS NULL OR trim(NEW.name) = '' OR NEW.name <> trim(NEW.name)
      THEN RAISE(ABORT, 'vendor name must be trimmed non-empty text')
    ELSE RAISE(ABORT, 'vendor normalized name must be lowercase and trimmed')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_vendors_detail_text_canon_insert
BEFORE INSERT ON vendors
FOR EACH ROW
WHEN (NEW.email IS NOT NULL AND (trim(NEW.email) = '' OR NEW.email <> trim(NEW.email) OR NEW.email <> lower(NEW.email)))
  OR (NEW.website_url IS NOT NULL AND (trim(NEW.website_url) = '' OR NEW.website_url <> trim(NEW.website_url)))
  OR (NEW.notes IS NOT NULL AND (trim(NEW.notes) = '' OR NEW.notes <> trim(NEW.notes)))
BEGIN
  SELECT CASE
    WHEN NEW.email IS NOT NULL
      AND (trim(NEW.email) = '' OR NEW.email <> trim(NEW.email) OR NEW.email <> lower(NEW.email))
    THEN RAISE(ABORT, 'vendor email must be lowercase and trimmed')
    ELSE RAISE(ABORT, 'vendor detail text must be null or trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_vendors_detail_text_canon_update
BEFORE UPDATE OF email, website_url, notes ON vendors
FOR EACH ROW
WHEN (NEW.email IS NOT NULL AND (trim(NEW.email) = '' OR NEW.email <> trim(NEW.email) OR NEW.email <> lower(NEW.email)))
  OR (NEW.website_url IS NOT NULL AND (trim(NEW.website_url) = '' OR NEW.website_url <> trim(NEW.website_url)))
  OR (NEW.notes IS NOT NULL AND (trim(NEW.notes) = '' OR NEW.notes <> trim(NEW.notes)))
BEGIN
  SELECT CASE
    WHEN NEW.email IS NOT NULL
      AND (trim(NEW.email) = '' OR NEW.email <> trim(NEW.email) OR NEW.email <> lower(NEW.email))
    THEN RAISE(ABORT, 'vendor email must be lowercase and trimmed')
    ELSE RAISE(ABORT, 'vendor detail text must be null or trimmed non-empty text')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_expenses_identity_canon_insert
BEFORE INSERT ON expenses
FOR EACH ROW
WHEN NEW.category IS NULL
  OR trim(NEW.category) = ''
  OR NEW.category <> trim(NEW.category)
  OR NEW.description IS NULL
  OR trim(NEW.description) = ''
  OR NEW.description <> trim(NEW.description)
  OR NEW.amount_cents < 0
  OR NEW.status NOT IN ('paid', 'unpaid', 'refunded', 'void')
  OR NEW.tax_deductible NOT IN (0, 1)
BEGIN
  SELECT CASE
    WHEN NEW.category IS NULL OR trim(NEW.category) = '' OR NEW.category <> trim(NEW.category)
      THEN RAISE(ABORT, 'expense category must be trimmed non-empty text')
    WHEN NEW.description IS NULL OR trim(NEW.description) = '' OR NEW.description <> trim(NEW.description)
      THEN RAISE(ABORT, 'expense description must be trimmed non-empty text')
    WHEN NEW.amount_cents < 0
      THEN RAISE(ABORT, 'expense amount must be canonical non-negative integer')
    WHEN NEW.status NOT IN ('paid', 'unpaid', 'refunded', 'void')
      THEN RAISE(ABORT, 'expense status must be canonical')
    ELSE RAISE(ABORT, 'expense tax deductible flag must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_expenses_identity_canon_update
BEFORE UPDATE OF category, description, amount_cents, status, tax_deductible ON expenses
FOR EACH ROW
WHEN NEW.category IS NULL
  OR trim(NEW.category) = ''
  OR NEW.category <> trim(NEW.category)
  OR NEW.description IS NULL
  OR trim(NEW.description) = ''
  OR NEW.description <> trim(NEW.description)
  OR NEW.amount_cents < 0
  OR NEW.status NOT IN ('paid', 'unpaid', 'refunded', 'void')
  OR NEW.tax_deductible NOT IN (0, 1)
BEGIN
  SELECT CASE
    WHEN NEW.category IS NULL OR trim(NEW.category) = '' OR NEW.category <> trim(NEW.category)
      THEN RAISE(ABORT, 'expense category must be trimmed non-empty text')
    WHEN NEW.description IS NULL OR trim(NEW.description) = '' OR NEW.description <> trim(NEW.description)
      THEN RAISE(ABORT, 'expense description must be trimmed non-empty text')
    WHEN NEW.amount_cents < 0
      THEN RAISE(ABORT, 'expense amount must be canonical non-negative integer')
    WHEN NEW.status NOT IN ('paid', 'unpaid', 'refunded', 'void')
      THEN RAISE(ABORT, 'expense status must be canonical')
    ELSE RAISE(ABORT, 'expense tax deductible flag must be canonical')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_expenses_detail_text_canon_insert
BEFORE INSERT ON expenses
FOR EACH ROW
WHEN (NEW.paid_at IS NOT NULL AND (trim(NEW.paid_at) = '' OR NEW.paid_at <> trim(NEW.paid_at)))
  OR (NEW.payment_method IS NOT NULL AND (trim(NEW.payment_method) = '' OR NEW.payment_method <> trim(NEW.payment_method)))
  OR (NEW.external_payment_id IS NOT NULL AND (trim(NEW.external_payment_id) = '' OR NEW.external_payment_id <> trim(NEW.external_payment_id)))
  OR (NEW.receipt_url IS NOT NULL AND (trim(NEW.receipt_url) = '' OR NEW.receipt_url <> trim(NEW.receipt_url)))
  OR (NEW.notes IS NOT NULL AND (trim(NEW.notes) = '' OR NEW.notes <> trim(NEW.notes)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
BEGIN
  SELECT RAISE(ABORT, 'expense detail text must be null or trimmed non-empty text');
END;

CREATE TRIGGER IF NOT EXISTS trg_expenses_detail_text_canon_update
BEFORE UPDATE OF paid_at, payment_method, external_payment_id, receipt_url, notes, source_type, source_id ON expenses
FOR EACH ROW
WHEN (NEW.paid_at IS NOT NULL AND (trim(NEW.paid_at) = '' OR NEW.paid_at <> trim(NEW.paid_at)))
  OR (NEW.payment_method IS NOT NULL AND (trim(NEW.payment_method) = '' OR NEW.payment_method <> trim(NEW.payment_method)))
  OR (NEW.external_payment_id IS NOT NULL AND (trim(NEW.external_payment_id) = '' OR NEW.external_payment_id <> trim(NEW.external_payment_id)))
  OR (NEW.receipt_url IS NOT NULL AND (trim(NEW.receipt_url) = '' OR NEW.receipt_url <> trim(NEW.receipt_url)))
  OR (NEW.notes IS NOT NULL AND (trim(NEW.notes) = '' OR NEW.notes <> trim(NEW.notes)))
  OR (NEW.source_type IS NOT NULL AND (trim(NEW.source_type) = '' OR NEW.source_type <> trim(NEW.source_type)))
  OR (NEW.source_id IS NOT NULL AND (trim(NEW.source_id) = '' OR NEW.source_id <> trim(NEW.source_id)))
BEGIN
  SELECT RAISE(ABORT, 'expense detail text must be null or trimmed non-empty text');
END;
