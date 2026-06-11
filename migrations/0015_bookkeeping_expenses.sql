CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  email TEXT,
  website_url TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY NOT NULL,
  vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'general',
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'paid',
  paid_at TEXT,
  payment_method TEXT,
  external_payment_id TEXT,
  receipt_url TEXT,
  tax_deductible INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_expenses_project_paid
  ON expenses(project_id, paid_at);

CREATE INDEX IF NOT EXISTS idx_expenses_vendor_paid
  ON expenses(vendor_id, paid_at);

CREATE INDEX IF NOT EXISTS idx_expenses_status_paid
  ON expenses(status, paid_at);

CREATE INDEX IF NOT EXISTS idx_expenses_category_paid
  ON expenses(category, paid_at);
