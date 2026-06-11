CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  preferred_name TEXT,
  instagram_handle TEXT,
  communication_preference TEXT,
  referral_source TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'wedding',
  stage TEXT NOT NULL DEFAULT 'inquiry',
  status TEXT NOT NULL DEFAULT 'active',
  event_date TEXT,
  venue_name TEXT,
  venue_address TEXT,
  city TEXT,
  state TEXT,
  budget_cents INTEGER,
  google_calendar_event_id TEXT,
  calendar_sync_status TEXT NOT NULL DEFAULT 'not_connected',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_events (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'wedding',
  title TEXT NOT NULL,
  event_date TEXT,
  venue_name TEXT,
  venue_address TEXT,
  city TEXT,
  state TEXT,
  google_calendar_event_id TEXT,
  calendar_sync_status TEXT NOT NULL DEFAULT 'not_connected',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_locations (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'other',
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  state TEXT,
  notes TEXT,
  source_type TEXT,
  source_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_participants (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'primary',
  is_primary_contact INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduler_meeting_types (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  buffer_minutes INTEGER NOT NULL DEFAULT 15,
  location_type TEXT NOT NULL DEFAULT 'zoom',
  location_label TEXT,
  zoom_join_url TEXT,
  invitee_questions_json TEXT,
  collect_payment INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER,
  sms_opt_in_enabled INTEGER NOT NULL DEFAULT 1,
  confirmation_message TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduler_settings (
  id TEXT PRIMARY KEY NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  booking_window_days INTEGER NOT NULL DEFAULT 30,
  minimum_notice_minutes INTEGER NOT NULL DEFAULT 240,
  availability_json TEXT NOT NULL,
  google_calendar_ids TEXT,
  google_create_calendar_id TEXT,
  zoom_join_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduler_bookings (
  id TEXT PRIMARY KEY NOT NULL,
  meeting_type_id TEXT NOT NULL REFERENCES scheduler_meeting_types(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  attendee_name TEXT NOT NULL,
  attendee_email TEXT NOT NULL,
  attendee_phone TEXT,
  sms_opt_in INTEGER NOT NULL DEFAULT 0,
  invitee_answers_json TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'booking_link',
  google_calendar_event_id TEXT,
  calendar_sync_status TEXT NOT NULL DEFAULT 'not_connected',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL DEFAULT 'email',
  name TEXT NOT NULL,
  trigger TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  package_name TEXT,
  total_cents INTEGER,
  valid_until TEXT,
  scope_summary TEXT,
  contract_status TEXT NOT NULL DEFAULT 'not_started',
  invoice_status TEXT NOT NULL DEFAULT 'not_created',
  sent_at TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS proposal_line_items (
  id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  proposal_id TEXT REFERENCES proposals(id) ON DELETE SET NULL,
  invoice_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',
  total_cents INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  payment_notes TEXT,
  stripe_payment_link TEXT,
  zelle_info TEXT,
  venmo_info TEXT,
  sent_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id TEXT PRIMARY KEY NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  paid_at TEXT,
  payment_method TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS portal_access_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  last_used_ip TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'admin',
  actor_name TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_stage ON projects(stage);
CREATE INDEX IF NOT EXISTS idx_projects_event_date ON projects(event_date);
CREATE INDEX IF NOT EXISTS idx_project_events_project ON project_events(project_id);
CREATE INDEX IF NOT EXISTS idx_project_events_event_date ON project_events(event_date);
CREATE INDEX IF NOT EXISTS idx_project_locations_project ON project_locations(project_id);
CREATE INDEX IF NOT EXISTS idx_project_participants_project ON project_participants(project_id);
CREATE INDEX IF NOT EXISTS idx_project_participants_client ON project_participants(client_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_start ON scheduler_bookings(start_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_meeting_type ON scheduler_bookings(meeting_type_id);
CREATE INDEX IF NOT EXISTS idx_templates_type ON templates(type);
CREATE INDEX IF NOT EXISTS idx_templates_status ON templates(status);
CREATE INDEX IF NOT EXISTS idx_proposals_project ON proposals(project_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposal_line_items_proposal ON proposal_line_items(proposal_id);
CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_invoices_proposal ON invoices(proposal_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_due ON invoice_payments(due_date);
CREATE INDEX IF NOT EXISTS idx_portal_tokens_project ON portal_access_tokens(project_id);
CREATE INDEX IF NOT EXISTS idx_portal_tokens_expires ON portal_access_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_activity_logs_project ON activity_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at);
