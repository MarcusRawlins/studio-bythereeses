import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { D1Database } from "@cloudflare/workers-types";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type BetterSqliteDatabase from "better-sqlite3";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const DB_PATH = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "local.db");

type LocalDatabase = {
  pragma: (statement: string) => unknown;
  exec: (statement: string) => unknown;
  prepare: (statement: string) => {
    all: (...params: unknown[]) => unknown[];
  };
};

let sqlite: BetterSqliteDatabase.Database | undefined;

function migrate(database: LocalDatabase) {
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  const migration = fs.readFileSync(path.join(process.cwd(), "migrations", "0000_initial.sql"), "utf8");
  database.exec(migration);
  const googleCalendarMigrationPath = path.join(process.cwd(), "migrations", "0001_google_calendar_connections.sql");
  if (fs.existsSync(googleCalendarMigrationPath)) {
    database.exec(fs.readFileSync(googleCalendarMigrationPath, "utf8"));
  }
  const schedulerManagementMigrationPath = path.join(process.cwd(), "migrations", "0002_scheduler_management.sql");
  if (fs.existsSync(schedulerManagementMigrationPath)) {
    const schedulerBookingColumns = new Set(
      database.prepare("PRAGMA table_info(scheduler_bookings)").all().map((column) => (column as { name: string }).name),
    );
    if (!schedulerBookingColumns.has("google_calendar_id")) {
      database.exec(fs.readFileSync(schedulerManagementMigrationPath, "utf8"));
    }
  }
  const questionnairesMigrationPath = path.join(process.cwd(), "migrations", "0003_questionnaires.sql");
  if (fs.existsSync(questionnairesMigrationPath)) {
    database.exec(fs.readFileSync(questionnairesMigrationPath, "utf8"));
  }

  const questionnaireCleanupMigrationPath = path.join(process.cwd(), "migrations", "0004_questionnaire_native_field_cleanup.sql");
  if (fs.existsSync(questionnaireCleanupMigrationPath)) {
    database.exec(fs.readFileSync(questionnaireCleanupMigrationPath, "utf8"));
  }

  const proposalClientLinksMigrationPath = path.join(process.cwd(), "migrations", "0005_proposal_client_links.sql");
  if (fs.existsSync(proposalClientLinksMigrationPath)) {
    database.exec(fs.readFileSync(proposalClientLinksMigrationPath, "utf8"));
  }

  const appSettingsMigrationPath = path.join(process.cwd(), "migrations", "0006_app_settings.sql");
  if (fs.existsSync(appSettingsMigrationPath)) {
    const invoiceColumns = new Set(
      database.prepare("PRAGMA table_info(invoices)").all().map((column) => (column as { name: string }).name),
    );
    if (!invoiceColumns.has("accepted_payment_methods_json")) {
      database.exec(fs.readFileSync(appSettingsMigrationPath, "utf8"));
    } else {
      database.exec(`
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
      `);
    }
  }

  const proposalContractMigrationPath = path.join(process.cwd(), "migrations", "0007_proposal_contract_foundation.sql");
  if (fs.existsSync(proposalContractMigrationPath)) {
    const proposalColumns = new Set(
      database.prepare("PRAGMA table_info(proposals)").all().map((column) => (column as { name: string }).name),
    );
    if (!proposalColumns.has("contract_body")) {
      database.exec(fs.readFileSync(proposalContractMigrationPath, "utf8"));
    } else {
      database.exec("CREATE INDEX IF NOT EXISTS idx_templates_type_status ON templates(type, status);");
    }
  }

  const optionalLineItemsMigrationPath = path.join(process.cwd(), "migrations", "0008_optional_proposal_line_items.sql");
  if (fs.existsSync(optionalLineItemsMigrationPath)) {
    const lineItemColumns = new Set(
      database.prepare("PRAGMA table_info(proposal_line_items)").all().map((column) => (column as { name: string }).name),
    );
    if (!lineItemColumns.has("is_optional")) {
      database.exec(fs.readFileSync(optionalLineItemsMigrationPath, "utf8"));
    }
  }

  const proposalSignaturesMigrationPath = path.join(process.cwd(), "migrations", "0009_proposal_signatures.sql");
  if (fs.existsSync(proposalSignaturesMigrationPath)) {
    const proposalColumns = new Set(
      database.prepare("PRAGMA table_info(proposals)").all().map((column) => (column as { name: string }).name),
    );
    if (!proposalColumns.has("signed_at")) {
      database.exec(fs.readFileSync(proposalSignaturesMigrationPath, "utf8"));
    }
  }

  const projectColumns = new Set(
    database.prepare("PRAGMA table_info(projects)").all().map((column) => (column as { name: string }).name),
  );
  const additions = [
    ["venue_address", "TEXT"],
    ["google_calendar_event_id", "TEXT"],
    ["calendar_sync_status", "TEXT NOT NULL DEFAULT 'not_connected'"],
  ] as const;

  for (const [name, definition] of additions) {
    if (!projectColumns.has(name)) {
      database.exec(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
    }
  }

  database.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_templates_type ON templates(type);
    CREATE INDEX IF NOT EXISTS idx_templates_status ON templates(status);
  `);

  database.exec(`
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
      contract_template_id TEXT,
      contract_title TEXT,
      contract_body TEXT,
      invoice_status TEXT NOT NULL DEFAULT 'not_created',
      sent_at TEXT,
      accepted_at TEXT,
      signed_at TEXT,
      signer_name TEXT,
      signer_email TEXT,
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
      is_optional INTEGER NOT NULL DEFAULT 0,
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
      accepted_payment_methods_json TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_proposals_project ON proposals(project_id);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
    CREATE INDEX IF NOT EXISTS idx_proposal_line_items_proposal ON proposal_line_items(proposal_id);
    CREATE TABLE IF NOT EXISTS proposal_access_tokens (
      id TEXT PRIMARY KEY NOT NULL,
      proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT,
      expires_at TEXT NOT NULL,
      sent_at TEXT,
      viewed_at TEXT,
      revoked_at TEXT,
      last_used_at TEXT,
      last_used_ip TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_proposal_tokens_proposal ON proposal_access_tokens(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_proposal_tokens_project ON proposal_access_tokens(project_id);
    CREATE INDEX IF NOT EXISTS idx_proposal_tokens_expires ON proposal_access_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices(project_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_proposal ON invoices(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_invoice_payments_due ON invoice_payments(due_date);
  `);

  const invoiceColumns = new Set(
    database.prepare("PRAGMA table_info(invoices)").all().map((column) => (column as { name: string }).name),
  );
  if (!invoiceColumns.has("accepted_payment_methods_json")) {
    database.exec("ALTER TABLE invoices ADD COLUMN accepted_payment_methods_json TEXT");
  }

  const proposalColumns = new Set(
    database.prepare("PRAGMA table_info(proposals)").all().map((column) => (column as { name: string }).name),
  );
  const proposalAdditions = [
    ["contract_template_id", "TEXT"],
    ["contract_title", "TEXT"],
    ["contract_body", "TEXT"],
    ["signed_at", "TEXT"],
    ["signer_name", "TEXT"],
    ["signer_email", "TEXT"],
  ] as const;

  for (const [name, definition] of proposalAdditions) {
    if (!proposalColumns.has(name)) {
      database.exec(`ALTER TABLE proposals ADD COLUMN ${name} ${definition}`);
    }
  }

  const proposalLineItemColumns = new Set(
    database.prepare("PRAGMA table_info(proposal_line_items)").all().map((column) => (column as { name: string }).name),
  );
  if (!proposalLineItemColumns.has("is_optional")) {
    database.exec("ALTER TABLE proposal_line_items ADD COLUMN is_optional INTEGER NOT NULL DEFAULT 0");
  }

  const schedulerMeetingTypeColumns = new Set(
    database.prepare("PRAGMA table_info(scheduler_meeting_types)").all().map((column) => (column as { name: string }).name),
  );
  const meetingTypeAdditions = [
    ["location_type", "TEXT NOT NULL DEFAULT 'zoom'"],
    ["location_label", "TEXT"],
    ["zoom_join_url", "TEXT"],
    ["invitee_questions_json", "TEXT"],
    ["collect_payment", "INTEGER NOT NULL DEFAULT 0"],
    ["price_cents", "INTEGER"],
    ["sms_opt_in_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["confirmation_message", "TEXT"],
  ] as const;

  for (const [name, definition] of meetingTypeAdditions) {
    if (!schedulerMeetingTypeColumns.has(name)) {
      database.exec(`ALTER TABLE scheduler_meeting_types ADD COLUMN ${name} ${definition}`);
    }
  }

  const schedulerBookingColumns = new Set(
    database.prepare("PRAGMA table_info(scheduler_bookings)").all().map((column) => (column as { name: string }).name),
  );
  const bookingAdditions = [
    ["sms_opt_in", "INTEGER NOT NULL DEFAULT 0"],
    ["invitee_answers_json", "TEXT"],
    ["cancelled_at", "TEXT"],
    ["cancellation_reason", "TEXT"],
    ["rescheduled_from_booking_id", "TEXT"],
    ["reminder_sent_at", "TEXT"],
    ["google_calendar_id", "TEXT"],
  ] as const;

  for (const [name, definition] of bookingAdditions) {
    if (!schedulerBookingColumns.has(name)) {
      database.exec(`ALTER TABLE scheduler_bookings ADD COLUMN ${name} ${definition}`);
    }
  }
}

function getD1Binding() {
  try {
    return (getCloudflareContext().env as { DB?: D1Database }).DB ?? null;
  } catch {
    return null;
  }
}

function getSqlite() {
  if (!sqlite) {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3") as typeof BetterSqliteDatabase;
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    sqlite = new Database(DB_PATH);
    migrate(sqlite as unknown as LocalDatabase);
  }
  return sqlite;
}

function createDb() {
  const d1 = getD1Binding();
  if (d1) return drizzleD1(d1, { schema });

  const require = createRequire(import.meta.url);
  const { drizzle } = require("drizzle-orm/better-sqlite3") as typeof import("drizzle-orm/better-sqlite3");
  return drizzle(getSqlite(), { schema });
}

// The same application code runs against local better-sqlite3 during development
// and Cloudflare D1 in production. Drizzle's two drivers expose compatible
// runtime APIs, but their generic types do not share one precise static type.
// Keep the runtime switch here so the rest of the CRM can stay driver-agnostic.
export const db = createDb() as unknown as DrizzleD1Database<typeof schema>;
export const rawDb = getSqlite;
