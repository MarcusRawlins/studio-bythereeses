CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY NOT NULL,
  business_name TEXT NOT NULL,
  public_brand_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  website_url TEXT,
  instagram_url TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  payment_methods_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE invoices ADD COLUMN accepted_payment_methods_json TEXT;
