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

function addColumnIfMissing(database: LocalDatabase, tableName: string, columnName: string, definition: string) {
  const columns = new Set(
    database.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => (column as { name: string }).name),
  );
  if (columns.has(columnName)) return;

  try {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(`duplicate column name: ${columnName}`)) {
      throw error;
    }
  }
}

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
    const timelineQuestionnaire = database
      .prepare("SELECT id FROM questionnaires WHERE id = ?")
      .all("questionnaire-photography-timeline-vision");
    if (timelineQuestionnaire.length > 0) {
      database.exec(fs.readFileSync(questionnaireCleanupMigrationPath, "utf8"));
    }
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

  const studioCanonicalIndexesMigrationPath = path.join(process.cwd(), "migrations", "0010_studio_canonical_indexes.sql");
  if (fs.existsSync(studioCanonicalIndexesMigrationPath)) {
    database.exec(fs.readFileSync(studioCanonicalIndexesMigrationPath, "utf8"));
  }

  const projectTimelineItemsMigrationPath = path.join(process.cwd(), "migrations", "0011_project_timeline_items.sql");
  if (fs.existsSync(projectTimelineItemsMigrationPath)) {
    database.exec(fs.readFileSync(projectTimelineItemsMigrationPath, "utf8"));
  }

  const invoiceCardFeePolicyMigrationPath = path.join(process.cwd(), "migrations", "0012_invoice_card_fee_policy.sql");
  if (fs.existsSync(invoiceCardFeePolicyMigrationPath)) {
    const invoiceColumns = new Set(
      database.prepare("PRAGMA table_info(invoices)").all().map((column) => (column as { name: string }).name),
    );
    if (!invoiceColumns.has("card_fee_policy")) {
      database.exec(fs.readFileSync(invoiceCardFeePolicyMigrationPath, "utf8"));
    }
  }

  const agentTasksMigrationPath = path.join(process.cwd(), "migrations", "0013_agent_tasks.sql");
  if (fs.existsSync(agentTasksMigrationPath)) {
    database.exec(fs.readFileSync(agentTasksMigrationPath, "utf8"));
  }

  const invoicePaymentLedgerMigrationPath = path.join(process.cwd(), "migrations", "0014_invoice_payment_ledger.sql");
  if (fs.existsSync(invoicePaymentLedgerMigrationPath)) {
    const invoicePaymentColumns = new Set(
      database.prepare("PRAGMA table_info(invoice_payments)").all().map((column) => (column as { name: string }).name),
    );
    if (!invoicePaymentColumns.has("paid_amount_cents")) {
      database.exec(fs.readFileSync(invoicePaymentLedgerMigrationPath, "utf8"));
    }
  }

  const bookkeepingExpensesMigrationPath = path.join(process.cwd(), "migrations", "0015_bookkeeping_expenses.sql");
  if (fs.existsSync(bookkeepingExpensesMigrationPath)) {
    database.exec(fs.readFileSync(bookkeepingExpensesMigrationPath, "utf8"));
  }

  const proposalSignatureAuditMigrationPath = path.join(process.cwd(), "migrations", "0016_proposal_signature_audit.sql");
  if (fs.existsSync(proposalSignatureAuditMigrationPath)) {
    const proposalColumns = new Set(
      database.prepare("PRAGMA table_info(proposals)").all().map((column) => (column as { name: string }).name),
    );
    if (!proposalColumns.has("signature_ip")) {
      database.exec(fs.readFileSync(proposalSignatureAuditMigrationPath, "utf8"));
    }
  }

  const schedulerPaymentLinksMigrationPath = path.join(process.cwd(), "migrations", "0017_scheduler_payment_links.sql");
  if (fs.existsSync(schedulerPaymentLinksMigrationPath)) {
    const meetingTypeColumns = new Set(
      database.prepare("PRAGMA table_info(scheduler_meeting_types)").all().map((column) => (column as { name: string }).name),
    );
    if (!meetingTypeColumns.has("stripe_payment_link")) {
      database.exec(fs.readFileSync(schedulerPaymentLinksMigrationPath, "utf8"));
    }
  }

  const schedulerBookingPaymentLedgerMigrationPath = path.join(process.cwd(), "migrations", "0018_scheduler_booking_payment_ledger.sql");
  if (fs.existsSync(schedulerBookingPaymentLedgerMigrationPath)) {
    const bookingColumns = new Set(
      database.prepare("PRAGMA table_info(scheduler_bookings)").all().map((column) => (column as { name: string }).name),
    );
    if (!bookingColumns.has("payment_status")) {
      database.exec(fs.readFileSync(schedulerBookingPaymentLedgerMigrationPath, "utf8"));
    }
  }

  const projectSourcesMigrationPath = path.join(process.cwd(), "migrations", "0019_project_sources.sql");
  if (fs.existsSync(projectSourcesMigrationPath)) {
    database.exec(fs.readFileSync(projectSourcesMigrationPath, "utf8"));
  }

  const proposalSourceLinksMigrationPath = path.join(process.cwd(), "migrations", "0020_proposal_source_links.sql");
  if (fs.existsSync(proposalSourceLinksMigrationPath)) {
    const proposalColumns = new Set(
      database.prepare("PRAGMA table_info(proposals)").all().map((column) => (column as { name: string }).name),
    );
    if (!proposalColumns.has("source_type")) {
      database.exec(fs.readFileSync(proposalSourceLinksMigrationPath, "utf8"));
    }
  }

  const invoiceSourceLinksMigrationPath = path.join(process.cwd(), "migrations", "0021_invoice_source_links.sql");
  if (fs.existsSync(invoiceSourceLinksMigrationPath)) {
    const invoiceColumns = new Set(
      database.prepare("PRAGMA table_info(invoices)").all().map((column) => (column as { name: string }).name),
    );
    if (!invoiceColumns.has("source_type")) {
      database.exec(fs.readFileSync(invoiceSourceLinksMigrationPath, "utf8"));
    }
  }

  const expenseSourceLinksMigrationPath = path.join(process.cwd(), "migrations", "0022_expense_source_links.sql");
  if (fs.existsSync(expenseSourceLinksMigrationPath)) {
    const expenseColumns = new Set(
      database.prepare("PRAGMA table_info(expenses)").all().map((column) => (column as { name: string }).name),
    );
    if (!expenseColumns.has("source_type")) {
      database.exec(fs.readFileSync(expenseSourceLinksMigrationPath, "utf8"));
    }
  }

  const invoicePaymentSourceLinksMigrationPath = path.join(process.cwd(), "migrations", "0023_invoice_payment_source_links.sql");
  if (fs.existsSync(invoicePaymentSourceLinksMigrationPath)) {
    const invoicePaymentColumns = new Set(
      database.prepare("PRAGMA table_info(invoice_payments)").all().map((column) => (column as { name: string }).name),
    );
    if (!invoicePaymentColumns.has("source_type")) {
      database.exec(fs.readFileSync(invoicePaymentSourceLinksMigrationPath, "utf8"));
    }
  }

  const schedulerBookingPaymentSourceLinksMigrationPath = path.join(process.cwd(), "migrations", "0024_scheduler_booking_payment_source_links.sql");
  if (fs.existsSync(schedulerBookingPaymentSourceLinksMigrationPath)) {
    const bookingColumns = new Set(
      database.prepare("PRAGMA table_info(scheduler_bookings)").all().map((column) => (column as { name: string }).name),
    );
    if (!bookingColumns.has("payment_source_type")) {
      database.exec(fs.readFileSync(schedulerBookingPaymentSourceLinksMigrationPath, "utf8"));
    }
  }

  const projectCommunicationsMigrationPath = path.join(process.cwd(), "migrations", "0025_project_communications.sql");
  if (fs.existsSync(projectCommunicationsMigrationPath)) {
    database.exec(fs.readFileSync(projectCommunicationsMigrationPath, "utf8"));
  }

  const expenseReconciliationIndexesMigrationPath = path.join(process.cwd(), "migrations", "0026_expense_reconciliation_indexes.sql");
  if (fs.existsSync(expenseReconciliationIndexesMigrationPath)) {
    database.exec(fs.readFileSync(expenseReconciliationIndexesMigrationPath, "utf8"));
  }

  const projectScopedSourceIndexesMigrationPath = path.join(process.cwd(), "migrations", "0027_project_scoped_source_indexes.sql");
  if (fs.existsSync(projectScopedSourceIndexesMigrationPath)) {
    database.exec(fs.readFileSync(projectScopedSourceIndexesMigrationPath, "utf8"));
  }

  const agentTaskActiveDedupeIndexMigrationPath = path.join(process.cwd(), "migrations", "0028_agent_task_active_dedupe_index.sql");
  if (fs.existsSync(agentTaskActiveDedupeIndexMigrationPath)) {
    database.exec(fs.readFileSync(agentTaskActiveDedupeIndexMigrationPath, "utf8"));
  }

  const uniqueExternalPaymentIdsMigrationPath = path.join(process.cwd(), "migrations", "0029_unique_external_payment_ids.sql");
  if (fs.existsSync(uniqueExternalPaymentIdsMigrationPath)) {
    database.exec(fs.readFileSync(uniqueExternalPaymentIdsMigrationPath, "utf8"));
  }

  const uniqueProjectSourcesMigrationPath = path.join(process.cwd(), "migrations", "0030_unique_project_sources.sql");
  if (fs.existsSync(uniqueProjectSourcesMigrationPath)) {
    database.exec(fs.readFileSync(uniqueProjectSourcesMigrationPath, "utf8"));
  }

  const uniqueActiveAgentTasksMigrationPath = path.join(process.cwd(), "migrations", "0031_unique_active_agent_tasks.sql");
  if (fs.existsSync(uniqueActiveAgentTasksMigrationPath)) {
    database.exec(fs.readFileSync(uniqueActiveAgentTasksMigrationPath, "utf8"));
  }

  const projectEventSourceLinksMigrationPath = path.join(process.cwd(), "migrations", "0032_project_event_source_links.sql");
  if (fs.existsSync(projectEventSourceLinksMigrationPath)) {
    addColumnIfMissing(database, "project_events", "source_type", "TEXT");
    addColumnIfMissing(database, "project_events", "source_id", "TEXT");
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_project_events_project_source
        ON project_events(project_id, source_type, source_id);
    `);
  }

  const uniqueNormalizedClientEmailsMigrationPath = path.join(process.cwd(), "migrations", "0033_unique_normalized_client_emails.sql");
  if (fs.existsSync(uniqueNormalizedClientEmailsMigrationPath)) {
    database.exec(fs.readFileSync(uniqueNormalizedClientEmailsMigrationPath, "utf8"));
  }

  const uniqueProjectPrimaryContactMigrationPath = path.join(process.cwd(), "migrations", "0034_unique_project_primary_contact.sql");
  if (fs.existsSync(uniqueProjectPrimaryContactMigrationPath)) {
    database.exec(fs.readFileSync(uniqueProjectPrimaryContactMigrationPath, "utf8"));
  }

  const schedulerBookingOverlapGuardMigrationPath = path.join(process.cwd(), "migrations", "0035_scheduler_booking_overlap_guard.sql");
  if (fs.existsSync(schedulerBookingOverlapGuardMigrationPath)) {
    database.exec(fs.readFileSync(schedulerBookingOverlapGuardMigrationPath, "utf8"));
  }

  const uniqueProjectQuestionnaireResponsesMigrationPath = path.join(process.cwd(), "migrations", "0036_unique_project_questionnaire_responses.sql");
  if (fs.existsSync(uniqueProjectQuestionnaireResponsesMigrationPath)) {
    database.exec(fs.readFileSync(uniqueProjectQuestionnaireResponsesMigrationPath, "utf8"));
  }

  const invoicePaymentScheduleTotalGuardMigrationPath = path.join(process.cwd(), "migrations", "0037_invoice_payment_schedule_total_guard.sql");
  if (fs.existsSync(invoicePaymentScheduleTotalGuardMigrationPath)) {
    database.exec(fs.readFileSync(invoicePaymentScheduleTotalGuardMigrationPath, "utf8"));
  }

  const invoicePaidAmountGuardsMigrationPath = path.join(process.cwd(), "migrations", "0038_invoice_paid_amount_guards.sql");
  if (fs.existsSync(invoicePaidAmountGuardsMigrationPath)) {
    database.exec(fs.readFileSync(invoicePaidAmountGuardsMigrationPath, "utf8"));
  }

  const signedProposalImmutabilityMigrationPath = path.join(process.cwd(), "migrations", "0039_signed_proposal_immutability.sql");
  if (fs.existsSync(signedProposalImmutabilityMigrationPath)) {
    database.exec(fs.readFileSync(signedProposalImmutabilityMigrationPath, "utf8"));
  }

  const projectParticipantRoleGuardMigrationPath = path.join(process.cwd(), "migrations", "0040_project_participant_role_guard.sql");
  if (fs.existsSync(projectParticipantRoleGuardMigrationPath)) {
    database.exec(fs.readFileSync(projectParticipantRoleGuardMigrationPath, "utf8"));
  }

  const agentTaskSourceLinkGuardMigrationPath = path.join(process.cwd(), "migrations", "0041_agent_task_source_link_guard.sql");
  if (fs.existsSync(agentTaskSourceLinkGuardMigrationPath)) {
    database.exec(fs.readFileSync(agentTaskSourceLinkGuardMigrationPath, "utf8"));
  }

  const agentTaskProjectSourceGuardMigrationPath = path.join(process.cwd(), "migrations", "0042_agent_task_project_source_guard.sql");
  if (fs.existsSync(agentTaskProjectSourceGuardMigrationPath)) {
    database.exec(fs.readFileSync(agentTaskProjectSourceGuardMigrationPath, "utf8"));
  }

  const projectEventSourceLinkGuardMigrationPath = path.join(process.cwd(), "migrations", "0043_project_event_source_link_guard.sql");
  if (fs.existsSync(projectEventSourceLinkGuardMigrationPath)) {
    database.exec(fs.readFileSync(projectEventSourceLinkGuardMigrationPath, "utf8"));
  }

  const projectTimelineSourceLinkGuardMigrationPath = path.join(process.cwd(), "migrations", "0044_project_timeline_source_link_guard.sql");
  if (fs.existsSync(projectTimelineSourceLinkGuardMigrationPath)) {
    database.exec(fs.readFileSync(projectTimelineSourceLinkGuardMigrationPath, "utf8"));
  }

  const projectCommunicationSourceLinkGuardMigrationPath = path.join(process.cwd(), "migrations", "0045_project_communication_source_link_guard.sql");
  if (fs.existsSync(projectCommunicationSourceLinkGuardMigrationPath)) {
    database.exec(fs.readFileSync(projectCommunicationSourceLinkGuardMigrationPath, "utf8"));
  }

  const proposalSourceLinkGuardMigrationPath = path.join(process.cwd(), "migrations", "0046_proposal_source_link_guard.sql");
  if (fs.existsSync(proposalSourceLinkGuardMigrationPath)) {
    database.exec(fs.readFileSync(proposalSourceLinkGuardMigrationPath, "utf8"));
  }

  const invoiceSourceLinkGuardMigrationPath = path.join(process.cwd(), "migrations", "0047_invoice_source_link_guard.sql");
  if (fs.existsSync(invoiceSourceLinkGuardMigrationPath)) {
    database.exec(fs.readFileSync(invoiceSourceLinkGuardMigrationPath, "utf8"));
  }

  const invoicePaymentSourceLinkGuardMigrationPath = path.join(process.cwd(), "migrations", "0048_invoice_payment_source_link_guard.sql");
  if (fs.existsSync(invoicePaymentSourceLinkGuardMigrationPath)) {
    database.exec(fs.readFileSync(invoicePaymentSourceLinkGuardMigrationPath, "utf8"));
  }

  const schedulerBookingPaymentSourceLinkGuardMigrationPath = path.join(process.cwd(), "migrations", "0049_scheduler_booking_payment_source_link_guard.sql");
  if (fs.existsSync(schedulerBookingPaymentSourceLinkGuardMigrationPath)) {
    database.exec(fs.readFileSync(schedulerBookingPaymentSourceLinkGuardMigrationPath, "utf8"));
  }

  const expenseSourceLinkGuardMigrationPath = path.join(process.cwd(), "migrations", "0050_expense_source_link_guard.sql");
  if (fs.existsSync(expenseSourceLinkGuardMigrationPath)) {
    database.exec(fs.readFileSync(expenseSourceLinkGuardMigrationPath, "utf8"));
  }

  const projectSourceIdentityGuardMigrationPath = path.join(process.cwd(), "migrations", "0051_project_source_identity_guard.sql");
  if (fs.existsSync(projectSourceIdentityGuardMigrationPath)) {
    database.exec(fs.readFileSync(projectSourceIdentityGuardMigrationPath, "utf8"));
  }

  const clientEmailCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0052_client_email_canon_guard.sql");
  if (fs.existsSync(clientEmailCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(clientEmailCanonGuardMigrationPath, "utf8"));
  }

  const clientPhoneCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0053_client_phone_canon_guard.sql");
  if (fs.existsSync(clientPhoneCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(clientPhoneCanonGuardMigrationPath, "utf8"));
  }

  const clientNameCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0054_client_name_canon_guard.sql");
  if (fs.existsSync(clientNameCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(clientNameCanonGuardMigrationPath, "utf8"));
  }

  const projectIdentityCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0055_project_identity_canon_guard.sql");
  if (fs.existsSync(projectIdentityCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(projectIdentityCanonGuardMigrationPath, "utf8"));
  }

  const projectDetailTextCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0056_project_detail_text_canon_guard.sql");
  if (fs.existsSync(projectDetailTextCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(projectDetailTextCanonGuardMigrationPath, "utf8"));
  }

  const projectEventCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0057_project_event_canon_guard.sql");
  if (fs.existsSync(projectEventCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(projectEventCanonGuardMigrationPath, "utf8"));
  }

  const projectSourceCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0058_project_source_canon_guard.sql");
  if (fs.existsSync(projectSourceCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(projectSourceCanonGuardMigrationPath, "utf8"));
  }

  const projectParticipantCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0059_project_participant_canon_guard.sql");
  if (fs.existsSync(projectParticipantCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(projectParticipantCanonGuardMigrationPath, "utf8"));
  }

  const projectCommunicationCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0060_project_communication_canon_guard.sql");
  if (fs.existsSync(projectCommunicationCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(projectCommunicationCanonGuardMigrationPath, "utf8"));
  }

  const questionnaireResponseCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0061_questionnaire_response_canon_guard.sql");
  if (fs.existsSync(questionnaireResponseCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(questionnaireResponseCanonGuardMigrationPath, "utf8"));
  }

  const questionnaireTemplateCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0062_questionnaire_template_canon_guard.sql");
  if (fs.existsSync(questionnaireTemplateCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(questionnaireTemplateCanonGuardMigrationPath, "utf8"));
  }

  const proposalPackageCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0063_proposal_package_canon_guard.sql");
  if (fs.existsSync(proposalPackageCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(proposalPackageCanonGuardMigrationPath, "utf8"));
  }

  const invoiceLedgerCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0064_invoice_ledger_canon_guard.sql");
  if (fs.existsSync(invoiceLedgerCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(invoiceLedgerCanonGuardMigrationPath, "utf8"));
  }

  const schedulerBookingCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0065_scheduler_booking_canon_guard.sql");
  if (fs.existsSync(schedulerBookingCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(schedulerBookingCanonGuardMigrationPath, "utf8"));
  }

  const expenseBookkeepingCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0066_expense_bookkeeping_canon_guard.sql");
  if (fs.existsSync(expenseBookkeepingCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(expenseBookkeepingCanonGuardMigrationPath, "utf8"));
  }

  const studioConfigurationCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0067_studio_configuration_canon_guard.sql");
  if (fs.existsSync(studioConfigurationCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(studioConfigurationCanonGuardMigrationPath, "utf8"));
  }

  const agentTaskCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0068_agent_task_canon_guard.sql");
  if (fs.existsSync(agentTaskCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(agentTaskCanonGuardMigrationPath, "utf8"));
  }

  const accessTokenCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0069_access_token_canon_guard.sql");
  if (fs.existsSync(accessTokenCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(accessTokenCanonGuardMigrationPath, "utf8"));
  }

  const activityLogCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0070_activity_log_canon_guard.sql");
  if (fs.existsSync(activityLogCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(activityLogCanonGuardMigrationPath, "utf8"));
  }

  const templateCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0071_template_canon_guard.sql");
  if (fs.existsSync(templateCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(templateCanonGuardMigrationPath, "utf8"));
  }

  const googleCalendarConnectionCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0072_google_calendar_connection_canon_guard.sql");
  if (fs.existsSync(googleCalendarConnectionCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(googleCalendarConnectionCanonGuardMigrationPath, "utf8"));
  }

  const projectLocationCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0073_project_location_canon_guard.sql");
  if (fs.existsSync(projectLocationCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(projectLocationCanonGuardMigrationPath, "utf8"));
  }

  const agentTaskLifecycleCanonGuardMigrationPath = path.join(process.cwd(), "migrations", "0074_agent_task_lifecycle_canon_guard.sql");
  if (fs.existsSync(agentTaskLifecycleCanonGuardMigrationPath)) {
    database.exec(fs.readFileSync(agentTaskLifecycleCanonGuardMigrationPath, "utf8"));
  }

  const projectLocationSourceLinksMigrationPath = path.join(process.cwd(), "migrations", "0075_project_location_source_links.sql");
  if (fs.existsSync(projectLocationSourceLinksMigrationPath)) {
    addColumnIfMissing(database, "project_locations", "source_type", "TEXT");
    addColumnIfMissing(database, "project_locations", "source_id", "TEXT");
    database.exec(fs.readFileSync(projectLocationSourceLinksMigrationPath, "utf8")
      .replace(/ALTER TABLE project_locations ADD COLUMN source_type TEXT;\s*/g, "")
      .replace(/ALTER TABLE project_locations ADD COLUMN source_id TEXT;\s*/g, ""));
  }

  const agentTaskSpecialistQueueIndexMigrationPath = path.join(process.cwd(), "migrations", "0076_agent_task_specialist_queue_index.sql");
  if (fs.existsSync(agentTaskSpecialistQueueIndexMigrationPath)) {
    database.exec(fs.readFileSync(agentTaskSpecialistQueueIndexMigrationPath, "utf8"));
  }

  const bookkeepingSettlementIndexesMigrationPath = path.join(process.cwd(), "migrations", "0077_bookkeeping_settlement_indexes.sql");
  if (fs.existsSync(bookkeepingSettlementIndexesMigrationPath)) {
    database.exec(fs.readFileSync(bookkeepingSettlementIndexesMigrationPath, "utf8"));
  }

  const clientProfileFieldsMigrationPath = path.join(process.cwd(), "migrations", "0078_client_profile_fields.sql");
  if (fs.existsSync(clientProfileFieldsMigrationPath)) {
    addColumnIfMissing(database, "clients", "instagram_handle", "TEXT");
    addColumnIfMissing(database, "clients", "communication_preference", "TEXT");
    addColumnIfMissing(database, "clients", "referral_source", "TEXT");
    database.exec(fs.readFileSync(clientProfileFieldsMigrationPath, "utf8")
      .replace(/ALTER TABLE clients ADD COLUMN instagram_handle TEXT;\s*/g, "")
      .replace(/ALTER TABLE clients ADD COLUMN communication_preference TEXT;\s*/g, "")
      .replace(/ALTER TABLE clients ADD COLUMN referral_source TEXT;\s*/g, ""));
  }

  const templateExpandedTypesMigrationPath = path.join(process.cwd(), "migrations", "0079_template_expanded_types.sql");
  if (fs.existsSync(templateExpandedTypesMigrationPath)) {
    database.exec(fs.readFileSync(templateExpandedTypesMigrationPath, "utf8"));
  }

  const invoicePaymentCheckoutLinksMigrationPath = path.join(process.cwd(), "migrations", "0080_invoice_payment_checkout_links.sql");
  if (fs.existsSync(invoicePaymentCheckoutLinksMigrationPath)) {
    addColumnIfMissing(database, "invoice_payments", "stripe_checkout_url", "TEXT");
    addColumnIfMissing(database, "invoice_payments", "stripe_checkout_session_id", "TEXT");
    addColumnIfMissing(database, "invoice_payments", "stripe_checkout_status", "TEXT NOT NULL DEFAULT 'not_created'");
    database.exec(fs.readFileSync(invoicePaymentCheckoutLinksMigrationPath, "utf8")
      .replace(/ALTER TABLE invoice_payments ADD COLUMN stripe_checkout_url TEXT;\s*/g, "")
      .replace(/ALTER TABLE invoice_payments ADD COLUMN stripe_checkout_session_id TEXT;\s*/g, "")
      .replace(/ALTER TABLE invoice_payments ADD COLUMN stripe_checkout_status TEXT NOT NULL DEFAULT 'not_created';\s*/g, ""));
  }

  const projectWorkflowAutomationsMigrationPath = path.join(process.cwd(), "migrations", "0081_project_workflow_automations.sql");
  if (fs.existsSync(projectWorkflowAutomationsMigrationPath)) {
    database.exec(fs.readFileSync(projectWorkflowAutomationsMigrationPath, "utf8"));
  }

  const shootingLocationsMigrationPath = path.join(process.cwd(), "migrations", "0082_shooting_locations.sql");
  if (fs.existsSync(shootingLocationsMigrationPath)) {
    database.exec(fs.readFileSync(shootingLocationsMigrationPath, "utf8"));
  }

  const assetObjectsMigrationPath = path.join(process.cwd(), "migrations", "0083_asset_objects.sql");
  if (fs.existsSync(assetObjectsMigrationPath)) {
    database.exec(fs.readFileSync(assetObjectsMigrationPath, "utf8"));
  }

  const portalMagicRequestTokensMigrationPath = path.join(process.cwd(), "migrations", "0084_portal_magic_request_tokens.sql");
  if (fs.existsSync(portalMagicRequestTokensMigrationPath)) {
    addColumnIfMissing(database, "portal_access_tokens", "kind", "TEXT NOT NULL DEFAULT 'session'");
    addColumnIfMissing(database, "portal_access_tokens", "consumed_at", "TEXT");
    addColumnIfMissing(database, "portal_access_tokens", "request_batch_id", "TEXT");
    database.exec(fs.readFileSync(portalMagicRequestTokensMigrationPath, "utf8")
      .replace(/ALTER TABLE portal_access_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'session';\s*/g, "")
      .replace(/ALTER TABLE portal_access_tokens ADD COLUMN consumed_at TEXT;\s*/g, "")
      .replace(/ALTER TABLE portal_access_tokens ADD COLUMN request_batch_id TEXT;\s*/g, ""));
  }

  const inboundInquiriesMigrationPath = path.join(process.cwd(), "migrations", "0085_inbound_inquiries.sql");
  if (fs.existsSync(inboundInquiriesMigrationPath)) {
    database.exec(fs.readFileSync(inboundInquiriesMigrationPath, "utf8"));
  }

  // Phase 8a: inbound inquiry-email triage staging table. Additive, idempotent
  // create so local dev (better-sqlite3) and any partially-migrated prod D1 both
  // converge without a blanket `migrations apply`. The UNIQUE index on
  // message_id is the dedupe key (INSERT-OR-IGNORE, never UPDATE from inbound).
  database.exec(`
    CREATE TABLE IF NOT EXISTS inbound_inquiries (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      message_id TEXT,
      in_reply_to TEXT,
      references_header TEXT,
      envelope_from TEXT,
      header_from TEXT,
      to_address TEXT,
      subject TEXT,
      raw_storage_key TEXT,
      body_text TEXT,
      spf_result TEXT,
      dkim_result TEXT,
      dmarc_result TEXT,
      parsed_name TEXT,
      parsed_email TEXT,
      parsed_event_date TEXT,
      parsed_venue TEXT,
      parsed_json TEXT,
      agent_task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      proposed_project_json TEXT,
      draft_reply_subject TEXT,
      draft_reply_body TEXT,
      dismissed_reason TEXT,
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_inquiries_message_id ON inbound_inquiries(message_id);
    CREATE INDEX IF NOT EXISTS idx_inbound_inquiries_status_created ON inbound_inquiries(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_inbound_inquiries_received ON inbound_inquiries(received_at);
    CREATE INDEX IF NOT EXISTS idx_inbound_inquiries_parsed_email ON inbound_inquiries(parsed_email);
  `);

  const projectGalleriesMigrationPath = path.join(process.cwd(), "migrations", "0086_project_galleries.sql");
  if (fs.existsSync(projectGalleriesMigrationPath)) {
    database.exec(fs.readFileSync(projectGalleriesMigrationPath, "utf8"));
  }

  // Phase 7a: defensive idempotent create so local dev (better-sqlite3) and any
  // partially-migrated prod D1 converge without a blanket `migrations apply`.
  database.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_project_galleries_project_status ON project_galleries(project_id, status);
  `);

  // Phase 8b (SMS/TCPA): additive consent columns on clients, delivery columns on
  // project_communications, and the number-level sms_suppressions table. Idempotent
  // so local dev (better-sqlite3) and any partially-migrated prod D1 converge
  // without a blanket `migrations apply`. addColumnIfMissing handles the columns;
  // CREATE TABLE IF NOT EXISTS handles the suppression store.
  addColumnIfMissing(database, "clients", "sms_opt_in", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "clients", "sms_consent_source", "TEXT");
  addColumnIfMissing(database, "clients", "sms_consent_at", "TEXT");
  addColumnIfMissing(database, "clients", "sms_opt_out_at", "TEXT");
  addColumnIfMissing(database, "clients", "sms_last_consent_note", "TEXT");
  addColumnIfMissing(database, "project_communications", "provider_message_id", "TEXT");
  addColumnIfMissing(database, "project_communications", "delivery_status", "TEXT");
  // Phase 14 (two-way email): the inbound dedupe key + the THREAD-scoped composite
  // unique index. Must match migration 0092 exactly — dedupe is (project_id,
  // inbound_message_id) so a replay to the SAME project is a no-op while one
  // client's message to TWO projects appends to both threads (Finding MEDIUM 2).
  addColumnIfMissing(database, "project_communications", "inbound_message_id", "TEXT");
  database.exec(`
    CREATE TABLE IF NOT EXISTS sms_suppressions (
      phone_e164 TEXT PRIMARY KEY NOT NULL,
      stopped_at TEXT NOT NULL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_project_communications_provider_message_id
      ON project_communications(provider_message_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_communications_project_inbound_message_id
      ON project_communications(project_id, inbound_message_id);
  `);

  const automatedSequencesMigrationPath = path.join(process.cwd(), "migrations", "0088_automated_sequences.sql");
  if (fs.existsSync(automatedSequencesMigrationPath)) {
    database.exec(fs.readFileSync(automatedSequencesMigrationPath, "utf8"));
  }

  // Phase 8c: additive + dark automated-sequence tables. Idempotent create so
  // local dev (better-sqlite3) and any partially-migrated prod D1 converge
  // without a blanket `migrations apply`. email_suppressions is the compliance
  // suppression list; sequence_sends is the at-most-once ledger (UNIQUE dedupe).
  database.exec(`
    CREATE TABLE IF NOT EXISTS email_suppressions (
      email TEXT PRIMARY KEY NOT NULL,
      suppressed_at TEXT NOT NULL,
      source TEXT,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS sequence_enrollments (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      client_id TEXT,
      sequence_key TEXT NOT NULL,
      anchor_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      enrolled_by TEXT NOT NULL DEFAULT 'system',
      enrolled_at TEXT NOT NULL,
      stopped_at TEXT,
      stop_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sequence_enrollment
      ON sequence_enrollments(sequence_key, anchor_key);
    CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_status
      ON sequence_enrollments(status, sequence_key);
    CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_project
      ON sequence_enrollments(project_id, status);
    CREATE TABLE IF NOT EXISTS sequence_sends (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      client_id TEXT,
      enrollment_id TEXT,
      sequence_key TEXT NOT NULL,
      step_key TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'claimed',
      communication_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      fired_at TEXT NOT NULL,
      note TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sequence_sends_dedupe
      ON sequence_sends(dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_sequence_sends_client_fired
      ON sequence_sends(client_id, fired_at);
    CREATE INDEX IF NOT EXISTS idx_sequence_sends_status
      ON sequence_sends(status, fired_at);
  `);

  // Phase 9a: refund/dispute WEBHOOK recording + tax/1099 + mileage. Additive +
  // idempotent so local dev (better-sqlite3) and any partially-migrated prod D1
  // converge without a blanket `migrations apply`. The invoice_payments summary
  // columns are read on always-on paths, so these must exist before /finance loads.
  addColumnIfMissing(database, "invoice_payments", "refunded_amount_cents", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "invoice_payments", "dispute_status", "TEXT");
  addColumnIfMissing(database, "invoice_payments", "disputed_amount_cents", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "invoice_payments", "last_refund_at", "TEXT");
  addColumnIfMissing(database, "app_settings", "tax_set_aside_rate_percent", "INTEGER");
  addColumnIfMissing(database, "app_settings", "mileage_rate_cents", "INTEGER");
  addColumnIfMissing(database, "app_settings", "form_1099_threshold_cents", "INTEGER");
  addColumnIfMissing(database, "vendors", "tax_id_last4", "TEXT");
  addColumnIfMissing(database, "vendors", "is_1099_tracked", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "vendors", "legal_name", "TEXT");
  addColumnIfMissing(database, "vendors", "tax_address", "TEXT");
  database.exec(`
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      event_id          TEXT PRIMARY KEY NOT NULL,
      event_type        TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      stripe_created_at TEXT,
      result            TEXT
    );
    CREATE TABLE IF NOT EXISTS payment_refunds (
      id                       TEXT PRIMARY KEY NOT NULL,
      stripe_refund_id         TEXT NOT NULL,
      stripe_charge_id         TEXT,
      stripe_payment_intent_id TEXT,
      invoice_payment_id       TEXT REFERENCES invoice_payments(id) ON DELETE SET NULL,
      scheduler_booking_id     TEXT REFERENCES scheduler_bookings(id) ON DELETE SET NULL,
      amount_cents             INTEGER NOT NULL DEFAULT 0,
      currency                 TEXT NOT NULL DEFAULT 'usd',
      reason                   TEXT,
      status                   TEXT,
      stripe_created_at        TEXT,
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_disputes (
      id                       TEXT PRIMARY KEY NOT NULL,
      stripe_dispute_id        TEXT NOT NULL,
      stripe_charge_id         TEXT,
      stripe_payment_intent_id TEXT,
      invoice_payment_id       TEXT REFERENCES invoice_payments(id) ON DELETE SET NULL,
      scheduler_booking_id     TEXT REFERENCES scheduler_bookings(id) ON DELETE SET NULL,
      amount_cents             INTEGER NOT NULL DEFAULT 0,
      currency                 TEXT NOT NULL DEFAULT 'usd',
      reason                   TEXT,
      status                   TEXT,
      funds_reinstated         INTEGER NOT NULL DEFAULT 0,
      opened_at                TEXT,
      closed_at                TEXT,
      stripe_created_at        TEXT,
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mileage_logs (
      id            TEXT PRIMARY KEY NOT NULL,
      project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
      trip_date     TEXT NOT NULL,
      miles         REAL NOT NULL,
      purpose       TEXT,
      from_location TEXT,
      to_location   TEXT,
      notes         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_refunds_stripe_refund_id_unique ON payment_refunds(stripe_refund_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_disputes_stripe_dispute_id_unique ON payment_disputes(stripe_dispute_id);
    CREATE INDEX IF NOT EXISTS idx_payment_refunds_pi   ON payment_refunds(stripe_payment_intent_id);
    CREATE INDEX IF NOT EXISTS idx_payment_refunds_ip   ON payment_refunds(invoice_payment_id);
    CREATE INDEX IF NOT EXISTS idx_payment_refunds_created ON payment_refunds(created_at);
    CREATE INDEX IF NOT EXISTS idx_payment_disputes_pi  ON payment_disputes(stripe_payment_intent_id);
    CREATE INDEX IF NOT EXISTS idx_payment_disputes_ip  ON payment_disputes(invoice_payment_id);
    CREATE INDEX IF NOT EXISTS idx_payment_disputes_created ON payment_disputes(created_at);
    CREATE INDEX IF NOT EXISTS idx_mileage_logs_trip_date ON mileage_logs(trip_date);
    CREATE INDEX IF NOT EXISTS idx_mileage_logs_project ON mileage_logs(project_id);
  `);

  // Phase 10: intelligence/forecasting admin settings. Additive + idempotent
  // nullable columns on app_settings (safe code defaults when NULL). app_settings
  // is read on always-on paths, so these must exist before /finance loads —
  // deploy-order-critical (apply 0090 to prod D1 before the Worker deploy).
  addColumnIfMissing(database, "app_settings", "forecast_horizon_months", "INTEGER");
  addColumnIfMissing(database, "app_settings", "forecast_trailing_months", "INTEGER");
  addColumnIfMissing(database, "app_settings", "monthly_capacity_target", "INTEGER");
  addColumnIfMissing(database, "app_settings", "lead_source_taxonomy_json", "TEXT");

  // Phase 9b (migration 0091): refund INITIATION audit + idempotency ledger. Additive +
  // idempotent so local dev (better-sqlite3) and any partially-migrated prod D1 converge
  // without a blanket `migrations apply`. NOT on an always-on read path — only the refund
  // feature touches it. This is the sole table 9b writes; payment_refunds stays webhook-owned.
  database.exec(`
    CREATE TABLE IF NOT EXISTS refund_initiations (
      id                             TEXT PRIMARY KEY NOT NULL,
      invoice_payment_id             TEXT NOT NULL REFERENCES invoice_payments(id) ON DELETE CASCADE,
      stripe_payment_intent_id       TEXT,
      amount_cents                   INTEGER NOT NULL DEFAULT 0,
      currency                       TEXT NOT NULL DEFAULT 'usd',
      reason                         TEXT,
      service_not_rendered_confirmed INTEGER NOT NULL DEFAULT 0,
      stripe_reason                  TEXT,
      status                         TEXT NOT NULL DEFAULT 'pending',
      claim_token                    TEXT,
      stripe_refund_id               TEXT,
      error_message                  TEXT,
      initiated_by                   TEXT,
      created_at                     TEXT NOT NULL,
      updated_at                     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_refund_initiations_payment ON refund_initiations(invoice_payment_id);
    CREATE INDEX IF NOT EXISTS idx_refund_initiations_refund  ON refund_initiations(stripe_refund_id);
    CREATE INDEX IF NOT EXISTS idx_refund_initiations_status  ON refund_initiations(status);
  `);
  // Guard a dev DB that created refund_initiations before the claim_token column existed.
  addColumnIfMissing(database, "refund_initiations", "claim_token", "TEXT");

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
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      instructions TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      priority TEXT NOT NULL DEFAULT 'normal',
      requested_by TEXT,
      assigned_agent TEXT,
      source_type TEXT,
      source_id TEXT,
      result_summary TEXT,
      output_json TEXT,
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_project_status ON agent_tasks(project_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_created ON agent_tasks(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_source ON agent_tasks(source_type, source_id);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS project_sources (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'note',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      summary TEXT,
      occurred_at TEXT,
      external_url TEXT,
      captured_by TEXT,
      source_type TEXT,
      source_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_project_sources_project_kind ON project_sources(project_id, kind, occurred_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_project_sources_source ON project_sources(source_type, source_id);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS project_communications (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
      direction TEXT NOT NULL DEFAULT 'outbound',
      channel TEXT NOT NULL DEFAULT 'email',
      status TEXT NOT NULL DEFAULT 'draft',
      subject TEXT,
      body TEXT NOT NULL,
      recipient_name TEXT,
      recipient_email TEXT,
      scheduled_for TEXT,
      sent_at TEXT,
      source_type TEXT,
      source_id TEXT,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_project_communications_project_status ON project_communications(project_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_project_communications_source ON project_communications(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_project_communications_recipient ON project_communications(recipient_email, created_at);
  `);

  database.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_expenses_project_paid ON expenses(project_id, paid_at);
    CREATE INDEX IF NOT EXISTS idx_expenses_vendor_paid ON expenses(vendor_id, paid_at);
    CREATE INDEX IF NOT EXISTS idx_expenses_status_paid ON expenses(status, paid_at);
    CREATE INDEX IF NOT EXISTS idx_expenses_category_paid ON expenses(category, paid_at);
    CREATE INDEX IF NOT EXISTS idx_expenses_external_payment ON expenses(external_payment_id);
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
      signature_ip TEXT,
      signature_user_agent TEXT,
      signature_consent_text TEXT,
      signature_consent_version TEXT,
      selected_optional_line_item_ids_json TEXT,
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
      card_fee_policy TEXT NOT NULL DEFAULT 'studio_absorbs',
      card_fee_percent_bps INTEGER NOT NULL DEFAULT 0,
      card_fee_fixed_cents INTEGER NOT NULL DEFAULT 0,
      card_fee_amount_cents INTEGER NOT NULL DEFAULT 0,
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
      paid_amount_cents INTEGER NOT NULL DEFAULT 0,
      client_fee_cents INTEGER NOT NULL DEFAULT 0,
      processing_fee_cents INTEGER NOT NULL DEFAULT 0,
      gross_collected_cents INTEGER NOT NULL DEFAULT 0,
      net_deposit_cents INTEGER NOT NULL DEFAULT 0,
      external_payment_id TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_invoice_payments_status_paid ON invoice_payments(status, paid_at);
    CREATE INDEX IF NOT EXISTS idx_invoice_payments_external_payment ON invoice_payments(external_payment_id);
  `);

  const invoiceColumns = new Set(
    database.prepare("PRAGMA table_info(invoices)").all().map((column) => (column as { name: string }).name),
  );
  if (!invoiceColumns.has("accepted_payment_methods_json")) {
    database.exec("ALTER TABLE invoices ADD COLUMN accepted_payment_methods_json TEXT");
  }
  const invoiceFeeAdditions = [
    ["card_fee_policy", "TEXT NOT NULL DEFAULT 'studio_absorbs'"],
    ["card_fee_percent_bps", "INTEGER NOT NULL DEFAULT 0"],
    ["card_fee_fixed_cents", "INTEGER NOT NULL DEFAULT 0"],
    ["card_fee_amount_cents", "INTEGER NOT NULL DEFAULT 0"],
  ] as const;
  for (const [name, definition] of invoiceFeeAdditions) {
    if (!invoiceColumns.has(name)) {
      database.exec(`ALTER TABLE invoices ADD COLUMN ${name} ${definition}`);
    }
  }

  const invoicePaymentColumns = new Set(
    database.prepare("PRAGMA table_info(invoice_payments)").all().map((column) => (column as { name: string }).name),
  );
  const invoicePaymentLedgerAdditions = [
    ["paid_amount_cents", "INTEGER NOT NULL DEFAULT 0"],
    ["client_fee_cents", "INTEGER NOT NULL DEFAULT 0"],
    ["processing_fee_cents", "INTEGER NOT NULL DEFAULT 0"],
    ["gross_collected_cents", "INTEGER NOT NULL DEFAULT 0"],
    ["net_deposit_cents", "INTEGER NOT NULL DEFAULT 0"],
    ["external_payment_id", "TEXT"],
  ] as const;
  for (const [name, definition] of invoicePaymentLedgerAdditions) {
    if (!invoicePaymentColumns.has(name)) {
      database.exec(`ALTER TABLE invoice_payments ADD COLUMN ${name} ${definition}`);
    }
  }
  database.exec(`
    UPDATE invoice_payments
    SET
      paid_amount_cents = CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END,
      gross_collected_cents = CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END,
      net_deposit_cents = CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END
    WHERE paid_amount_cents = 0
      AND client_fee_cents = 0
      AND processing_fee_cents = 0
      AND gross_collected_cents = 0
      AND net_deposit_cents = 0;
    CREATE INDEX IF NOT EXISTS idx_invoice_payments_status_paid ON invoice_payments(status, paid_at);
    CREATE INDEX IF NOT EXISTS idx_invoice_payments_external_payment ON invoice_payments(external_payment_id);
  `);

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
    ["signature_ip", "TEXT"],
    ["signature_user_agent", "TEXT"],
    ["signature_consent_text", "TEXT"],
    ["signature_consent_version", "TEXT"],
    ["selected_optional_line_item_ids_json", "TEXT"],
  ] as const;

  for (const [name, definition] of proposalAdditions) {
    if (!proposalColumns.has(name)) {
      database.exec(`ALTER TABLE proposals ADD COLUMN ${name} ${definition}`);
    }
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_proposals_signed_at ON proposals(signed_at);");

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
    ["stripe_payment_link", "TEXT"],
    ["sms_opt_in_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["confirmation_message", "TEXT"],
  ] as const;

  for (const [name, definition] of meetingTypeAdditions) {
    if (!schedulerMeetingTypeColumns.has(name)) {
      database.exec(`ALTER TABLE scheduler_meeting_types ADD COLUMN ${name} ${definition}`);
    }
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_scheduler_meeting_types_collect_payment ON scheduler_meeting_types(collect_payment, is_active);");

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
    ["payment_status", "TEXT NOT NULL DEFAULT 'unpaid'"],
    ["payment_method", "TEXT"],
    ["paid_at", "TEXT"],
    ["paid_amount_cents", "INTEGER NOT NULL DEFAULT 0"],
    ["client_fee_cents", "INTEGER NOT NULL DEFAULT 0"],
    ["processing_fee_cents", "INTEGER NOT NULL DEFAULT 0"],
    ["gross_collected_cents", "INTEGER NOT NULL DEFAULT 0"],
    ["net_deposit_cents", "INTEGER NOT NULL DEFAULT 0"],
    ["external_payment_id", "TEXT"],
    ["payment_link", "TEXT"],
    ["payment_notes", "TEXT"],
    // CR-4 (migration 0094): per-booking auto-generated Google Meet link. Dark behind
    // SCHEDULER_MEET_LINKS — stays NULL unless the flag is on and locationType is google_meet.
    ["meeting_join_url", "TEXT"],
  ] as const;

  for (const [name, definition] of bookingAdditions) {
    if (!schedulerBookingColumns.has(name)) {
      database.exec(`ALTER TABLE scheduler_bookings ADD COLUMN ${name} ${definition}`);
    }
  }
  database.exec(`
    UPDATE scheduler_bookings
    SET payment_link = (
      SELECT scheduler_meeting_types.stripe_payment_link
      FROM scheduler_meeting_types
      WHERE scheduler_meeting_types.id = scheduler_bookings.meeting_type_id
    )
    WHERE payment_link IS NULL;
    CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_payment_status_paid ON scheduler_bookings(payment_status, paid_at);
    CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_external_payment ON scheduler_bookings(external_payment_id);
    CREATE INDEX IF NOT EXISTS idx_scheduler_bookings_project_payment ON scheduler_bookings(project_id, payment_status, paid_at);
  `);

  // Phase 21 (migration 0093): observability heartbeat + alert dedupe. Additive +
  // idempotent so local dev (better-sqlite3) and any partially-migrated prod D1 converge
  // without a blanket `migrations apply`. NON-CANONICAL: these tables are operational only
  // (job_runs heartbeat + health_alerts dedupe) — nothing here moves money or mutates a
  // business record. NOT on an always-on business read path; can migrate dark.
  database.exec(`
    CREATE TABLE IF NOT EXISTS job_runs (
      job_name             TEXT PRIMARY KEY NOT NULL,
      last_run_at          TEXT,
      last_success_at      TEXT,
      last_status          TEXT,
      last_error           TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      updated_at           TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_alerts (
      alert_key     TEXT PRIMARY KEY NOT NULL,
      severity      TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_sent_at  TEXT,
      resolved_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_health_alerts_unresolved ON health_alerts(resolved_at);
  `);

  // Phase 23 (migration 0095): questionnaire autofill review-and-apply (CR-5). Additive +
  // idempotent. NON-CANONICAL: suggested_changes_json/computed_at hold a review artifact
  // (never a canonical write) and semantic_key is an optional admin-assigned mapping hint —
  // losing any of these three columns loses no business state. Dark behind
  // QUESTIONNAIRE_AUTOFILL_REVIEW; safe to migrate ahead of the flag flip.
  addColumnIfMissing(database, "questionnaire_responses", "suggested_changes_json", "TEXT");
  addColumnIfMissing(database, "questionnaire_responses", "suggested_changes_computed_at", "TEXT");
  addColumnIfMissing(database, "questionnaire_questions", "semantic_key", "TEXT");
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
