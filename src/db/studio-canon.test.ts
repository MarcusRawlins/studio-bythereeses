import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-studio-canon-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("./client");
  const database = rawDb();

  function indexNames(tableName: string) {
    return new Set(
      database
        .prepare(`PRAGMA index_list(${tableName})`)
        .all()
        .map((row) => (row as { name: string }).name),
    );
  }

  function columnNames(tableName: string) {
    return new Set(
      database
        .prepare(`PRAGMA table_info(${tableName})`)
        .all()
        .map((row) => (row as { name: string }).name),
    );
  }

  function triggerNames(tableName: string) {
    return new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
        .all(tableName)
        .map((row) => (row as { name: string }).name),
    );
  }

  assert.ok(
    indexNames("project_participants").has("idx_project_participants_unique_project_client"),
    "project participants should have a canonical unique project/client index",
  );
  assert.ok(
    indexNames("project_participants").has("idx_project_participants_unique_primary"),
    "project participants should enforce one canonical primary contact per project",
  );
  assert.ok(
    triggerNames("project_participants").has("trg_project_participants_primary_role_insert"),
    "project participants should reject primary role labels on non-primary contacts",
  );
  assert.ok(
    triggerNames("project_participants").has("trg_project_participants_primary_role_update"),
    "project participants should reject primary role label updates on non-primary contacts",
  );
  assert.ok(
    triggerNames("project_participants").has("trg_project_participants_role_canon_insert"),
    "project participant inserts should reject non-canonical roles",
  );
  assert.ok(
    triggerNames("project_participants").has("trg_project_participants_role_canon_update"),
    "project participant updates should reject non-canonical roles",
  );
  assert.ok(
    triggerNames("project_participants").has("trg_project_participants_primary_flag_canon_insert"),
    "project participant inserts should reject non-boolean primary flags",
  );
  assert.ok(
    triggerNames("project_participants").has("trg_project_participants_primary_flag_canon_update"),
    "project participant updates should reject non-boolean primary flags",
  );
  assert.ok(
    indexNames("clients").has("idx_clients_email_normalized_unique"),
    "client email identity should be uniquely indexed after lower/trim normalization",
  );
  assert.ok(
    triggerNames("clients").has("trg_clients_email_required_insert"),
    "client inserts should reject blank canonical emails",
  );
  assert.ok(
    triggerNames("clients").has("trg_clients_email_required_update"),
    "client email updates should reject blank canonical emails",
  );
  assert.ok(
    triggerNames("clients").has("trg_clients_email_canon_insert"),
    "client inserts should reject non-normalized email identity",
  );
  assert.ok(
    triggerNames("clients").has("trg_clients_email_canon_update"),
    "client email updates should reject non-normalized email identity",
  );
  assert.ok(
    triggerNames("clients").has("trg_clients_phone_canon_insert"),
    "client inserts should reject blank or padded phone values",
  );
  assert.ok(
    triggerNames("clients").has("trg_clients_phone_canon_update"),
    "client phone updates should reject blank or padded phone values",
  );
  assert.ok(
    triggerNames("clients").has("trg_clients_name_canon_insert"),
    "client inserts should reject blank or padded name values",
  );
  assert.ok(
    triggerNames("clients").has("trg_clients_name_canon_update"),
    "client name updates should reject blank or padded name values",
  );
  assert.ok(
    indexNames("clients").has("idx_clients_instagram_handle"),
    "client Instagram handles should be indexed for agent/client lookup",
  );
  assert.ok(
    triggerNames("clients").has("trg_clients_profile_fields_canon_insert"),
    "client inserts should reject non-canonical profile fields",
  );
  assert.ok(
    triggerNames("clients").has("trg_clients_profile_fields_canon_update"),
    "client profile updates should reject non-canonical profile fields",
  );
  assert.ok(
    triggerNames("projects").has("trg_projects_identity_canon_insert"),
    "project inserts should reject non-canonical project identity values",
  );
  assert.ok(
    triggerNames("projects").has("trg_projects_identity_canon_update"),
    "project updates should reject non-canonical project identity values",
  );
  assert.ok(
    triggerNames("projects").has("trg_projects_detail_text_canon_insert"),
    "project inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("projects").has("trg_projects_detail_text_canon_update"),
    "project updates should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("questionnaires").has("trg_questionnaires_identity_canon_insert"),
    "questionnaire inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("questionnaires").has("trg_questionnaires_identity_canon_update"),
    "questionnaire updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("questionnaire_questions").has("trg_questionnaire_questions_identity_canon_insert"),
    "questionnaire question inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("questionnaire_questions").has("trg_questionnaire_questions_identity_canon_update"),
    "questionnaire question updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("questionnaire_questions").has("trg_questionnaire_questions_options_canon_insert"),
    "questionnaire question inserts should reject non-canonical options json",
  );
  assert.ok(
    triggerNames("questionnaire_questions").has("trg_questionnaire_questions_options_canon_update"),
    "questionnaire question updates should reject non-canonical options json",
  );
  assert.ok(
    indexNames("questionnaire_responses").has("idx_questionnaire_responses_project_client"),
    "questionnaire responses should be indexed by project/client",
  );
  assert.ok(
    indexNames("questionnaire_responses").has("idx_questionnaire_responses_project_client_unique"),
    "project questionnaire responses should be unique per questionnaire/project/client",
  );
  assert.ok(
    triggerNames("questionnaire_responses").has("trg_questionnaire_responses_answers_canon_insert"),
    "questionnaire response inserts should reject non-canonical answer json",
  );
  assert.ok(
    triggerNames("questionnaire_responses").has("trg_questionnaire_responses_answers_canon_update"),
    "questionnaire response updates should reject non-canonical answer json",
  );
  assert.ok(
    triggerNames("questionnaire_responses").has("trg_questionnaire_responses_detail_text_canon_insert"),
    "questionnaire response inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("questionnaire_responses").has("trg_questionnaire_responses_detail_text_canon_update"),
    "questionnaire response updates should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("app_settings").has("trg_app_settings_identity_canon_insert"),
    "app settings inserts should reject non-canonical business identity values",
  );
  assert.ok(
    triggerNames("app_settings").has("trg_app_settings_identity_canon_update"),
    "app settings updates should reject non-canonical business identity values",
  );
  assert.ok(
    triggerNames("app_settings").has("trg_app_settings_payment_methods_canon_insert"),
    "app settings inserts should reject non-canonical payment methods json",
  );
  assert.ok(
    triggerNames("app_settings").has("trg_app_settings_payment_methods_canon_update"),
    "app settings updates should reject non-canonical payment methods json",
  );
  assert.ok(
    triggerNames("scheduler_settings").has("trg_scheduler_settings_identity_canon_insert"),
    "scheduler settings inserts should reject non-canonical scheduler values",
  );
  assert.ok(
    triggerNames("scheduler_settings").has("trg_scheduler_settings_identity_canon_update"),
    "scheduler settings updates should reject non-canonical scheduler values",
  );
  assert.ok(
    triggerNames("scheduler_settings").has("trg_scheduler_settings_availability_canon_insert"),
    "scheduler settings inserts should reject non-canonical availability json",
  );
  assert.ok(
    triggerNames("scheduler_settings").has("trg_scheduler_settings_availability_canon_update"),
    "scheduler settings updates should reject non-canonical availability json",
  );
  assert.ok(
    triggerNames("scheduler_meeting_types").has("trg_scheduler_meeting_types_identity_canon_insert"),
    "scheduler meeting type inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("scheduler_meeting_types").has("trg_scheduler_meeting_types_identity_canon_update"),
    "scheduler meeting type updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("scheduler_meeting_types").has("trg_scheduler_meeting_types_questions_canon_insert"),
    "scheduler meeting type inserts should reject non-canonical question json",
  );
  assert.ok(
    triggerNames("scheduler_meeting_types").has("trg_scheduler_meeting_types_questions_canon_update"),
    "scheduler meeting type updates should reject non-canonical question json",
  );
  assert.ok(
    indexNames("scheduler_bookings").has("idx_scheduler_bookings_project_client"),
    "scheduler bookings should be indexed by project/client",
  );
  assert.ok(
    indexNames("scheduler_bookings").has("idx_scheduler_bookings_confirmed_time"),
    "confirmed scheduler bookings should have a time-window index for overlap prevention",
  );
  assert.ok(
    indexNames("expenses").has("idx_expenses_project_paid"),
    "expenses should be indexed by project and paid date",
  );
  assert.ok(
    indexNames("expenses").has("idx_expenses_status_paid"),
    "expenses should be indexed by status and paid date",
  );
  assert.ok(
    indexNames("invoice_payments").has("idx_invoice_payments_status_paid"),
    "invoice payments should be indexed by status and paid date for bookkeeping settlement totals",
  );
  assert.ok(
    indexNames("scheduler_bookings").has("idx_scheduler_bookings_payment_status_paid"),
    "scheduler booking payments should be indexed by payment status and paid date for bookkeeping settlement totals",
  );
  assert.ok(
    indexNames("scheduler_bookings").has("idx_scheduler_bookings_project_payment"),
    "scheduler booking payments should be indexed by project, payment status, and paid date for project finance rollups",
  );
  assert.ok(
    indexNames("expenses").has("idx_expenses_external_payment"),
    "expenses should be indexed by external payment id for canonical payment reconciliation",
  );
  assert.ok(
    triggerNames("vendors").has("trg_vendors_identity_canon_insert"),
    "vendor inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("vendors").has("trg_vendors_identity_canon_update"),
    "vendor updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("vendors").has("trg_vendors_detail_text_canon_insert"),
    "vendor inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("vendors").has("trg_vendors_detail_text_canon_update"),
    "vendor updates should reject blank or padded optional detail text",
  );
  assert.ok(
    indexNames("project_timeline_items").has("idx_project_timeline_items_project_source"),
    "timeline regeneration should have a project-scoped source index",
  );
  assert.ok(
    triggerNames("project_timeline_items").has("trg_project_timeline_items_source_link_insert"),
    "project timeline source links should reject half-linked inserts",
  );
  assert.ok(
    triggerNames("project_timeline_items").has("trg_project_timeline_items_source_link_update"),
    "project timeline source links should reject half-linked updates",
  );
  assert.ok(
    triggerNames("project_timeline_items").has("trg_project_timeline_items_project_source_insert"),
    "project timeline project-source links should reject source ids outside the item project",
  );
  assert.ok(
    triggerNames("project_timeline_items").has("trg_project_timeline_items_project_source_update"),
    "project timeline project-source link updates should reject source ids outside the item project",
  );
  assert.ok(
    columnNames("project_events").has("source_type"),
    "project events should store canonical source type links",
  );
  assert.ok(
    columnNames("project_events").has("source_id"),
    "project events should store canonical source id links",
  );
  assert.ok(
    indexNames("project_events").has("idx_project_events_project_source"),
    "project event source lookups should have a project-scoped source index",
  );
  assert.ok(
    triggerNames("project_events").has("trg_project_events_source_link_insert"),
    "project event source links should reject half-linked inserts",
  );
  assert.ok(
    triggerNames("project_events").has("trg_project_events_source_link_update"),
    "project event source links should reject half-linked updates",
  );
  assert.ok(
    triggerNames("project_events").has("trg_project_events_project_source_insert"),
    "project event project-source links should reject source ids outside the event project",
  );
  assert.ok(
    triggerNames("project_events").has("trg_project_events_project_source_update"),
    "project event project-source link updates should reject source ids outside the event project",
  );
  assert.ok(
    triggerNames("project_events").has("trg_project_events_identity_canon_insert"),
    "project event inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("project_events").has("trg_project_events_identity_canon_update"),
    "project event updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("project_events").has("trg_project_events_detail_text_canon_insert"),
    "project event inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("project_events").has("trg_project_events_detail_text_canon_update"),
    "project event updates should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("project_locations").has("trg_project_locations_identity_canon_insert"),
    "project location inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("project_locations").has("trg_project_locations_identity_canon_update"),
    "project location updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("project_locations").has("trg_project_locations_detail_text_canon_insert"),
    "project location inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("project_locations").has("trg_project_locations_detail_text_canon_update"),
    "project location updates should reject blank or padded optional detail text",
  );
  assert.ok(
    indexNames("project_locations").has("idx_project_locations_project_source"),
    "project location source lookups should have a project-scoped source index",
  );
  assert.ok(
    triggerNames("project_locations").has("trg_project_locations_source_pair_insert"),
    "project location inserts should reject half-linked source references",
  );
  assert.ok(
    triggerNames("project_locations").has("trg_project_locations_project_source_insert"),
    "project location inserts should reject source ids outside the project",
  );
  assert.ok(
    triggerNames("project_locations").has("trg_project_locations_project_source_update"),
    "project location source updates should reject source ids outside the project",
  );
  assert.ok(
    indexNames("project_sources").has("idx_project_sources_project_source"),
    "project source lookups should have a project-scoped source index",
  );
  assert.ok(
    triggerNames("project_sources").has("trg_project_sources_source_link_insert"),
    "project source identity links should reject half-linked inserts",
  );
  assert.ok(
    triggerNames("project_sources").has("trg_project_sources_source_link_update"),
    "project source identity links should reject half-linked updates",
  );
  assert.ok(
    triggerNames("project_sources").has("trg_project_sources_identity_canon_insert"),
    "project source inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("project_sources").has("trg_project_sources_identity_canon_update"),
    "project source updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("project_sources").has("trg_project_sources_detail_text_canon_insert"),
    "project source inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("project_sources").has("trg_project_sources_detail_text_canon_update"),
    "project source updates should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("project_sources").has("trg_project_sources_metadata_canon_insert"),
    "project source inserts should reject non-canonical metadata json",
  );
  assert.ok(
    triggerNames("project_sources").has("trg_project_sources_metadata_canon_update"),
    "project source updates should reject non-canonical metadata json",
  );
  assert.ok(
    indexNames("project_communications").has("idx_project_communications_project_source"),
    "communication source lookups should have a project-scoped source index",
  );
  // Phase 14: the inbound-email dedupe column + THREAD-scoped composite unique
  // index. Assert the index columns (not just its presence) so a regression to a
  // global single-column unique index — which would silently drop a cross-project
  // reply (Finding MEDIUM 2) — fails loudly.
  assert.ok(
    columnNames("project_communications").has("inbound_message_id"),
    "project_communications should carry the Phase 14 inbound_message_id dedupe column",
  );
  assert.ok(
    indexNames("project_communications").has("idx_project_communications_project_inbound_message_id"),
    "inbound email dedupe should have the composite project/inbound-message-id unique index",
  );
  {
    const info = database
      .prepare("PRAGMA index_info(idx_project_communications_project_inbound_message_id)")
      .all()
      .map((row) => (row as { name: string }).name);
    assert.deepEqual(
      info,
      ["project_id", "inbound_message_id"],
      "inbound email dedupe index must be scoped to (project_id, inbound_message_id), never global",
    );
    const list = database
      .prepare("PRAGMA index_list(project_communications)")
      .all()
      .find((row) => (row as { name: string }).name === "idx_project_communications_project_inbound_message_id") as
      | { unique: number }
      | undefined;
    assert.ok(list && list.unique === 1, "the inbound email dedupe index must be UNIQUE");
  }
  assert.ok(
    triggerNames("project_communications").has("trg_project_communications_source_link_insert"),
    "project communication source links should reject half-linked inserts",
  );
  assert.ok(
    triggerNames("project_communications").has("trg_project_communications_source_link_update"),
    "project communication source links should reject half-linked updates",
  );
  assert.ok(
    triggerNames("project_communications").has("trg_project_communications_project_source_insert"),
    "project communication project-source links should reject source ids outside the communication project",
  );
  assert.ok(
    triggerNames("project_communications").has("trg_project_communications_project_source_update"),
    "project communication project-source link updates should reject source ids outside the communication project",
  );
  assert.ok(
    triggerNames("project_communications").has("trg_project_communications_identity_canon_insert"),
    "project communication inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("project_communications").has("trg_project_communications_identity_canon_update"),
    "project communication updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("project_communications").has("trg_project_communications_detail_text_canon_insert"),
    "project communication inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("project_communications").has("trg_project_communications_detail_text_canon_update"),
    "project communication updates should reject blank or padded optional detail text",
  );
  assert.ok(
    indexNames("proposals").has("idx_proposals_project_source"),
    "proposal source lookups should have a project-scoped source index",
  );
  assert.ok(
    triggerNames("proposals").has("trg_proposals_source_link_insert"),
    "proposal source links should reject half-linked inserts",
  );
  assert.ok(
    triggerNames("proposals").has("trg_proposals_source_link_update"),
    "proposal source links should reject half-linked updates",
  );
  assert.ok(
    triggerNames("proposals").has("trg_proposals_project_source_insert"),
    "proposal project-source links should reject source ids outside the proposal project",
  );
  assert.ok(
    triggerNames("proposals").has("trg_proposals_project_source_update"),
    "proposal project-source link updates should reject source ids outside the proposal project",
  );
  assert.ok(
    triggerNames("proposals").has("trg_proposals_identity_canon_insert"),
    "proposal inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("proposals").has("trg_proposals_identity_canon_update"),
    "proposal updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("proposals").has("trg_proposals_detail_text_canon_insert"),
    "proposal inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("proposals").has("trg_proposals_detail_text_canon_update"),
    "proposal updates should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("proposals").has("trg_proposals_selected_options_canon_insert"),
    "proposal inserts should reject non-canonical selected option json",
  );
  assert.ok(
    triggerNames("proposals").has("trg_proposals_selected_options_canon_update"),
    "proposal updates should reject non-canonical selected option json",
  );
  assert.ok(
    triggerNames("proposal_line_items").has("trg_proposal_line_items_identity_canon_insert"),
    "proposal line item inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("proposal_line_items").has("trg_proposal_line_items_identity_canon_update"),
    "proposal line item updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_source_link_insert"),
    "invoice source links should reject half-linked inserts",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_source_link_update"),
    "invoice source links should reject half-linked updates",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_project_source_insert"),
    "invoice project-source links should reject source ids outside the invoice project",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_project_source_update"),
    "invoice project-source link updates should reject source ids outside the invoice project",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_identity_canon_insert"),
    "invoice inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_identity_canon_update"),
    "invoice updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_fee_canon_insert"),
    "invoice inserts should reject non-canonical card fee values",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_fee_canon_update"),
    "invoice updates should reject non-canonical card fee values",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_detail_text_canon_insert"),
    "invoice inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_detail_text_canon_update"),
    "invoice updates should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_accepted_methods_canon_insert"),
    "invoice inserts should reject non-canonical accepted payment methods json",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_accepted_methods_canon_update"),
    "invoice updates should reject non-canonical accepted payment methods json",
  );
  assert.ok(
    triggerNames("proposals").has("trg_proposals_signed_immutable"),
    "signed proposals should reject critical package edits",
  );
  assert.ok(
    triggerNames("proposal_line_items").has("trg_proposal_line_items_signed_insert"),
    "signed proposal line items should reject inserts",
  );
  assert.ok(
    triggerNames("proposal_line_items").has("trg_proposal_line_items_signed_update"),
    "signed proposal line items should reject updates",
  );
  assert.ok(
    triggerNames("proposal_line_items").has("trg_proposal_line_items_signed_delete"),
    "signed proposal line items should reject deletes",
  );
  assert.ok(
    indexNames("invoices").has("idx_invoices_project_source"),
    "invoice source lookups should have a project-scoped source index",
  );
  assert.ok(
    indexNames("invoice_payments").has("idx_invoice_payments_invoice_source"),
    "invoice payment source lookups should include invoice and source",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_source_link_insert"),
    "invoice payment source links should reject half-linked inserts",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_source_link_update"),
    "invoice payment source links should reject half-linked updates",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_project_source_insert"),
    "invoice payment project-source links should reject source ids outside the invoice project",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_project_source_update"),
    "invoice payment project-source link updates should reject source ids outside the invoice project",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_identity_canon_insert"),
    "invoice payment inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_identity_canon_update"),
    "invoice payment updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_ledger_canon_insert"),
    "invoice payment inserts should reject non-canonical ledger amounts",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_ledger_canon_update"),
    "invoice payment updates should reject non-canonical ledger amounts",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_detail_text_canon_insert"),
    "invoice payment inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_detail_text_canon_update"),
    "invoice payment updates should reject blank or padded optional detail text",
  );
  assert.ok(
    indexNames("scheduler_bookings").has("idx_scheduler_bookings_project_payment_source"),
    "scheduler booking payment source lookups should have a project-scoped source index",
  );
  assert.ok(
    triggerNames("scheduler_bookings").has("trg_scheduler_bookings_payment_source_link_insert"),
    "scheduler booking payment source links should reject half-linked inserts",
  );
  assert.ok(
    triggerNames("scheduler_bookings").has("trg_scheduler_bookings_payment_source_link_update"),
    "scheduler booking payment source links should reject half-linked updates",
  );
  assert.ok(
    triggerNames("scheduler_bookings").has("trg_scheduler_bookings_project_payment_source_insert"),
    "scheduler booking payment project-source links should reject source ids outside the booking project",
  );
  assert.ok(
    triggerNames("scheduler_bookings").has("trg_scheduler_bookings_project_payment_source_update"),
    "scheduler booking payment project-source link updates should reject source ids outside the booking project",
  );
  assert.ok(
    triggerNames("scheduler_bookings").has("trg_scheduler_bookings_identity_canon_insert"),
    "scheduler booking inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("scheduler_bookings").has("trg_scheduler_bookings_identity_canon_update"),
    "scheduler booking updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("scheduler_bookings").has("trg_scheduler_bookings_answers_canon_insert"),
    "scheduler booking inserts should reject non-canonical invitee answer json",
  );
  assert.ok(
    triggerNames("scheduler_bookings").has("trg_scheduler_bookings_answers_canon_update"),
    "scheduler booking updates should reject non-canonical invitee answer json",
  );
  assert.ok(
    triggerNames("scheduler_bookings").has("trg_scheduler_bookings_detail_text_canon_insert"),
    "scheduler booking inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("scheduler_bookings").has("trg_scheduler_bookings_detail_text_canon_update"),
    "scheduler booking updates should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("scheduler_bookings").has("trg_scheduler_bookings_payment_canon_insert"),
    "scheduler booking inserts should reject non-canonical payment values",
  );
  assert.ok(
    triggerNames("scheduler_bookings").has("trg_scheduler_bookings_payment_canon_update"),
    "scheduler booking updates should reject non-canonical payment values",
  );
  assert.ok(
    indexNames("expenses").has("idx_expenses_project_source"),
    "expense source lookups should have a project-scoped source index",
  );
  assert.ok(
    triggerNames("expenses").has("trg_expenses_source_link_insert"),
    "expense source links should reject half-linked inserts",
  );
  assert.ok(
    triggerNames("expenses").has("trg_expenses_source_link_update"),
    "expense source links should reject half-linked updates",
  );
  assert.ok(
    triggerNames("expenses").has("trg_expenses_project_source_insert"),
    "expense project-source links should reject source ids outside the expense project",
  );
  assert.ok(
    triggerNames("expenses").has("trg_expenses_project_source_update"),
    "expense project-source link updates should reject source ids outside the expense project",
  );
  assert.ok(
    triggerNames("expenses").has("trg_expenses_identity_canon_insert"),
    "expense inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("expenses").has("trg_expenses_identity_canon_update"),
    "expense updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("expenses").has("trg_expenses_detail_text_canon_insert"),
    "expense inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("expenses").has("trg_expenses_detail_text_canon_update"),
    "expense updates should reject blank or padded optional detail text",
  );
  assert.ok(
    indexNames("agent_tasks").has("idx_agent_tasks_active_dedupe"),
    "agent task creation should have an index matching active project/source/title dedupe",
  );
  assert.ok(
    indexNames("agent_tasks").has("idx_agent_tasks_active_dedupe_unique"),
    "active agent task project/source/title dedupe should be enforced by a unique index",
  );
  assert.ok(
    indexNames("agent_tasks").has("idx_agent_tasks_specialist_queue"),
    "agent task specialist queue listing should be indexed by status, assigned agent, project, and claim order",
  );
  assert.ok(
    triggerNames("agent_tasks").has("trg_agent_tasks_source_link_insert"),
    "agent task source links should reject half-linked inserts",
  );
  assert.ok(
    triggerNames("agent_tasks").has("trg_agent_tasks_source_link_update"),
    "agent task source links should reject half-linked updates",
  );
  assert.ok(
    triggerNames("agent_tasks").has("trg_agent_tasks_project_source_insert"),
    "agent task project-source links should reject source ids outside the task project",
  );
  assert.ok(
    triggerNames("agent_tasks").has("trg_agent_tasks_project_source_update"),
    "agent task project-source link updates should reject source ids outside the task project",
  );
  assert.ok(
    triggerNames("agent_tasks").has("trg_agent_tasks_identity_canon_insert"),
    "agent task inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("agent_tasks").has("trg_agent_tasks_identity_canon_update"),
    "agent task updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("agent_tasks").has("trg_agent_tasks_detail_text_canon_insert"),
    "agent task inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("agent_tasks").has("trg_agent_tasks_detail_text_canon_update"),
    "agent task updates should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("agent_tasks").has("trg_agent_tasks_output_canon_insert"),
    "agent task inserts should reject non-object output payloads",
  );
  assert.ok(
    triggerNames("agent_tasks").has("trg_agent_tasks_output_canon_update"),
    "agent task updates should reject non-object output payloads",
  );
  assert.ok(
    triggerNames("agent_tasks").has("trg_agent_tasks_lifecycle_canon_insert"),
    "agent task inserts should reject terminal lifecycle timestamp drift",
  );
  assert.ok(
    triggerNames("agent_tasks").has("trg_agent_tasks_lifecycle_canon_update"),
    "agent task updates should reject terminal lifecycle timestamp drift",
  );
  assert.ok(
    triggerNames("proposal_access_tokens").has("trg_proposal_access_tokens_identity_canon_insert"),
    "proposal token inserts should reject non-canonical token identity values",
  );
  assert.ok(
    triggerNames("proposal_access_tokens").has("trg_proposal_access_tokens_identity_canon_update"),
    "proposal token updates should reject non-canonical token identity values",
  );
  assert.ok(
    triggerNames("proposal_access_tokens").has("trg_proposal_access_tokens_project_canon_insert"),
    "proposal token inserts should reject project/proposal/client drift",
  );
  assert.ok(
    triggerNames("proposal_access_tokens").has("trg_proposal_access_tokens_project_canon_update"),
    "proposal token updates should reject project/proposal/client drift",
  );
  assert.ok(
    triggerNames("portal_access_tokens").has("trg_portal_access_tokens_identity_canon_insert"),
    "portal token inserts should reject non-canonical token identity values",
  );
  assert.ok(
    triggerNames("portal_access_tokens").has("trg_portal_access_tokens_identity_canon_update"),
    "portal token updates should reject non-canonical token identity values",
  );
  assert.ok(
    triggerNames("portal_access_tokens").has("trg_portal_access_tokens_project_canon_insert"),
    "portal token inserts should reject project/client drift",
  );
  assert.ok(
    triggerNames("portal_access_tokens").has("trg_portal_access_tokens_project_canon_update"),
    "portal token updates should reject project/client drift",
  );
  assert.ok(
    indexNames("activity_logs").has("idx_activity_logs_action_created"),
    "activity logs should have an action/date index for fast audit filtering",
  );
  assert.ok(
    triggerNames("activity_logs").has("trg_activity_logs_identity_canon_insert"),
    "activity log inserts should reject non-canonical action and actor values",
  );
  assert.ok(
    triggerNames("activity_logs").has("trg_activity_logs_identity_canon_update"),
    "activity log updates should reject non-canonical action and actor values",
  );
  assert.ok(
    triggerNames("activity_logs").has("trg_activity_logs_metadata_canon_insert"),
    "activity log inserts should reject non-object metadata payloads",
  );
  assert.ok(
    triggerNames("activity_logs").has("trg_activity_logs_metadata_canon_update"),
    "activity log updates should reject non-object metadata payloads",
  );
  assert.ok(
    triggerNames("templates").has("trg_templates_identity_canon_insert"),
    "template inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("templates").has("trg_templates_identity_canon_update"),
    "template updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("templates").has("trg_templates_detail_text_canon_insert"),
    "template inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("templates").has("trg_templates_detail_text_canon_update"),
    "template updates should reject blank or padded optional detail text",
  );
  assert.ok(
    indexNames("google_calendar_connections").has("idx_google_calendar_connections_active_email_unique"),
    "active Google calendar account emails should be uniquely indexed",
  );
  assert.ok(
    triggerNames("google_calendar_connections").has("trg_google_calendar_connections_identity_canon_insert"),
    "Google calendar connection inserts should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("google_calendar_connections").has("trg_google_calendar_connections_identity_canon_update"),
    "Google calendar connection updates should reject non-canonical identity values",
  );
  assert.ok(
    triggerNames("google_calendar_connections").has("trg_google_calendar_connections_detail_text_canon_insert"),
    "Google calendar connection inserts should reject blank or padded optional detail text",
  );
  assert.ok(
    triggerNames("google_calendar_connections").has("trg_google_calendar_connections_detail_text_canon_update"),
    "Google calendar connection updates should reject blank or padded optional detail text",
  );
  assert.ok(
    indexNames("invoice_payments").has("idx_invoice_payments_external_payment_unique"),
    "invoice payment external ids should be uniquely indexed for ledger reconciliation",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_schedule_total_insert"),
    "invoice payment schedules should reject inserts that exceed the invoice total",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_schedule_total_update"),
    "invoice payment schedules should reject updates that exceed the invoice total",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_paid_amount_insert"),
    "invoice payment inserts should reject paid amounts that exceed the scheduled amount",
  );
  assert.ok(
    triggerNames("invoice_payments").has("trg_invoice_payments_paid_amount_update"),
    "invoice payment updates should reject paid amounts that exceed the scheduled amount",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_paid_state_insert"),
    "invoice inserts should reject paid state drift",
  );
  assert.ok(
    triggerNames("invoices").has("trg_invoices_paid_state_update"),
    "invoice updates should reject paid state drift",
  );
  assert.ok(
    indexNames("scheduler_bookings").has("idx_scheduler_bookings_external_payment_unique"),
    "scheduler booking external payment ids should be uniquely indexed for ledger reconciliation",
  );
  assert.ok(
    indexNames("expenses").has("idx_expenses_external_payment_unique"),
    "expense external payment ids should be uniquely indexed for bookkeeping reconciliation",
  );
  assert.ok(
    indexNames("project_sources").has("idx_project_sources_project_source_unique"),
    "project upstream source ids should be uniquely indexed per project",
  );

  // Phase 9a — refund/dispute recording + tax/1099 + mileage (migration 0089).
  assert.ok(
    columnNames("invoice_payments").has("refunded_amount_cents"),
    "invoice payments should track cumulative refunded amount for net-collected math",
  );
  assert.ok(
    columnNames("invoice_payments").has("dispute_status")
      && columnNames("invoice_payments").has("disputed_amount_cents")
      && columnNames("invoice_payments").has("last_refund_at"),
    "invoice payments should carry the dispute/refund summary columns read on the always-on finance path",
  );
  assert.ok(
    columnNames("vendors").has("tax_id_last4")
      && columnNames("vendors").has("is_1099_tracked")
      && columnNames("vendors").has("legal_name")
      && columnNames("vendors").has("tax_address"),
    "vendors should carry admin-entered W-9 columns (TIN last4 only)",
  );
  // Phase 9a — finance rate settings columns on app_settings (backfilled assertions).
  assert.ok(
    columnNames("app_settings").has("tax_set_aside_rate_percent")
      && columnNames("app_settings").has("mileage_rate_cents")
      && columnNames("app_settings").has("form_1099_threshold_cents"),
    "app settings should carry the 9a finance-rate columns (set-aside %, mileage ¢, 1099 threshold)",
  );
  // Phase 10 — intelligence/forecasting admin settings (migration 0090). Nullable,
  // safe code defaults when NULL; read on the always-on settings path.
  assert.ok(
    columnNames("app_settings").has("forecast_horizon_months")
      && columnNames("app_settings").has("forecast_trailing_months")
      && columnNames("app_settings").has("monthly_capacity_target")
      && columnNames("app_settings").has("lead_source_taxonomy_json"),
    "app settings should carry the Phase 10 intelligence/forecasting columns",
  );
  assert.ok(
    columnNames("stripe_webhook_events").has("event_id"),
    "stripe webhook events dedupe table should exist keyed on the Stripe event id",
  );
  assert.ok(
    indexNames("payment_refunds").has("idx_payment_refunds_stripe_refund_id_unique"),
    "payment refund Stripe ids should be uniquely indexed for at-least-once webhook dedupe",
  );
  assert.ok(
    indexNames("payment_disputes").has("idx_payment_disputes_stripe_dispute_id_unique"),
    "payment dispute Stripe ids should be uniquely indexed for at-least-once webhook dedupe",
  );
  assert.ok(
    indexNames("payment_refunds").has("idx_payment_refunds_pi")
      && indexNames("payment_refunds").has("idx_payment_refunds_ip")
      && indexNames("payment_refunds").has("idx_payment_refunds_created"),
    "payment refunds should be indexed by payment-intent, linked payment, and money-event date",
  );
  assert.ok(
    indexNames("payment_disputes").has("idx_payment_disputes_pi")
      && indexNames("payment_disputes").has("idx_payment_disputes_ip"),
    "payment disputes should be indexed by payment-intent and linked payment",
  );
  assert.ok(
    columnNames("payment_refunds").has("stripe_created_at")
      && columnNames("payment_disputes").has("stripe_created_at"),
    "child refund/dispute rows should store the Stripe event time for out-of-order monotonic guards",
  );
  assert.ok(
    columnNames("mileage_logs").has("trip_date") && columnNames("mileage_logs").has("miles"),
    "mileage logs table should exist for the tax deduction report",
  );

  // Phase 9b — refund INITIATION audit/idempotency ledger (migration 0091). The row id is
  // the Stripe Idempotency-Key; the money-critical columns (amount_cents, status,
  // service_not_rendered_confirmed, reason, stripe_refund_id) must all exist, and the table
  // must be indexed by payment/refund/status for the §3.1 dedupe-union cap + §4.4 tripwires.
  assert.ok(
    columnNames("refund_initiations").has("amount_cents")
      && columnNames("refund_initiations").has("status")
      && columnNames("refund_initiations").has("service_not_rendered_confirmed")
      && columnNames("refund_initiations").has("reason")
      && columnNames("refund_initiations").has("stripe_refund_id")
      && columnNames("refund_initiations").has("stripe_payment_intent_id")
      && columnNames("refund_initiations").has("error_message")
      && columnNames("refund_initiations").has("claim_token")
      && columnNames("refund_initiations").has("initiated_by"),
    "refund_initiations should carry the money-critical audit/idempotency columns",
  );
  assert.ok(
    indexNames("refund_initiations").has("idx_refund_initiations_payment")
      && indexNames("refund_initiations").has("idx_refund_initiations_refund")
      && indexNames("refund_initiations").has("idx_refund_initiations_status"),
    "refund_initiations should be indexed by payment, Stripe refund id, and status",
  );

  // The refund dedupe write is INSERT ... ON CONFLICT DO NOTHING — the UNIQUE index is
  // what makes a redelivered webhook converge instead of double-recording.
  const refundCanonNow = new Date("2026-07-01T12:00:00.000Z").toISOString();
  database.prepare(`
    INSERT INTO payment_refunds (id, stripe_refund_id, amount_cents, currency, status, created_at, updated_at)
    VALUES ('refund-canon-1', 're_canon', 5000, 'usd', 'succeeded', ?, ?)
  `).run(refundCanonNow, refundCanonNow);
  assert.throws(
    () => database.prepare(`
      INSERT INTO payment_refunds (id, stripe_refund_id, amount_cents, currency, status, created_at, updated_at)
      VALUES ('refund-canon-2', 're_canon', 9999, 'usd', 'succeeded', ?, ?)
    `).run(refundCanonNow, refundCanonNow),
    /UNIQUE constraint failed/,
    "a replayed refund id must not create a second payment_refunds row",
  );

  const now = new Date("2026-05-29T12:00:00.000Z").toISOString();
  database.prepare(`
    INSERT INTO app_settings (
      id, business_name, public_brand_name, contact_email, website_url, instagram_url, timezone,
      payment_methods_json, created_at, updated_at
    ) VALUES (
      'business', 'Alex & Tyler Reese', 'The Reeses Studio', 'hello@bythereeses.com',
      'https://bythereeses.com', 'https://instagram.com/thereeses', 'America/New_York',
      '{"stripe":{"enabled":true,"passFees":true,"displayName":"Credit card","instructions":""}}',
      ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO app_settings (
        id, business_name, public_brand_name, contact_email, timezone, payment_methods_json, created_at, updated_at
      ) VALUES (
        'settings-padded-name', ' Alex & Tyler Reese ', 'The Reeses Studio', 'hello@bythereeses.com',
        'America/New_York', '{}', ?, ?
      )
    `).run(now, now),
    /app setting business name must be trimmed non-empty text/,
    "direct settings inserts should not create padded business names",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE app_settings
      SET contact_email = ' HELLO@BYTHEREESES.COM '
      WHERE id = 'business'
    `).run(),
    /app setting contact email must be lowercase and trimmed/,
    "business contact email should remain lowercase and trimmed for client-facing output",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE app_settings
      SET payment_methods_json = '[]'
      WHERE id = 'business'
    `).run(),
    /app setting payment methods must be canonical json object text/,
    "payment method settings should remain canonical JSON object text",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE app_settings
      SET website_url = '  '
      WHERE id = 'business'
    `).run(),
    /app setting detail text must be null or trimmed non-empty text/,
    "business setting optional detail text should not drift into whitespace",
  );

  database.prepare(`
    INSERT INTO templates (
      id, type, name, trigger, subject, body, status, created_at, updated_at
    ) VALUES (
      'template-1', 'contract', 'Wedding contract', 'proposal ready',
      'Your proposal package', 'Contract body for The Reeses Studio.',
      'active', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO templates (
      id, type, name, trigger, subject, body, status, created_at, updated_at
    ) VALUES (
      'template-proposal-package', 'proposal_package', 'Signature Collection',
      'discovery call complete', 'Collection overview',
      'Package body for The Reeses Studio.', 'active', ?, ?
    ), (
      'template-reminder', 'reminder', 'Invoice reminder',
      '3 days before due date', NULL,
      'Reminder body for The Reeses Studio.', 'draft', ?, ?
    )
  `).run(now, now, now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO templates (
        id, type, name, body, status, created_at, updated_at
      ) VALUES (
        'template-invalid-type', 'invoice', 'Invalid type template',
        'Template body.', 'active', ?, ?
      )
    `).run(now, now),
    /template type must be canonical/,
    "template types should remain one of the Studio reusable-content kinds",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE templates
      SET status = 'published'
      WHERE id = 'template-1'
    `).run(),
    /template status must be canonical/,
    "template statuses should remain active, draft, or archived",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE templates
      SET name = ' Wedding contract '
      WHERE id = 'template-1'
    `).run(),
    /template name must be trimmed non-empty text/,
    "template names should not drift into padded text",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE templates
      SET body = ''
      WHERE id = 'template-1'
    `).run(),
    /template body must be trimmed non-empty text/,
    "template bodies should not drift into blank text",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE templates
      SET subject = '  '
      WHERE id = 'template-1'
    `).run(),
    /template detail text must be null or trimmed non-empty text/,
    "template optional detail text should not drift into whitespace",
  );

  database.prepare(`
    INSERT INTO google_calendar_connections (
      id, google_account_email, display_name, refresh_token, scope, created_at, updated_at
    ) VALUES (
      'google-connection-1', 'hello@bythereeses.com', 'The Reeses', 'encrypted-refresh-token',
      'openid https://www.googleapis.com/auth/calendar', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO google_calendar_connections (
        id, google_account_email, refresh_token, created_at, updated_at
      ) VALUES (
        'google-connection-uppercase-email', 'HELLO@BYTHEREESES.COM',
        'encrypted-refresh-token-2', ?, ?
      )
    `).run(now, now),
    /Google calendar account email must be lowercase and trimmed/,
    "Google account emails should stay lowercase for sync-account lookup",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE google_calendar_connections
      SET refresh_token = ' encrypted-refresh-token '
      WHERE id = 'google-connection-1'
    `).run(),
    /Google calendar refresh token must be trimmed non-empty text/,
    "Google refresh tokens should not drift into padded encrypted payloads",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE google_calendar_connections
      SET display_name = ''
      WHERE id = 'google-connection-1'
    `).run(),
    /Google calendar connection detail text must be null or trimmed non-empty text/,
    "Google connection optional detail text should not drift into whitespace",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO google_calendar_connections (
        id, google_account_email, refresh_token, created_at, updated_at
      ) VALUES (
        'google-connection-duplicate-active', 'hello@bythereeses.com',
        'encrypted-refresh-token-3', ?, ?
      )
    `).run(now, now),
    /UNIQUE constraint failed/,
    "only one active Google calendar connection should exist per account email",
  );

  database.prepare(`
    INSERT INTO scheduler_settings (
      id, timezone, booking_window_days, minimum_notice_minutes, availability_json,
      google_calendar_ids, google_create_calendar_id, zoom_join_url, created_at, updated_at
    ) VALUES (
      'default', 'America/New_York', 30, 240,
      '[{"day":2,"start":"10:00","end":"16:00"}]',
      'hello@bythereeses.com', 'hello@bythereeses.com', 'https://zoom.us/j/123', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      UPDATE scheduler_settings
      SET timezone = ' America/New_York '
      WHERE id = 'default'
    `).run(),
    /scheduler setting timezone must be trimmed non-empty text/,
    "scheduler timezone should not drift into padded text",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE scheduler_settings
      SET booking_window_days = 0
      WHERE id = 'default'
    `).run(),
    /scheduler setting booking window must be positive/,
    "scheduler booking window should stay positive",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE scheduler_settings
      SET availability_json = '{}'
      WHERE id = 'default'
    `).run(),
    /scheduler setting availability must be canonical json array text/,
    "scheduler availability should remain canonical JSON array text",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE scheduler_settings
      SET zoom_join_url = '  '
      WHERE id = 'default'
    `).run(),
    /scheduler setting detail text must be null or trimmed non-empty text/,
    "scheduler optional detail text should not drift into whitespace",
  );

  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, description, duration_minutes, buffer_minutes, location_type,
      location_label, invitee_questions_json, collect_payment, price_cents,
      sms_opt_in_enabled, confirmation_message, is_active, created_at, updated_at
    ) VALUES (
      'meeting-config-1', 'studio-consult', 'Studio Consult', 'Paid consult',
      45, 15, 'zoom', 'Zoom', '[{"id":"goal","label":"Goal","type":"textarea","required":false}]',
      1, 25000, 0, 'You are booked.', 1, ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO scheduler_meeting_types (
        id, slug, name, duration_minutes, buffer_minutes, location_type, collect_payment,
        sms_opt_in_enabled, is_active, created_at, updated_at
      ) VALUES (
        'meeting-padded-slug', ' studio-consult-2 ', 'Studio Consult 2', 45, 15, 'zoom',
        0, 0, 1, ?, ?
      )
    `).run(now, now),
    /scheduler meeting type slug must be lowercase and trimmed/,
    "scheduler meeting type slugs should remain canonical URL identifiers",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE scheduler_meeting_types
      SET duration_minutes = 0
      WHERE id = 'meeting-config-1'
    `).run(),
    /scheduler meeting type duration must be positive/,
    "scheduler meeting durations should stay positive",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE scheduler_meeting_types
      SET invitee_questions_json = '{}'
      WHERE id = 'meeting-config-1'
    `).run(),
    /scheduler meeting type questions must be null or canonical json array text/,
    "scheduler meeting type questions should remain canonical JSON array text",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE scheduler_meeting_types
      SET collect_payment = 2
      WHERE id = 'meeting-config-1'
    `).run(),
    /scheduler meeting type boolean fields must be canonical/,
    "scheduler meeting type boolean fields should remain canonical",
  );

  database.prepare(`
    INSERT INTO clients (id, first_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, email, created_at, updated_at)
    VALUES ('client-2', 'Jordan', 'jordan@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, email, created_at, updated_at)
    VALUES ('client-3', 'Morgan', 'morgan@example.com', ?, ?)
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO clients (id, first_name, email, created_at, updated_at)
      VALUES ('client-blank-email', 'Blank Email', '   ', ?, ?)
    `).run(now, now),
    /client email is required/,
    "direct client inserts should not create blank email identities",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE clients
      SET email = ''
      WHERE id = 'client-2'
    `).run(),
    /client email is required/,
    "direct client updates should not erase canonical email identities",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO clients (id, first_name, email, created_at, updated_at)
      VALUES ('client-padded-email', 'Padded Email', ' ALEX.NEW@EXAMPLE.COM ', ?, ?)
    `).run(now, now),
    /client email must be lowercase and trimmed/,
    "direct client inserts should not create padded or uppercase email identities",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE clients
      SET email = ' ALEX.NEW@EXAMPLE.COM '
      WHERE id = 'client-2'
    `).run(),
    /client email must be lowercase and trimmed/,
    "direct client updates should not drift email casing or whitespace",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO clients (id, first_name, email, created_at, updated_at)
      VALUES ('client-duplicate-email', 'Alex Duplicate', 'alex@example.com', ?, ?)
    `).run(now, now),
    /UNIQUE constraint failed/,
    "client emails should not drift into duplicate normalized identities",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO clients (id, first_name, email, phone, created_at, updated_at)
      VALUES ('client-blank-phone', 'Blank Phone', 'blank.phone@example.com', '   ', ?, ?)
    `).run(now, now),
    /client phone must be null or trimmed non-empty text/,
    "direct client inserts should not create blank phone values",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO clients (id, first_name, email, phone, created_at, updated_at)
      VALUES ('client-padded-phone', 'Padded Phone', 'padded.phone@example.com', ' 555-0100 ', ?, ?)
    `).run(now, now),
    /client phone must be null or trimmed non-empty text/,
    "direct client inserts should not create padded phone values",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE clients
      SET phone = ''
      WHERE id = 'client-2'
    `).run(),
    /client phone must be null or trimmed non-empty text/,
    "direct client updates should not create blank phone values",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE clients
      SET phone = ' 555-0102 '
      WHERE id = 'client-2'
    `).run(),
    /client phone must be null or trimmed non-empty text/,
    "direct client updates should not create padded phone values",
  );
  database.prepare(`
    UPDATE clients
    SET phone = NULL
    WHERE id = 'client-2'
  `).run();
  assert.deepEqual(database.prepare("SELECT phone FROM clients WHERE id = 'client-2'").get(), {
    phone: null,
  });
  assert.throws(
    () => database.prepare(`
      INSERT INTO clients (id, first_name, email, instagram_handle, created_at, updated_at)
      VALUES ('client-bad-instagram', 'Bad Instagram', 'bad.instagram@example.com', 'badhandle', ?, ?)
    `).run(now, now),
    /client profile fields must be null or canonical trimmed text/,
    "direct client inserts should not create unprefixed Instagram handles",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE clients
      SET communication_preference = ' email please '
      WHERE id = 'client-2'
    `).run(),
    /client profile fields must be null or canonical trimmed text/,
    "direct client updates should not create padded communication preferences",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE clients
      SET referral_source = ''
      WHERE id = 'client-2'
    `).run(),
    /client profile fields must be null or canonical trimmed text/,
    "direct client updates should not create blank referral sources",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO clients (id, first_name, email, created_at, updated_at)
      VALUES ('client-blank-first-name', '', 'blank.name@example.com', ?, ?)
    `).run(now, now),
    /client first name must be trimmed non-empty text/,
    "direct client inserts should not create blank first names",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO clients (id, first_name, email, created_at, updated_at)
      VALUES ('client-padded-first-name', ' Alex ', 'padded.name@example.com', ?, ?)
    `).run(now, now),
    /client first name must be trimmed non-empty text/,
    "direct client inserts should not create padded first names",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE clients
      SET first_name = ' Jordan '
      WHERE id = 'client-2'
    `).run(),
    /client first name must be trimmed non-empty text/,
    "direct client updates should not create padded first names",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
      VALUES ('client-blank-last-name', 'Blank', '   ', 'blank.last@example.com', ?, ?)
    `).run(now, now),
    /client optional names must be null or trimmed non-empty text/,
    "direct client inserts should not create blank optional names",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO clients (id, first_name, preferred_name, email, created_at, updated_at)
      VALUES ('client-padded-preferred-name', 'Padded', ' Lex ', 'padded.preferred@example.com', ?, ?)
    `).run(now, now),
    /client optional names must be null or trimmed non-empty text/,
    "direct client inserts should not create padded optional names",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE clients
      SET preferred_name = ''
      WHERE id = 'client-2'
    `).run(),
    /client optional names must be null or trimmed non-empty text/,
    "direct client updates should not create blank optional names",
  );
  database.prepare(`
    UPDATE clients
    SET last_name = NULL,
      preferred_name = NULL
    WHERE id = 'client-2'
  `).run();
  assert.deepEqual(database.prepare("SELECT last_name, preferred_name FROM clients WHERE id = 'client-2'").get(), {
    last_name: null,
    preferred_name: null,
  });
  assert.throws(
    () => database.prepare(`
      INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
      VALUES ('project-blank-name', '', 'wedding', 'inquiry', 'active', ?, ?)
    `).run(now, now),
    /project name must be trimmed non-empty text/,
    "direct project inserts should not create blank project names",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
      VALUES ('project-padded-name', ' Alex Wedding ', 'wedding', 'inquiry', 'active', ?, ?)
    `).run(now, now),
    /project name must be trimmed non-empty text/,
    "direct project inserts should not create padded project names",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
      VALUES ('project-blank-type', 'Blank Type Wedding', '   ', 'inquiry', 'active', ?, ?)
    `).run(now, now),
    /project type must be trimmed non-empty text/,
    "direct project inserts should not create blank project types",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
      VALUES ('project-invalid-stage', 'Invalid Stage Wedding', 'wedding', 'maybe', 'active', ?, ?)
    `).run(now, now),
    /project stage must be canonical/,
    "direct project inserts should not create invalid project stages",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
      VALUES ('project-invalid-status', 'Invalid Status Wedding', 'wedding', 'inquiry', 'maybe', ?, ?)
    `).run(now, now),
    /project status must be canonical/,
    "direct project inserts should not create invalid project statuses",
  );
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      UPDATE projects
      SET name = ' Alex Wedding '
      WHERE id = 'project-1'
    `).run(),
    /project name must be trimmed non-empty text/,
    "direct project updates should not create padded project names",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE projects
      SET stage = 'retainer paid'
      WHERE id = 'project-1'
    `).run(),
    /project stage must be canonical/,
    "direct project updates should not create invalid project stages",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE projects
      SET status = 'deleted'
      WHERE id = 'project-1'
    `).run(),
    /project status must be canonical/,
    "direct project updates should not create invalid project statuses",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
      VALUES ('project-blank-event-date', 'Blank Event Date', 'wedding', 'inquiry', 'active', '   ', ?, ?)
    `).run(now, now),
    /project detail text must be null or trimmed non-empty text/,
    "direct project inserts should not create blank event dates",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO projects (id, name, type, stage, status, venue_name, created_at, updated_at)
      VALUES ('project-padded-venue', 'Padded Venue', 'wedding', 'inquiry', 'active', ' Garden House ', ?, ?)
    `).run(now, now),
    /project detail text must be null or trimmed non-empty text/,
    "direct project inserts should not create padded venue names",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE projects
      SET city = ''
      WHERE id = 'project-1'
    `).run(),
    /project detail text must be null or trimmed non-empty text/,
    "direct project updates should not create blank city values",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE projects
      SET notes = ' Updated notes '
      WHERE id = 'project-1'
    `).run(),
    /project detail text must be null or trimmed non-empty text/,
    "direct project updates should not create padded notes",
  );
  database.prepare(`
    UPDATE projects
    SET event_date = NULL,
      venue_name = NULL,
      venue_address = NULL,
      city = NULL,
      state = NULL,
      notes = NULL
    WHERE id = 'project-1'
  `).run();
  assert.deepEqual(database.prepare(`
    SELECT event_date, venue_name, venue_address, city, state, notes
    FROM projects
    WHERE id = 'project-1'
  `).get(), {
    event_date: null,
    venue_name: null,
    venue_address: null,
    city: null,
    state: null,
    notes: null,
  });

  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, created_at, updated_at
    ) VALUES (
      'location-source-1', 'project-1', 'planning_note', 'Location source',
      'Location logistics source.', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_locations (
      id, project_id, type, name, address, city, state, notes, source_type, source_id, created_at, updated_at
    ) VALUES (
      'location-1', 'project-1', 'getting_ready', 'The Studio Suite',
      '123 Main St', 'Chatham', 'MA', 'Hair and makeup.', 'project_source', 'location-source-1', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_locations (
        id, project_id, type, name, source_id, created_at, updated_at
      ) VALUES (
        'location-half-source', 'project-1', 'ceremony', 'Ceremony lawn', 'location-source-1', ?, ?
      )
    `).run(now, now),
    /project location source links require sourceType when sourceId is set/,
    "direct location inserts should not create half-linked source references",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_locations (
        id, project_id, type, name, source_type, source_id, created_at, updated_at
      ) VALUES (
        'location-wrong-source', 'project-2', 'ceremony', 'Ceremony lawn', 'project_source', 'location-source-1', ?, ?
      )
    `).run(now, now),
    /Project source not found for this project/,
    "direct location inserts should not link to another project's source",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_locations (
        id, project_id, type, name, created_at, updated_at
      ) VALUES (
        'location-blank-name', 'project-1', 'ceremony', '', ?, ?
      )
    `).run(now, now),
    /project location name must be trimmed non-empty text/,
    "direct location inserts should not create blank names",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_locations (
        id, project_id, type, name, created_at, updated_at
      ) VALUES (
        'location-padded-type', 'project-1', ' ceremony ', 'Ceremony lawn', ?, ?
      )
    `).run(now, now),
    /project location type must be trimmed non-empty text/,
    "direct location inserts should not create padded type labels",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_locations
      SET name = ' The Studio Suite '
      WHERE id = 'location-1'
    `).run(),
    /project location name must be trimmed non-empty text/,
    "direct location updates should not create padded names",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_locations
      SET address = '  '
      WHERE id = 'location-1'
    `).run(),
    /project location detail text must be null or trimmed non-empty text/,
    "direct location updates should not create whitespace-only addresses",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_locations
      SET notes = ' Hair and makeup. '
      WHERE id = 'location-1'
    `).run(),
    /project location detail text must be null or trimmed non-empty text/,
    "direct location updates should not create padded notes",
  );

  assert.throws(
    () => database.prepare(`
      INSERT INTO project_events (id, project_id, type, title, calendar_sync_status, created_at, updated_at)
      VALUES ('event-blank-title', 'project-1', 'wedding', '', 'not_connected', ?, ?)
    `).run(now, now),
    /project event title must be trimmed non-empty text/,
    "direct project event inserts should not create blank event titles",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_events (id, project_id, type, title, calendar_sync_status, created_at, updated_at)
      VALUES ('event-padded-title', 'project-1', 'wedding', ' Wedding day ', 'not_connected', ?, ?)
    `).run(now, now),
    /project event title must be trimmed non-empty text/,
    "direct project event inserts should not create padded event titles",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_events (id, project_id, type, title, calendar_sync_status, created_at, updated_at)
      VALUES ('event-blank-type', 'project-1', '   ', 'Blank Type Event', 'not_connected', ?, ?)
    `).run(now, now),
    /project event type must be trimmed non-empty text/,
    "direct project event inserts should not create blank event types",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_events (id, project_id, type, title, event_date, calendar_sync_status, created_at, updated_at)
      VALUES ('event-blank-date', 'project-1', 'wedding', 'Blank Date Event', '   ', 'not_connected', ?, ?)
    `).run(now, now),
    /project event detail text must be null or trimmed non-empty text/,
    "direct project event inserts should not create blank event dates",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_events (id, project_id, type, title, venue_name, calendar_sync_status, created_at, updated_at)
      VALUES ('event-padded-venue', 'project-1', 'wedding', 'Padded Venue Event', ' Garden House ', 'not_connected', ?, ?)
    `).run(now, now),
    /project event detail text must be null or trimmed non-empty text/,
    "direct project event inserts should not create padded venue names",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_events (id, project_id, type, title, calendar_sync_status, created_at, updated_at)
      VALUES ('event-invalid-calendar-status', 'project-1', 'wedding', 'Invalid Calendar Event', 'maybe', ?, ?)
    `).run(now, now),
    /project event calendar sync status must be canonical/,
    "direct project event inserts should not create invalid calendar sync statuses",
  );
  database.prepare(`
    INSERT INTO project_events (id, project_id, type, title, calendar_sync_status, created_at, updated_at)
    VALUES ('event-canon-1', 'project-1', 'wedding', 'Wedding day', 'not_connected', ?, ?)
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      UPDATE project_events
      SET title = ' Wedding day '
      WHERE id = 'event-canon-1'
    `).run(),
    /project event title must be trimmed non-empty text/,
    "direct project event updates should not create padded titles",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_events
      SET city = ''
      WHERE id = 'event-canon-1'
    `).run(),
    /project event detail text must be null or trimmed non-empty text/,
    "direct project event updates should not create blank city values",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_events
      SET calendar_sync_status = 'done'
      WHERE id = 'event-canon-1'
    `).run(),
    /project event calendar sync status must be canonical/,
    "direct project event updates should not create invalid calendar sync statuses",
  );
  database.prepare(`
    UPDATE project_events
    SET event_date = NULL,
      venue_name = NULL,
      venue_address = NULL,
      city = NULL,
      state = NULL
    WHERE id = 'event-canon-1'
  `).run();
  assert.deepEqual(database.prepare(`
    SELECT event_date, venue_name, venue_address, city, state
    FROM project_events
    WHERE id = 'event-canon-1'
  `).get(), {
    event_date: null,
    venue_name: null,
    venue_address: null,
    city: null,
    state: null,
  });
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
      VALUES ('participant-blank-role', 'project-1', 'client-2', '', 0, ?)
    `).run(now),
    /project participant role must be trimmed non-empty text/,
    "direct participant inserts should not create blank roles",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
      VALUES ('participant-padded-role', 'project-1', 'client-2', ' partner ', 0, ?)
    `).run(now),
    /project participant role must be trimmed non-empty text/,
    "direct participant inserts should not create padded roles",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
      VALUES ('participant-invalid-primary-flag', 'project-1', 'client-2', 'partner', 2, ?)
    `).run(now),
    /project participant primary flag must be canonical/,
    "direct participant inserts should not create non-boolean primary flags",
  );

  database.prepare(`
    INSERT INTO questionnaires (id, title, status, created_at, updated_at)
    VALUES ('questionnaire-1', 'Canon questionnaire', 'active', ?, ?)
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO questionnaires (id, title, status, created_at, updated_at)
      VALUES ('questionnaire-blank-title', '', 'active', ?, ?)
    `).run(now, now),
    /questionnaire title must be trimmed non-empty text/,
    "direct questionnaire inserts should not create blank titles",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO questionnaires (id, title, status, created_at, updated_at)
      VALUES ('questionnaire-padded-title', ' Canon questionnaire ', 'active', ?, ?)
    `).run(now, now),
    /questionnaire title must be trimmed non-empty text/,
    "direct questionnaire inserts should not create padded titles",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE questionnaires
      SET status = 'live'
      WHERE id = 'questionnaire-1'
    `).run(),
    /questionnaire status must be canonical/,
    "direct questionnaire updates should not create invalid statuses",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE questionnaires
      SET source_form_url = ' https://forms.example.com '
      WHERE id = 'questionnaire-1'
    `).run(),
    /questionnaire detail text must be null or trimmed non-empty text/,
    "direct questionnaire updates should not create padded optional text",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE questionnaires
      SET external_question_count = -1
      WHERE id = 'questionnaire-1'
    `).run(),
    /questionnaire counts must be canonical non-negative integers/,
    "direct questionnaire updates should not create negative counts",
  );
  database.prepare(`
    INSERT INTO questionnaire_questions (
      id, questionnaire_id, title, type, required, options_json, sort_order, created_at, updated_at
    ) VALUES (
      'question-1', 'questionnaire-1', 'Canon question', 'short_text', 1, NULL, 0, ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO questionnaire_questions (
        id, questionnaire_id, title, type, required, sort_order, created_at, updated_at
      ) VALUES (
        'question-blank-title', 'questionnaire-1', '', 'short_text', 0, 1, ?, ?
      )
    `).run(now, now),
    /questionnaire question title must be trimmed non-empty text/,
    "direct questionnaire question inserts should not create blank titles",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO questionnaire_questions (
        id, questionnaire_id, title, type, required, sort_order, created_at, updated_at
      ) VALUES (
        'question-invalid-type', 'questionnaire-1', 'Invalid type question', 'textarea', 0, 1, ?, ?
      )
    `).run(now, now),
    /questionnaire question type must be canonical/,
    "direct questionnaire question inserts should not create invalid types",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO questionnaire_questions (
        id, questionnaire_id, title, type, required, sort_order, created_at, updated_at
      ) VALUES (
        'question-invalid-required', 'questionnaire-1', 'Invalid required flag', 'short_text', 2, 1, ?, ?
      )
    `).run(now, now),
    /questionnaire question required flag must be canonical/,
    "direct questionnaire question inserts should not create non-boolean required flags",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO questionnaire_questions (
        id, questionnaire_id, title, type, required, options_json, sort_order, created_at, updated_at
      ) VALUES (
        'question-invalid-options', 'questionnaire-1', 'Invalid options question',
        'multiple_choice', 0, '{"yes":true}', 1, ?, ?
      )
    `).run(now, now),
    /questionnaire question options must be null or canonical json array text/,
    "direct questionnaire question inserts should not create object-shaped options json",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE questionnaire_questions
      SET options_json = ' ["Yes"] '
      WHERE id = 'question-1'
    `).run(),
    /questionnaire question options must be null or canonical json array text/,
    "direct questionnaire question updates should not create padded options json",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE questionnaire_questions
      SET sort_order = -1
      WHERE id = 'question-1'
    `).run(),
    /questionnaire question sort order must be canonical/,
    "direct questionnaire question updates should not create negative sort orders",
  );
  database.prepare(`
    INSERT INTO questionnaire_responses (
      id, questionnaire_id, project_id, client_id, answers_json, submitted_at, created_at, updated_at
    ) VALUES (
      'questionnaire-response-1', 'questionnaire-1', 'project-1', 'client-1',
      '[]', ?, ?, ?
    )
  `).run(now, now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO questionnaire_responses (
        id, questionnaire_id, project_id, client_id, answers_json, created_at, updated_at
      ) VALUES (
        'questionnaire-response-invalid-json', 'questionnaire-1', 'project-1', 'client-2',
        'not-json', ?, ?
      )
    `).run(now, now),
    /questionnaire response answers must be canonical json array text/,
    "direct questionnaire response inserts should not create malformed answer json",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO questionnaire_responses (
        id, questionnaire_id, project_id, client_id, answers_json, created_at, updated_at
      ) VALUES (
        'questionnaire-response-json-object', 'questionnaire-1', 'project-1', 'client-2',
        '{"answer":"yes"}', ?, ?
      )
    `).run(now, now),
    /questionnaire response answers must be canonical json array text/,
    "direct questionnaire response inserts should not create non-array answer json",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE questionnaire_responses
      SET answers_json = ' [] '
      WHERE id = 'questionnaire-response-1'
    `).run(),
    /questionnaire response answers must be canonical json array text/,
    "direct questionnaire response updates should not create padded answer json",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO questionnaire_responses (
        id, questionnaire_id, project_id, client_id, respondent_name, answers_json, created_at, updated_at
      ) VALUES (
        'questionnaire-response-padded-name', 'questionnaire-1', 'project-1', 'client-2',
        ' Alex Taylor ', '[]', ?, ?
      )
    `).run(now, now),
    /questionnaire response detail text must be null or trimmed non-empty text/,
    "direct questionnaire response inserts should not create padded respondent names",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO questionnaire_responses (
        id, questionnaire_id, project_id, client_id, respondent_email, answers_json, created_at, updated_at
      ) VALUES (
        'questionnaire-response-uppercase-email', 'questionnaire-1', 'project-1', 'client-2',
        'ALEX@EXAMPLE.COM', '[]', ?, ?
      )
    `).run(now, now),
    /questionnaire response respondent email must be lowercase and trimmed/,
    "direct questionnaire response inserts should not create uppercase respondent emails",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE questionnaire_responses
      SET source_response_id = ''
      WHERE id = 'questionnaire-response-1'
    `).run(),
    /questionnaire response detail text must be null or trimmed non-empty text/,
    "direct questionnaire response updates should not create blank optional source ids",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO questionnaire_responses (
        id, questionnaire_id, project_id, client_id, answers_json, created_at, updated_at
      ) VALUES (
        'questionnaire-response-duplicate', 'questionnaire-1', 'project-1', 'client-1',
        '[]', ?, ?
      )
    `).run(now, now),
    /UNIQUE constraint failed/,
    "a project/client should have one canonical response per questionnaire",
  );
  database.prepare(`
    INSERT INTO questionnaire_responses (
      id, questionnaire_id, project_id, client_id, answers_json, created_at, updated_at
    ) VALUES (
      'questionnaire-response-project-level', 'questionnaire-1', 'project-1', NULL,
      '[]', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO questionnaire_responses (
        id, questionnaire_id, project_id, client_id, answers_json, created_at, updated_at
      ) VALUES (
        'questionnaire-response-project-level-duplicate', 'questionnaire-1', 'project-1', NULL,
        '[]', ?, ?
      )
    `).run(now, now),
    /UNIQUE constraint failed/,
    "a project-level questionnaire response without a client should also be canonical",
  );

  assert.throws(
    () => database.prepare(`
      INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
      VALUES ('participant-duplicate', 'project-1', 'client-1', 'primary', 1, ?)
    `).run(now),
    /UNIQUE constraint failed/,
    "a client should only have one canonical participant row per project",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
      VALUES ('participant-primary-duplicate', 'project-1', 'client-2', 'primary', 1, ?)
    `).run(now),
    /UNIQUE constraint failed/,
    "a project should only have one canonical primary contact",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
      VALUES ('participant-primary-role-drift', 'project-1', 'client-2', 'primary', 0, ?)
    `).run(now),
    /primary participant role requires primary-contact flag/,
    "a non-primary participant row should not carry the reserved primary role",
  );
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-2', 'project-1', 'client-2', 'partner', 0, ?)
  `).run(now);
  assert.throws(
    () => database.prepare(`
      UPDATE project_participants
      SET role = 'primary'
      WHERE id = 'participant-2'
    `).run(),
    /primary participant role requires primary-contact flag/,
    "a non-primary participant row should not be updated to the reserved primary role",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_participants
      SET role = ' partner '
      WHERE id = 'participant-2'
    `).run(),
    /project participant role must be trimmed non-empty text/,
    "direct participant updates should not create padded roles",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_participants
      SET role = ''
      WHERE id = 'participant-2'
    `).run(),
    /project participant role must be trimmed non-empty text/,
    "direct participant updates should not create blank roles",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_participants
      SET is_primary_contact = -1
      WHERE id = 'participant-2'
    `).run(),
    /project participant primary flag must be canonical/,
    "direct participant updates should not create non-boolean primary flags",
  );

  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, source_type, source_id, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'discovery_call', 'Canon discovery call',
      'Canon source body.', 'call_transcript', 'call-canon-1', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_sources (
        id, project_id, kind, title, body, created_at, updated_at
      ) VALUES (
        'source-blank-kind', 'project-1', '', 'Blank kind source',
        'Blank kind body.', ?, ?
      )
    `).run(now, now),
    /project source kind must be trimmed non-empty text/,
    "direct project source inserts should not create blank kinds",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_sources (
        id, project_id, kind, title, body, created_at, updated_at
      ) VALUES (
        'source-padded-title', 'project-1', 'note', ' Padded source title ',
        'Padded title body.', ?, ?
      )
    `).run(now, now),
    /project source title must be trimmed non-empty text/,
    "direct project source inserts should not create padded titles",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_sources (
        id, project_id, kind, title, body, created_at, updated_at
      ) VALUES (
        'source-blank-body', 'project-1', 'note', 'Blank body source',
        '   ', ?, ?
      )
    `).run(now, now),
    /project source body must be trimmed non-empty text/,
    "direct project source inserts should not create blank bodies",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_sources
      SET title = ' Canon discovery call '
      WHERE id = 'source-1'
    `).run(),
    /project source title must be trimmed non-empty text/,
    "direct project source updates should not create padded titles",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_sources (
        id, project_id, kind, title, body, summary, created_at, updated_at
      ) VALUES (
        'source-blank-summary', 'project-1', 'note', 'Blank summary source',
        'Blank summary body.', '', ?, ?
      )
    `).run(now, now),
    /project source detail text must be null or trimmed non-empty text/,
    "direct project source inserts should not create empty optional text",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_sources (
        id, project_id, kind, title, body, external_url, created_at, updated_at
      ) VALUES (
        'source-padded-url', 'project-1', 'note', 'Padded URL source',
        'Padded URL body.', ' https://example.com/source ', ?, ?
      )
    `).run(now, now),
    /project source detail text must be null or trimmed non-empty text/,
    "direct project source inserts should not create padded optional text",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_sources
      SET captured_by = ' Agent '
      WHERE id = 'source-1'
    `).run(),
    /project source detail text must be null or trimmed non-empty text/,
    "direct project source updates should not create padded optional text",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_sources (
        id, project_id, kind, title, body, source_type, source_id, created_at, updated_at
      ) VALUES (
        'source-padded-upstream', 'project-1', 'note', 'Padded upstream source',
        'Padded upstream body.', ' call_transcript ', 'call-padded', ?, ?
      )
    `).run(now, now),
    /project source detail text must be null or trimmed non-empty text/,
    "direct project source inserts should not create padded upstream source labels",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_sources (
        id, project_id, kind, title, body, metadata_json, created_at, updated_at
      ) VALUES (
        'source-invalid-metadata', 'project-1', 'note', 'Invalid metadata source',
        'Invalid metadata body.', 'not-json', ?, ?
      )
    `).run(now, now),
    /project source metadata must be null or canonical json text/,
    "direct project source inserts should not create malformed metadata json",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_sources
      SET metadata_json = ' {"durationMinutes":43} '
      WHERE id = 'source-1'
    `).run(),
    /project source metadata must be null or canonical json text/,
    "direct project source updates should not create padded metadata json",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_sources (
        id, project_id, kind, title, body, source_type, source_id, created_at, updated_at
      ) VALUES (
        'source-duplicate', 'project-1', 'discovery_call', 'Duplicate discovery call',
        'Duplicate source body.', 'call_transcript', 'call-canon-1', ?, ?
      )
    `).run(now, now),
    /UNIQUE constraint failed/,
    "a project should only have one canonical row for a given upstream source",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_sources (
        id, project_id, kind, title, body, source_id, created_at, updated_at
      ) VALUES (
        'source-half-link-insert', 'project-1', 'discovery_call',
        'Half-linked source', 'Half-linked source body.', 'call-half-link', ?, ?
      )
    `).run(now, now),
    /project source identity requires sourceType when sourceId is set/,
    "project source upstream ids should not be stored without a source type",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_sources
      SET source_type = NULL, source_id = 'call-canon-1'
      WHERE id = 'source-1'
    `).run(),
    /project source identity requires sourceType when sourceId is set/,
    "project source identity updates should not create half-linked upstream ids",
  );
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-2', 'Other Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, source_type, source_id, created_at, updated_at
    ) VALUES (
      'source-other', 'project-2', 'discovery_call', 'Other discovery call',
      'Other source body.', 'call_transcript', 'call-canon-other', ?, ?
    )
  `).run(now, now);

  database.prepare(`
    INSERT INTO project_events (
      id, project_id, type, title, event_date, source_type, source_id, created_at, updated_at
    ) VALUES (
      'event-1', 'project-1', 'rehearsal', 'Canon rehearsal dinner',
      '2026-06-19', 'project_source', 'source-1', ?, ?
    )
  `).run(now, now);
  assert.deepEqual(database.prepare(`
    SELECT source_type, source_id
    FROM project_events
    WHERE id = 'event-1'
  `).get(), {
    source_type: "project_source",
    source_id: "source-1",
  });
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_events (
        id, project_id, type, title, event_date, source_id, created_at, updated_at
      ) VALUES (
        'event-half-source-insert', 'project-1', 'rehearsal', 'Half-linked event',
        '2026-06-18', 'source-1', ?, ?
      )
    `).run(now, now),
    /project event source links require sourceType when sourceId is set/,
    "project event source ids should not be stored without a source type",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_events
      SET source_type = NULL, source_id = 'source-1'
      WHERE id = 'event-1'
    `).run(),
    /project event source links require sourceType when sourceId is set/,
    "project event source updates should not create half-linked source ids",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_events (
        id, project_id, type, title, event_date, source_type, source_id, created_at, updated_at
      ) VALUES (
        'event-wrong-project-source-insert', 'project-1', 'rehearsal', 'Wrong project source event',
        '2026-06-18', 'project_source', 'source-other', ?, ?
      )
    `).run(now, now),
    /project event project_source links must point to a source in the same project/,
    "project event project_source inserts should not point to another project's source row",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_events
      SET source_type = 'project_source', source_id = 'source-other'
      WHERE id = 'event-1'
    `).run(),
    /project event project_source links must point to a source in the same project/,
    "project event project_source updates should not point to another project's source row",
  );

  database.prepare(`
    INSERT INTO project_timeline_items (
      id, project_id, title, sort_order, source_type, source_id, created_by, created_at, updated_at
    ) VALUES (
      'timeline-1', 'project-1', 'Canon timeline item', 0, 'project_source', 'source-1',
      'agent', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_timeline_items (
        id, project_id, title, sort_order, source_id, created_by, created_at, updated_at
      ) VALUES (
        'timeline-half-source-insert', 'project-1', 'Half-linked timeline item', 1, 'source-1',
        'agent', ?, ?
      )
    `).run(now, now),
    /project timeline source links require sourceType when sourceId is set/,
    "project timeline source ids should not be stored without a source type",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_timeline_items
      SET source_type = NULL, source_id = 'source-1'
      WHERE id = 'timeline-1'
    `).run(),
    /project timeline source links require sourceType when sourceId is set/,
    "project timeline source updates should not create half-linked source ids",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_timeline_items (
        id, project_id, title, sort_order, source_type, source_id, created_by, created_at, updated_at
      ) VALUES (
        'timeline-wrong-project-source-insert', 'project-1', 'Wrong project source timeline item',
        2, 'project_source', 'source-other', 'agent', ?, ?
      )
    `).run(now, now),
    /project timeline project_source links must point to a source in the same project/,
    "project timeline project_source inserts should not point to another project's source row",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_timeline_items
      SET source_type = 'project_source', source_id = 'source-other'
      WHERE id = 'timeline-1'
    `).run(),
    /project timeline project_source links must point to a source in the same project/,
    "project timeline project_source updates should not point to another project's source row",
  );

  database.prepare(`
    INSERT INTO project_communications (
      id, project_id, direction, channel, status, subject, body, source_type, source_id,
      created_by, created_at, updated_at
    ) VALUES (
      'communication-1', 'project-1', 'outbound', 'email', 'draft', 'Canon communication',
      'Canon communication body.', 'project_source', 'source-1', 'agent', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_communications (
        id, project_id, direction, channel, status, subject, body,
        created_by, created_at, updated_at
      ) VALUES (
        'communication-invalid-direction', 'project-1', 'sideways', 'email', 'draft',
        'Invalid direction communication', 'Invalid direction body.',
        'agent', ?, ?
      )
    `).run(now, now),
    /project communication direction must be canonical/,
    "direct communication inserts should not create invalid directions",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_communications (
        id, project_id, direction, channel, status, subject, body,
        created_by, created_at, updated_at
      ) VALUES (
        'communication-invalid-channel', 'project-1', 'outbound', 'fax', 'draft',
        'Invalid channel communication', 'Invalid channel body.',
        'agent', ?, ?
      )
    `).run(now, now),
    /project communication channel must be canonical/,
    "direct communication inserts should not create invalid channels",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_communications (
        id, project_id, direction, channel, status, subject, body,
        created_by, created_at, updated_at
      ) VALUES (
        'communication-invalid-status', 'project-1', 'outbound', 'email', 'done',
        'Invalid status communication', 'Invalid status body.',
        'agent', ?, ?
      )
    `).run(now, now),
    /project communication status must be canonical/,
    "direct communication inserts should not create invalid statuses",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_communications (
        id, project_id, direction, channel, status, subject, body,
        created_by, created_at, updated_at
      ) VALUES (
        'communication-blank-body', 'project-1', 'outbound', 'email', 'draft',
        'Blank body communication', '   ', 'agent', ?, ?
      )
    `).run(now, now),
    /project communication body must be trimmed non-empty text/,
    "direct communication inserts should not create blank bodies",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_communications
      SET body = ' Canon communication body. '
      WHERE id = 'communication-1'
    `).run(),
    /project communication body must be trimmed non-empty text/,
    "direct communication updates should not create padded bodies",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_communications (
        id, project_id, direction, channel, status, subject, body,
        created_by, created_at, updated_at
      ) VALUES (
        'communication-padded-subject', 'project-1', 'outbound', 'email', 'draft',
        ' Padded subject ', 'Padded subject body.', 'agent', ?, ?
      )
    `).run(now, now),
    /project communication detail text must be null or trimmed non-empty text/,
    "direct communication inserts should not create padded optional text",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_communications (
        id, project_id, direction, channel, status, subject, body, recipient_email,
        created_by, created_at, updated_at
      ) VALUES (
        'communication-uppercase-email', 'project-1', 'outbound', 'email', 'draft',
        'Uppercase recipient email', 'Uppercase recipient email body.', 'ALEX@EXAMPLE.COM',
        'agent', ?, ?
      )
    `).run(now, now),
    /project communication recipient email must be lowercase and trimmed/,
    "direct communication inserts should not create uppercase recipient emails",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_communications
      SET source_type = ' project_source '
      WHERE id = 'communication-1'
    `).run(),
    /project communication detail text must be null or trimmed non-empty text/,
    "direct communication updates should not create padded source labels",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_communications (
        id, project_id, direction, channel, status, subject, body, source_id,
        created_by, created_at, updated_at
      ) VALUES (
        'communication-half-source-insert', 'project-1', 'outbound', 'email', 'draft',
        'Half-linked communication', 'Half-linked communication body.', 'source-1',
        'agent', ?, ?
      )
    `).run(now, now),
    /project communication source links require sourceType when sourceId is set/,
    "project communication source ids should not be stored without a source type",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_communications
      SET source_type = NULL, source_id = 'source-1'
      WHERE id = 'communication-1'
    `).run(),
    /project communication source links require sourceType when sourceId is set/,
    "project communication source updates should not create half-linked source ids",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO project_communications (
        id, project_id, direction, channel, status, subject, body, source_type, source_id,
        created_by, created_at, updated_at
      ) VALUES (
        'communication-wrong-project-source-insert', 'project-1', 'outbound', 'email', 'draft',
        'Wrong project source communication', 'Wrong project source body.',
        'project_source', 'source-other', 'agent', ?, ?
      )
    `).run(now, now),
    /project communication project_source links must point to a source in the same project/,
    "project communication project_source inserts should not point to another project's source row",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE project_communications
      SET source_type = 'project_source', source_id = 'source-other'
      WHERE id = 'communication-1'
    `).run(),
    /project communication project_source links must point to a source in the same project/,
    "project communication project_source updates should not point to another project's source row",
  );

  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, package_name, total_cents, contract_status,
      invoice_status, source_type, source_id, created_at, updated_at
    ) VALUES (
      'proposal-1', 'project-1', 'Canon Source Proposal', 'draft', 'Canon Package',
      500000, 'ready', 'not_created', 'project_source', 'source-1', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO proposals (
        id, project_id, title, status, total_cents, contract_status, invoice_status, created_at, updated_at
      ) VALUES (
        'proposal-blank-title', 'project-1', '', 'draft', 100000, 'ready', 'not_created', ?, ?
      )
    `).run(now, now),
    /proposal title must be trimmed non-empty text/,
    "direct proposal inserts should not create blank titles",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO proposals (
        id, project_id, title, status, total_cents, contract_status, invoice_status, created_at, updated_at
      ) VALUES (
        'proposal-invalid-status', 'project-1', 'Invalid status proposal', 'maybe',
        100000, 'ready', 'not_created', ?, ?
      )
    `).run(now, now),
    /proposal status must be canonical/,
    "direct proposal inserts should not create invalid statuses",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO proposals (
        id, project_id, title, status, total_cents, contract_status, invoice_status, created_at, updated_at
      ) VALUES (
        'proposal-invalid-contract-status', 'project-1', 'Invalid contract proposal', 'draft',
        100000, 'done', 'not_created', ?, ?
      )
    `).run(now, now),
    /proposal contract status must be canonical/,
    "direct proposal inserts should not create invalid contract statuses",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO proposals (
        id, project_id, title, status, total_cents, contract_status, invoice_status, created_at, updated_at
      ) VALUES (
        'proposal-invalid-invoice-status', 'project-1', 'Invalid invoice proposal', 'draft',
        100000, 'ready', 'paid', ?, ?
      )
    `).run(now, now),
    /proposal invoice status must be canonical/,
    "direct proposal inserts should not create invalid invoice statuses",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE proposals
      SET title = ' Canon Source Proposal '
      WHERE id = 'proposal-1'
    `).run(),
    /proposal title must be trimmed non-empty text/,
    "direct proposal updates should not create padded titles",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE proposals
      SET total_cents = -1
      WHERE id = 'proposal-1'
    `).run(),
    /proposal totals must be canonical non-negative integers/,
    "direct proposal updates should not create negative totals",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE proposals
      SET package_name = ''
      WHERE id = 'proposal-1'
    `).run(),
    /proposal detail text must be null or trimmed non-empty text/,
    "direct proposal updates should not create blank optional text",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE proposals
      SET signer_email = 'ALEX@EXAMPLE.COM'
      WHERE id = 'proposal-1'
    `).run(),
    /proposal signer email must be lowercase and trimmed/,
    "direct proposal updates should not create uppercase signer emails",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE proposals
      SET selected_optional_line_item_ids_json = '{"line":true}'
      WHERE id = 'proposal-1'
    `).run(),
    /proposal selected options must be null or canonical json array text/,
    "direct proposal updates should not create object-shaped selected option json",
  );
  database.prepare(`
    INSERT INTO proposal_line_items (
      id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at
    ) VALUES (
      'proposal-line-1', 'proposal-1', 'Canon coverage', 1, 500000, 0, 0, ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO proposal_line_items (
        id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at
      ) VALUES (
        'proposal-line-blank-name', 'proposal-1', '', 1, 100000, 0, 1, ?, ?
      )
    `).run(now, now),
    /proposal line item name must be trimmed non-empty text/,
    "direct proposal line item inserts should not create blank names",
  );
  database.prepare(`
    INSERT INTO proposal_access_tokens (
      id, proposal_id, project_id, client_id, token_hash, label, expires_at, sent_at, created_at
    ) VALUES (
      'proposal-token-1', 'proposal-1', 'project-1', 'client-1',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'Client proposal package', '2026-07-13T12:00:00.000Z', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO proposal_access_tokens (
        id, proposal_id, project_id, client_id, token_hash, expires_at, created_at
      ) VALUES (
        'proposal-token-padded-hash', 'proposal-1', 'project-1', 'client-1',
        ' 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ',
        '2026-07-13T12:00:00.000Z', ?
      )
    `).run(now),
    /proposal access token hash must be canonical sha256 hex text/,
    "proposal token hashes should stay canonical for client link lookup",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE proposal_access_tokens
      SET label = '  '
      WHERE id = 'proposal-token-1'
    `).run(),
    /proposal access token detail text must be null or trimmed non-empty text/,
    "proposal token optional detail text should not drift into whitespace",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO proposal_access_tokens (
        id, proposal_id, project_id, token_hash, expires_at, created_at
      ) VALUES (
        'proposal-token-wrong-project', 'proposal-1', 'project-2',
        '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        '2026-07-13T12:00:00.000Z', ?
      )
    `).run(now),
    /proposal access token project must match proposal project/,
    "proposal tokens should not be attachable to a different project than the proposal",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO proposal_access_tokens (
        id, proposal_id, project_id, client_id, token_hash, expires_at, created_at
      ) VALUES (
        'proposal-token-unlinked-client', 'proposal-1', 'project-1', 'client-3',
        '2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        '2026-07-13T12:00:00.000Z', ?
      )
    `).run(now),
    /proposal access token client must belong to token project/,
    "proposal tokens should only target clients linked to the token project",
  );

  database.prepare(`
    INSERT INTO portal_access_tokens (
      id, project_id, client_id, token_hash, label, expires_at, created_at
    ) VALUES (
      'portal-token-1', 'project-1', 'client-1',
      '3123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'Client portal link', '2026-07-13T12:00:00.000Z', ?
    )
  `).run(now);
  assert.throws(
    () => database.prepare(`
      UPDATE portal_access_tokens
      SET token_hash = 'not-a-sha'
      WHERE id = 'portal-token-1'
    `).run(),
    /portal access token hash must be canonical sha256 hex text/,
    "portal token hashes should stay canonical for portal lookup",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE portal_access_tokens
      SET last_used_ip = ''
      WHERE id = 'portal-token-1'
    `).run(),
    /portal access token detail text must be null or trimmed non-empty text/,
    "portal token optional detail text should not drift into whitespace",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO portal_access_tokens (
        id, project_id, client_id, token_hash, expires_at, created_at
      ) VALUES (
        'portal-token-unlinked-client', 'project-1', 'client-3',
        '4123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        '2026-07-13T12:00:00.000Z', ?
      )
    `).run(now),
    /portal access token client must belong to token project/,
    "portal tokens should only target clients linked to the token project",
  );

  // Phase 6.5: kind + consumed_at canon guards on the recreated detail-text
  // triggers (migration 0084). A valid magic_request row must pass.
  database.prepare(`
    INSERT INTO portal_access_tokens (
      id, project_id, client_id, token_hash, label, kind, request_batch_id, expires_at, created_at
    ) VALUES (
      'portal-magic-1', 'project-1', 'client-1',
      '5123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'Self-service magic link', 'magic_request', 'batch-1', '2026-07-13T12:00:00.000Z', ?
    )
  `).run(now);
  assert.deepEqual(
    database.prepare("SELECT kind FROM portal_access_tokens WHERE id = 'portal-magic-1'").get(),
    { kind: "magic_request" },
    "a valid magic_request token should insert cleanly",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO portal_access_tokens (
        id, project_id, client_id, token_hash, kind, expires_at, created_at
      ) VALUES (
        'portal-bad-kind', 'project-1', 'client-1',
        '6123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        'not_a_kind', '2026-07-13T12:00:00.000Z', ?
      )
    `).run(now),
    /kind must be canonical/,
    "portal token kind must be one of session|magic_request",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO portal_access_tokens (
        id, project_id, client_id, token_hash, kind, consumed_at, expires_at, created_at
      ) VALUES (
        'portal-blank-consumed', 'project-1', 'client-1',
        '7123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        'magic_request', '   ', '2026-07-13T12:00:00.000Z', ?
      )
    `).run(now),
    /portal access token detail text must be null or trimmed non-empty text/,
    "portal token consumed_at must be null or trimmed non-empty text on insert",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE portal_access_tokens
      SET consumed_at = ' 2026-07-13T12:00:00.000Z '
      WHERE id = 'portal-magic-1'
    `).run(),
    /portal access token detail text must be null or trimmed non-empty text/,
    "portal token consumed_at must be trimmed on update (guard fires on UPDATE OF consumed_at)",
  );
  // A clean single-use claim (the atomic path) must pass the recreated guard.
  database.prepare(`
    UPDATE portal_access_tokens
    SET consumed_at = '2026-07-05T12:00:00.000Z'
    WHERE id = 'portal-magic-1'
  `).run();
  assert.deepEqual(
    database.prepare("SELECT consumed_at FROM portal_access_tokens WHERE id = 'portal-magic-1'").get(),
    { consumed_at: "2026-07-05T12:00:00.000Z" },
    "a trimmed consumed_at update should be accepted",
  );

  database.prepare(`
    INSERT INTO activity_logs (
      id, project_id, client_id, action, actor_type, actor_name, metadata, created_at
    ) VALUES (
      'activity-1', 'project-1', 'client-1', 'project.updated', 'admin', 'Tyler',
      '{"changedFields":["stage"]}', ?
    )
  `).run(now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO activity_logs (
        id, project_id, action, actor_type, actor_name, created_at
      ) VALUES (
        'activity-blank-action', 'project-1', '', 'admin', 'Tyler', ?
      )
    `).run(now),
    /activity log action must be trimmed non-empty text/,
    "activity logs should not allow blank audit actions",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE activity_logs
      SET actor_type = 'robot'
      WHERE id = 'activity-1'
    `).run(),
    /activity log actor type must be canonical/,
    "activity log actor types should remain one of the Studio actor kinds",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE activity_logs
      SET actor_name = '  '
      WHERE id = 'activity-1'
    `).run(),
    /activity log detail text must be null or trimmed non-empty text/,
    "activity log actor names should not drift into whitespace",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE activity_logs
      SET metadata = '[]'
      WHERE id = 'activity-1'
    `).run(),
    /activity log metadata must be null or canonical json object text/,
    "activity log metadata should remain object-shaped for audit readers and agents",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO proposal_line_items (
        id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at
      ) VALUES (
        'proposal-line-invalid-quantity', 'proposal-1', 'Invalid quantity', 0, 100000, 0, 1, ?, ?
      )
    `).run(now, now),
    /proposal line item quantity must be canonical/,
    "direct proposal line item inserts should not create zero quantities",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE proposal_line_items
      SET is_optional = 2
      WHERE id = 'proposal-line-1'
    `).run(),
    /proposal line item optional flag must be canonical/,
    "direct proposal line item updates should not create non-boolean optional flags",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO proposals (
        id, project_id, title, status, package_name, total_cents, contract_status,
        invoice_status, source_id, created_at, updated_at
      ) VALUES (
        'proposal-half-source-insert', 'project-1', 'Half-linked proposal', 'draft',
        'Half Package', 100000, 'ready', 'not_created', 'source-1', ?, ?
      )
    `).run(now, now),
    /proposal source links require sourceType when sourceId is set/,
    "proposal source ids should not be stored without a source type",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE proposals
      SET source_type = NULL, source_id = 'source-1'
      WHERE id = 'proposal-1'
    `).run(),
    /proposal source links require sourceType when sourceId is set/,
    "proposal source updates should not create half-linked source ids",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO proposals (
        id, project_id, title, status, package_name, total_cents, contract_status,
        invoice_status, source_type, source_id, created_at, updated_at
      ) VALUES (
        'proposal-wrong-project-source-insert', 'project-1', 'Wrong project source proposal',
        'draft', 'Wrong Package', 100000, 'ready', 'not_created',
        'project_source', 'source-other', ?, ?
      )
    `).run(now, now),
    /proposal project_source links must point to a source in the same project/,
    "proposal project_source inserts should not point to another project's source row",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE proposals
      SET source_type = 'project_source', source_id = 'source-other'
      WHERE id = 'proposal-1'
    `).run(),
    /proposal project_source links must point to a source in the same project/,
    "proposal project_source updates should not point to another project's source row",
  );

  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      source_type, source_id, created_at, updated_at
    ) VALUES (
      'invoice-source-1', 'project-1', 'INV-SOURCE-CANON', 'draft', 100000, 0,
      'project_source', 'source-1', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO invoices (
        id, project_id, invoice_number, status, total_cents, amount_paid_cents,
        source_id, created_at, updated_at
      ) VALUES (
        'invoice-half-source-insert', 'project-1', 'INV-HALF-SOURCE', 'draft',
        100000, 0, 'source-1', ?, ?
      )
    `).run(now, now),
    /invoice source links require sourceType when sourceId is set/,
    "invoice source ids should not be stored without a source type",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE invoices
      SET source_type = NULL, source_id = 'source-1'
      WHERE id = 'invoice-source-1'
    `).run(),
    /invoice source links require sourceType when sourceId is set/,
    "invoice source updates should not create half-linked source ids",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO invoices (
        id, project_id, invoice_number, status, total_cents, amount_paid_cents,
        source_type, source_id, created_at, updated_at
      ) VALUES (
        'invoice-wrong-project-source-insert', 'project-1', 'INV-WRONG-SOURCE', 'draft',
        100000, 0, 'project_source', 'source-other', ?, ?
      )
    `).run(now, now),
    /invoice project_source links must point to a source in the same project/,
    "invoice project_source inserts should not point to another project's source row",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE invoices
      SET source_type = 'project_source', source_id = 'source-other'
      WHERE id = 'invoice-source-1'
    `).run(),
    /invoice project_source links must point to a source in the same project/,
    "invoice project_source updates should not point to another project's source row",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO invoices (
        id, project_id, invoice_number, status, total_cents, amount_paid_cents,
        created_at, updated_at
      ) VALUES (
        'invoice-padded-number', 'project-1', ' INV-PADDED ', 'draft', 100000, 0, ?, ?
      )
    `).run(now, now),
    /invoice number must be trimmed non-empty text/,
    "invoice numbers should not be padded by direct imports",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO invoices (
        id, project_id, invoice_number, status, total_cents, amount_paid_cents,
        created_at, updated_at
      ) VALUES (
        'invoice-invalid-status', 'project-1', 'INV-INVALID-STATUS', 'collected', 100000, 0, ?, ?
      )
    `).run(now, now),
    /invoice status must be canonical/,
    "invoice statuses should remain in the Studio workflow vocabulary",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO invoices (
        id, project_id, invoice_number, status, total_cents, amount_paid_cents,
        card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
        created_at, updated_at
      ) VALUES (
        'invoice-invalid-fee-policy', 'project-1', 'INV-INVALID-FEE-POLICY', 'draft',
        100000, 0, 'client', 290, 30, 2930, ?, ?
      )
    `).run(now, now),
    /invoice card fee policy must be canonical/,
    "invoice fee policies should not drift away from client_pays or studio_absorbs",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO invoices (
        id, project_id, invoice_number, status, total_cents, amount_paid_cents,
        accepted_payment_methods_json, created_at, updated_at
      ) VALUES (
        'invoice-invalid-methods', 'project-1', 'INV-INVALID-METHODS', 'draft',
        100000, 0, '{"stripe":true}', ?, ?
      )
    `).run(now, now),
    /invoice accepted payment methods must be null or canonical json array text/,
    "accepted payment methods should remain canonical JSON array text",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE invoices
      SET payment_notes = '  '
      WHERE id = 'invoice-source-1'
    `).run(),
    /invoice detail text must be null or trimmed non-empty text/,
    "invoice optional detail text should not drift into whitespace",
  );

  database.prepare(`
    INSERT INTO agent_tasks (
      id, project_id, title, status, priority, assigned_agent, source_type, source_id, created_at, updated_at
    ) VALUES (
      'task-1', 'project-1', 'Create proposal from discovery call', 'queued', 'normal',
      'The Reeses Studio Agent', 'project_source', 'source-1', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO agent_tasks (
        id, project_id, title, status, priority, assigned_agent, created_at, updated_at
      ) VALUES (
        'task-padded-title', 'project-1', ' Create timeline ', 'queued', 'normal',
        'The Reeses Studio Agent', ?, ?
      )
    `).run(now, now),
    /agent task title must be trimmed non-empty text/,
    "direct agent task inserts should not create padded titles",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE agent_tasks
      SET status = 'ready'
      WHERE id = 'task-1'
    `).run(),
    /agent task status must be canonical/,
    "agent task status should remain one of the platform lifecycle states",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE agent_tasks
      SET priority = 'critical'
      WHERE id = 'task-1'
    `).run(),
    /agent task priority must be canonical/,
    "agent task priority should remain one of the studio priority levels",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE agent_tasks
      SET assigned_agent = '  '
      WHERE id = 'task-1'
    `).run(),
    /agent task detail text must be null or trimmed non-empty text/,
    "agent task optional detail text should not drift into whitespace",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE agent_tasks
      SET output_json = '[]'
      WHERE id = 'task-1'
    `).run(),
    /agent task output must be null or canonical json object text/,
    "agent task output payloads should stay canonical JSON object text for MCP/API clients",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO agent_tasks (
        id, project_id, title, status, priority, assigned_agent, created_at, updated_at
      ) VALUES (
        'task-terminal-without-completion', 'project-1', 'Terminal task without completion',
        'completed', 'normal', 'The Reeses Studio Agent', ?, ?
      )
    `).run(now, now),
    /agent task terminal statuses require completedAt/,
    "terminal agent task inserts should include a completion timestamp for accountability",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE agent_tasks
      SET status = 'failed'
      WHERE id = 'task-1'
    `).run(),
    /agent task terminal statuses require completedAt/,
    "terminal agent task updates should include a completion timestamp for accountability",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO agent_tasks (
        id, project_id, title, status, priority, assigned_agent, source_type, source_id, created_at, updated_at
      ) VALUES (
        'task-duplicate', 'project-1', 'Create proposal from discovery call', 'in_progress', 'normal',
        'The Reeses Studio Agent', 'project_source', 'source-1', ?, ?
      )
    `).run(now, now),
    /UNIQUE constraint failed/,
    "active duplicate agent tasks should be blocked for the same project, source, and title",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO agent_tasks (
        id, project_id, title, status, priority, assigned_agent, source_id, created_at, updated_at
      ) VALUES (
        'task-half-source-insert', 'project-1', 'Half-linked source task', 'queued', 'normal',
        'The Reeses Studio Agent', 'source-1', ?, ?
      )
    `).run(now, now),
    /agent task source links require sourceType when sourceId is set/,
    "agent task source ids should not be stored without a source type",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE agent_tasks
      SET source_type = NULL, source_id = 'source-1'
      WHERE id = 'task-1'
    `).run(),
    /agent task source links require sourceType when sourceId is set/,
    "agent task source updates should not create half-linked source ids",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO agent_tasks (
        id, project_id, title, status, priority, assigned_agent, source_type, source_id, created_at, updated_at
      ) VALUES (
        'task-wrong-project-source-insert', 'project-1', 'Wrong project source task', 'queued', 'normal',
        'The Reeses Studio Agent', 'project_source', 'source-other', ?, ?
      )
    `).run(now, now),
    /agent task project_source links must point to a source in the same project/,
    "agent task project_source inserts should not point to another project's source row",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE agent_tasks
      SET source_type = 'project_source', source_id = 'source-other'
      WHERE id = 'task-1'
    `).run(),
    /agent task project_source links must point to a source in the same project/,
    "agent task project_source updates should not point to another project's source row",
  );
  database.prepare(`
    INSERT INTO agent_tasks (
      id, project_id, title, status, priority, assigned_agent, source_type, source_id, completed_at, created_at, updated_at
    ) VALUES (
      'task-completed-history', 'project-1', 'Create proposal from discovery call', 'completed', 'normal',
      'The Reeses Studio Agent', 'project_source', 'source-1', ?, ?, ?
    )
  `).run(now, now, now);

  database.prepare(`
    INSERT INTO proposals (
      id, project_id, title, status, package_name, total_cents, contract_status,
      invoice_status, created_at, updated_at
    ) VALUES (
      'proposal-signed', 'project-1', 'Signed Canon Proposal', 'draft', 'Heritage Day',
      900000, 'ready', 'created', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO proposal_line_items (
      id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at
    ) VALUES (
      'signed-line-1', 'proposal-signed', 'Signed coverage', 1, 900000, 0, 0, ?, ?
    )
  `).run(now, now);
  database.prepare(`
    UPDATE proposals
    SET status = 'accepted', contract_status = 'signed', accepted_at = ?, signed_at = ?, updated_at = ?
    WHERE id = 'proposal-signed'
  `).run(now, now, now);
  assert.throws(
    () => database.prepare(`
      UPDATE proposals
      SET total_cents = 950000
      WHERE id = 'proposal-signed'
    `).run(),
    /signed proposal package is immutable/,
    "signed proposal totals should not be editable through direct writes",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE proposals
      SET status = 'draft'
      WHERE id = 'proposal-signed'
    `).run(),
    /signed proposal package is immutable/,
    "signed proposal status should not be rewound through direct writes",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE proposal_line_items
      SET unit_price_cents = 950000
      WHERE id = 'signed-line-1'
    `).run(),
    /signed proposal line items are immutable/,
    "signed proposal line item prices should not be editable through direct writes",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO proposal_line_items (
        id, proposal_id, name, quantity, unit_price_cents, is_optional, sort_order, created_at, updated_at
      ) VALUES (
        'signed-line-extra', 'proposal-signed', 'Late add-on', 1, 50000, 1, 1, ?, ?
      )
    `).run(now, now),
    /signed proposal line items are immutable/,
    "signed proposal line items should not allow late inserts",
  );

  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents, created_at, updated_at
    ) VALUES ('invoice-1', 'project-1', 'INV-CANON-1', 'sent', 100000, 0, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, status, paid_amount_cents, external_payment_id, created_at, updated_at
    ) VALUES ('payment-1', 'invoice-1', 'Retainer', 50000, 'paid', 50000, 'pi_unique_canon', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, status, source_type, source_id, created_at, updated_at
    ) VALUES (
      'payment-source-1', 'invoice-1', 'Source-linked payment', 10000, 'pending',
      'project_source', 'source-1', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO invoice_payments (
        id, invoice_id, label, amount_cents, status, source_id, created_at, updated_at
      ) VALUES (
        'payment-half-source-insert', 'invoice-1', 'Half-linked payment', 10000,
        'pending', 'source-1', ?, ?
      )
    `).run(now, now),
    /invoice payment source links require sourceType when sourceId is set/,
    "invoice payment source ids should not be stored without a source type",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE invoice_payments
      SET source_type = NULL, source_id = 'source-1'
      WHERE id = 'payment-source-1'
    `).run(),
    /invoice payment source links require sourceType when sourceId is set/,
    "invoice payment source updates should not create half-linked source ids",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO invoice_payments (
        id, invoice_id, label, amount_cents, status, source_type, source_id, created_at, updated_at
      ) VALUES (
        'payment-wrong-project-source-insert', 'invoice-1', 'Wrong project source payment',
        10000, 'pending', 'project_source', 'source-other', ?, ?
      )
    `).run(now, now),
    /invoice payment project_source links must point to a source in the invoice project/,
    "invoice payment project_source inserts should not point to another project's source row",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE invoice_payments
      SET source_type = 'project_source', source_id = 'source-other'
      WHERE id = 'payment-source-1'
    `).run(),
    /invoice payment project_source links must point to a source in the invoice project/,
    "invoice payment project_source updates should not point to another project's source row",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO invoice_payments (
        id, invoice_id, label, amount_cents, status, created_at, updated_at
      ) VALUES ('payment-padded-label', 'invoice-1', ' Retainer ', 10000, 'pending', ?, ?)
    `).run(now, now),
    /invoice payment label must be trimmed non-empty text/,
    "invoice payment labels should not be padded by direct imports",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO invoice_payments (
        id, invoice_id, label, amount_cents, status, created_at, updated_at
      ) VALUES ('payment-invalid-status', 'invoice-1', 'Invalid status payment', 10000, 'complete', ?, ?)
    `).run(now, now),
    /invoice payment status must be canonical/,
    "invoice payment statuses should remain in the Studio ledger vocabulary",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO invoice_payments (
        id, invoice_id, label, amount_cents, status,
        paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents,
        created_at, updated_at
      ) VALUES (
        'payment-negative-ledger', 'invoice-1', 'Negative ledger', 10000, 'pending',
        0, -1, 0, 0, 0, ?, ?
      )
    `).run(now, now),
    /invoice payment ledger amounts must be canonical non-negative integers/,
    "invoice payment ledger amounts should not be negative",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE invoice_payments
      SET payment_method = ' stripe '
      WHERE id = 'payment-source-1'
    `).run(),
    /invoice payment detail text must be null or trimmed non-empty text/,
    "invoice payment optional detail text should not be padded",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO invoice_payments (
        id, invoice_id, label, amount_cents, status, external_payment_id, created_at, updated_at
      ) VALUES ('payment-duplicate', 'invoice-1', 'Duplicate', 10000, 'paid', 'pi_unique_canon', ?, ?)
    `).run(now, now),
    /UNIQUE constraint failed/,
    "invoice payment external ids should not drift into duplicate ledger rows",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO invoice_payments (
        id, invoice_id, label, amount_cents, status, created_at, updated_at
      ) VALUES ('payment-over-total', 'invoice-1', 'Over total installment', 60000, 'pending', ?, ?)
    `).run(now, now),
    /invoice payment schedule exceeds invoice total/,
    "invoice payment schedule rows should not exceed their invoice total",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE invoice_payments
      SET amount_cents = 110000
      WHERE id = 'payment-1'
    `).run(),
    /invoice payment schedule exceeds invoice total/,
    "invoice payment schedule updates should not exceed their invoice total",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE invoice_payments
      SET paid_amount_cents = 60000
      WHERE id = 'payment-1'
    `).run(),
    /invoice payment paid amount exceeds scheduled amount/,
    "paid amount should not exceed the scheduled payment amount",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE invoices
      SET status = 'paid', amount_paid_cents = 50000
      WHERE id = 'invoice-1'
    `).run(),
    /invoice paid state does not match paid amount/,
    "paid invoice state should require the invoice total to be paid",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE invoices
      SET status = 'partially_paid', amount_paid_cents = 0
      WHERE id = 'invoice-1'
    `).run(),
    /invoice paid state does not match paid amount/,
    "partially paid invoice state should require a positive partial paid amount",
  );

  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, duration_minutes, buffer_minutes, created_at, updated_at
    ) VALUES ('meeting-1', 'canon-call', 'Canon Call', 30, 15, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, attendee_name, attendee_email,
      start_at, end_at, status, source, external_payment_id, created_at, updated_at
    ) VALUES (
      'booking-1', 'meeting-1', 'project-1', 'Alex', 'alex@example.com',
      '2026-06-01T14:00:00.000Z', '2026-06-01T14:30:00.000Z',
      'confirmed', 'booking_link', 'pi_booking_unique_canon', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, attendee_name, attendee_email,
      start_at, end_at, status, source, payment_source_type, payment_source_id, created_at, updated_at
    ) VALUES (
      'booking-source-1', 'meeting-1', 'project-1', 'Alex', 'alex@example.com',
      '2026-06-01T16:00:00.000Z', '2026-06-01T16:30:00.000Z',
      'confirmed', 'booking_link', 'project_source', 'source-1', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO scheduler_bookings (
        id, meeting_type_id, project_id, attendee_name, attendee_email,
        start_at, end_at, status, source, payment_source_id, created_at, updated_at
      ) VALUES (
        'booking-half-payment-source-insert', 'meeting-1', 'project-1', 'Alex', 'alex@example.com',
        '2026-06-01T17:00:00.000Z', '2026-06-01T17:30:00.000Z',
        'confirmed', 'booking_link', 'source-1', ?, ?
      )
    `).run(now, now),
    /scheduler booking payment source links require sourceType when sourceId is set/,
    "scheduler booking payment source ids should not be stored without a source type",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE scheduler_bookings
      SET payment_source_type = NULL, payment_source_id = 'source-1'
      WHERE id = 'booking-source-1'
    `).run(),
    /scheduler booking payment source links require sourceType when sourceId is set/,
    "scheduler booking payment source updates should not create half-linked source ids",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO scheduler_bookings (
        id, meeting_type_id, project_id, attendee_name, attendee_email,
        start_at, end_at, status, source, payment_source_type, payment_source_id, created_at, updated_at
      ) VALUES (
        'booking-wrong-project-payment-source-insert', 'meeting-1', 'project-1', 'Alex', 'alex@example.com',
        '2026-06-01T18:00:00.000Z', '2026-06-01T18:30:00.000Z',
        'confirmed', 'booking_link', 'project_source', 'source-other', ?, ?
      )
    `).run(now, now),
    /scheduler booking payment project_source links must point to a source in the same project/,
    "scheduler booking payment project_source inserts should not point to another project's source row",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE scheduler_bookings
      SET payment_source_type = 'project_source', payment_source_id = 'source-other'
      WHERE id = 'booking-source-1'
    `).run(),
    /scheduler booking payment project_source links must point to a source in the same project/,
    "scheduler booking payment project_source updates should not point to another project's source row",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO scheduler_bookings (
        id, meeting_type_id, project_id, attendee_name, attendee_email,
        start_at, end_at, status, source, created_at, updated_at
      ) VALUES (
        'booking-padded-name', 'meeting-1', 'project-1', ' Alex ', 'alex@example.com',
        '2026-06-01T19:00:00.000Z', '2026-06-01T19:30:00.000Z',
        'confirmed', 'booking_link', ?, ?
      )
    `).run(now, now),
    /scheduler booking attendee name must be trimmed non-empty text/,
    "scheduler booking attendee names should not be padded by direct imports",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO scheduler_bookings (
        id, meeting_type_id, project_id, attendee_name, attendee_email,
        start_at, end_at, status, source, created_at, updated_at
      ) VALUES (
        'booking-uppercase-email', 'meeting-1', 'project-1', 'Alex', 'Alex@Example.com',
        '2026-06-01T19:00:00.000Z', '2026-06-01T19:30:00.000Z',
        'confirmed', 'booking_link', ?, ?
      )
    `).run(now, now),
    /scheduler booking attendee email must be lowercase and trimmed/,
    "scheduler booking attendee emails should be lowercase canonical identity",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO scheduler_bookings (
        id, meeting_type_id, project_id, attendee_name, attendee_email,
        start_at, end_at, status, source, created_at, updated_at
      ) VALUES (
        'booking-invalid-status', 'meeting-1', 'project-1', 'Alex', 'alex@example.com',
        '2026-06-01T19:00:00.000Z', '2026-06-01T19:30:00.000Z',
        'pending', 'booking_link', ?, ?
      )
    `).run(now, now),
    /scheduler booking status must be canonical/,
    "scheduler booking statuses should remain in the Studio scheduler vocabulary",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO scheduler_bookings (
        id, meeting_type_id, project_id, attendee_name, attendee_email,
        invitee_answers_json, start_at, end_at, status, source, created_at, updated_at
      ) VALUES (
        'booking-invalid-answers', 'meeting-1', 'project-1', 'Alex', 'alex@example.com',
        '[]', '2026-06-01T19:00:00.000Z', '2026-06-01T19:30:00.000Z',
        'confirmed', 'booking_link', ?, ?
      )
    `).run(now, now),
    /scheduler booking invitee answers must be null or canonical json object text/,
    "scheduler booking invitee answers should remain JSON object text",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE scheduler_bookings
      SET attendee_phone = '  '
      WHERE id = 'booking-source-1'
    `).run(),
    /scheduler booking detail text must be null or trimmed non-empty text/,
    "scheduler booking optional detail text should not drift into whitespace",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE scheduler_bookings
      SET payment_status = 'complete'
      WHERE id = 'booking-source-1'
    `).run(),
    /scheduler booking payment status must be canonical/,
    "scheduler booking payment statuses should remain in the Studio ledger vocabulary",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE scheduler_bookings
      SET paid_amount_cents = -1
      WHERE id = 'booking-source-1'
    `).run(),
    /scheduler booking payment amounts must be canonical non-negative integers/,
    "scheduler booking payment ledger amounts should not be negative",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO scheduler_bookings (
        id, meeting_type_id, project_id, attendee_name, attendee_email,
        start_at, end_at, status, source, created_at, updated_at
      ) VALUES (
        'booking-overlap', 'meeting-1', 'project-1', 'Alex', 'alex@example.com',
        '2026-06-01T14:15:00.000Z', '2026-06-01T14:45:00.000Z',
        'confirmed', 'booking_link', ?, ?
      )
    `).run(now, now),
    /scheduler booking overlaps existing confirmed booking/,
    "confirmed scheduler bookings should not overlap an existing confirmed booking",
  );
  database.prepare(`
    INSERT INTO scheduler_bookings (
      id, meeting_type_id, project_id, attendee_name, attendee_email,
      start_at, end_at, status, source, created_at, updated_at
    ) VALUES (
      'booking-cancelled-overlap', 'meeting-1', 'project-1', 'Alex', 'alex@example.com',
      '2026-06-01T14:15:00.000Z', '2026-06-01T14:45:00.000Z',
      'cancelled', 'booking_link', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO scheduler_bookings (
        id, meeting_type_id, project_id, attendee_name, attendee_email,
        start_at, end_at, status, source, external_payment_id, created_at, updated_at
      ) VALUES (
        'booking-duplicate', 'meeting-1', 'project-1', 'Alex', 'alex@example.com',
        '2026-06-02T14:00:00.000Z', '2026-06-02T14:30:00.000Z',
        'confirmed', 'booking_link', 'pi_booking_unique_canon', ?, ?
      )
    `).run(now, now),
    /UNIQUE constraint failed/,
    "scheduler booking external payment ids should not drift into duplicate booking ledger rows",
  );

  database.prepare(`
    INSERT INTO vendors (
      id, name, normalized_name, created_at, updated_at
    ) VALUES (
      'vendor-1', 'Canon Professional Services', 'canon professional services', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO vendors (
        id, name, normalized_name, created_at, updated_at
      ) VALUES (
        'vendor-padded-name', ' Canon Professional Services ', 'canon professional services padded', ?, ?
      )
    `).run(now, now),
    /vendor name must be trimmed non-empty text/,
    "vendor names should not be padded by direct imports",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO vendors (
        id, name, normalized_name, created_at, updated_at
      ) VALUES (
        'vendor-invalid-normalized', 'B and H Photo', 'B And H Photo', ?, ?
      )
    `).run(now, now),
    /vendor normalized name must be lowercase and trimmed/,
    "vendor normalized names should stay lowercase and trimmed",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE vendors
      SET email = ' HELLO@VENDOR.COM '
      WHERE id = 'vendor-1'
    `).run(),
    /vendor email must be lowercase and trimmed/,
    "vendor emails should not drift into padded uppercase values",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE vendors
      SET website_url = '  '
      WHERE id = 'vendor-1'
    `).run(),
    /vendor detail text must be null or trimmed non-empty text/,
    "vendor optional detail text should not drift into whitespace",
  );

  database.prepare(`
    INSERT INTO expenses (
      id, vendor_id, project_id, category, description, amount_cents, status, source_type, source_id,
      external_payment_id, created_at, updated_at
    ) VALUES (
      'expense-1', 'vendor-1', 'project-1', 'software', 'Canon reconciliation expense', 1200, 'paid',
      'project_source', 'source-1', 'bank_unique_canon', ?, ?
    )
  `).run(now, now);
  assert.throws(
    () => database.prepare(`
      INSERT INTO expenses (
        id, project_id, category, description, amount_cents, status, source_id, created_at, updated_at
      ) VALUES (
        'expense-half-source-insert', 'project-1', 'software', 'Half-linked expense',
        1200, 'paid', 'source-1', ?, ?
      )
    `).run(now, now),
    /expense source links require sourceType when sourceId is set/,
    "expense source ids should not be stored without a source type",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE expenses
      SET source_type = NULL, source_id = 'source-1'
      WHERE id = 'expense-1'
    `).run(),
    /expense source links require sourceType when sourceId is set/,
    "expense source updates should not create half-linked source ids",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO expenses (
        id, project_id, category, description, amount_cents, status, source_type, source_id,
        created_at, updated_at
      ) VALUES (
        'expense-wrong-project-source-insert', 'project-1', 'software',
        'Wrong project source expense', 1200, 'paid', 'project_source', 'source-other', ?, ?
      )
    `).run(now, now),
    /expense project_source links must point to a source in the same project/,
    "expense project_source inserts should not point to another project's source row",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE expenses
      SET source_type = 'project_source', source_id = 'source-other'
      WHERE id = 'expense-1'
    `).run(),
    /expense project_source links must point to a source in the same project/,
    "expense project_source updates should not point to another project's source row",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO expenses (
        id, project_id, category, description, amount_cents, status, created_at, updated_at
      ) VALUES (
        'expense-padded-category', 'project-1', ' software ', 'Padded category expense',
        1200, 'paid', ?, ?
      )
    `).run(now, now),
    /expense category must be trimmed non-empty text/,
    "expense categories should not be padded by direct imports",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO expenses (
        id, project_id, category, description, amount_cents, status, created_at, updated_at
      ) VALUES (
        'expense-invalid-status', 'project-1', 'software', 'Invalid status expense',
        1200, 'settled', ?, ?
      )
    `).run(now, now),
    /expense status must be canonical/,
    "expense statuses should remain in the Studio bookkeeping vocabulary",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO expenses (
        id, project_id, category, description, amount_cents, status, created_at, updated_at
      ) VALUES (
        'expense-negative-amount', 'project-1', 'software', 'Negative amount expense',
        -1, 'paid', ?, ?
      )
    `).run(now, now),
    /expense amount must be canonical non-negative integer/,
    "expense amounts should not be negative",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE expenses
      SET receipt_url = '  '
      WHERE id = 'expense-1'
    `).run(),
    /expense detail text must be null or trimmed non-empty text/,
    "expense optional detail text should not drift into whitespace",
  );
  assert.throws(
    () => database.prepare(`
      UPDATE expenses
      SET tax_deductible = 2
      WHERE id = 'expense-1'
    `).run(),
    /expense tax deductible flag must be canonical/,
    "expense tax deductible flags should remain boolean",
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO expenses (
        id, project_id, category, description, amount_cents, status, external_payment_id, created_at, updated_at
      ) VALUES (
        'expense-duplicate', 'project-1', 'software', 'Duplicate reconciliation expense', 1200, 'paid',
        'bank_unique_canon', ?, ?
      )
    `).run(now, now),
    /UNIQUE constraint failed/,
    "expense external payment ids should not drift into duplicate bookkeeping rows",
  );

  console.log("studio canon tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
