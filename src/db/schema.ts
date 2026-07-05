import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
};

export const clients = sqliteTable("clients", {
  id: text("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  email: text("email").notNull().unique(),
  phone: text("phone"),
  preferredName: text("preferred_name"),
  instagramHandle: text("instagram_handle"),
  communicationPreference: text("communication_preference"),
  referralSource: text("referral_source"),
  notes: text("notes"),
  ...timestamps,
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull().default("wedding"),
  stage: text("stage").notNull().default("inquiry"),
  status: text("status").notNull().default("active"),
  eventDate: text("event_date"),
  venueName: text("venue_name"),
  venueAddress: text("venue_address"),
  city: text("city"),
  state: text("state"),
  budgetCents: integer("budget_cents"),
  googleCalendarEventId: text("google_calendar_event_id"),
  calendarSyncStatus: text("calendar_sync_status").notNull().default("not_connected"),
  notes: text("notes"),
  ...timestamps,
});

export const projectEvents = sqliteTable("project_events", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("wedding"),
  title: text("title").notNull(),
  eventDate: text("event_date"),
  venueName: text("venue_name"),
  venueAddress: text("venue_address"),
  city: text("city"),
  state: text("state"),
  googleCalendarEventId: text("google_calendar_event_id"),
  calendarSyncStatus: text("calendar_sync_status").notNull().default("not_connected"),
  notes: text("notes"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const projectLocations = sqliteTable("project_locations", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("other"),
  name: text("name").notNull(),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  notes: text("notes"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const shootingLocations = sqliteTable("shooting_locations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  region: text("region"),
  city: text("city"),
  state: text("state"),
  country: text("country").notNull().default("USA"),
  address: text("address"),
  googleMapsUrl: text("google_maps_url"),
  locationType: text("location_type").notNull().default("other"),
  bestFor: text("best_for"),
  permitNotes: text("permit_notes"),
  accessNotes: text("access_notes"),
  lightNotes: text("light_notes"),
  droneNotes: text("drone_notes"),
  generalNotes: text("general_notes"),
  tagsJson: text("tags_json"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const projectParticipants = sqliteTable("project_participants", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("primary"),
  isPrimaryContact: integer("is_primary_contact", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const schedulerMeetingTypes = sqliteTable("scheduler_meeting_types", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  durationMinutes: integer("duration_minutes").notNull().default(30),
  bufferMinutes: integer("buffer_minutes").notNull().default(15),
  locationType: text("location_type").notNull().default("zoom"),
  locationLabel: text("location_label"),
  zoomJoinUrl: text("zoom_join_url"),
  inviteeQuestionsJson: text("invitee_questions_json"),
  collectPayment: integer("collect_payment", { mode: "boolean" }).notNull().default(false),
  priceCents: integer("price_cents"),
  stripePaymentLink: text("stripe_payment_link"),
  smsOptInEnabled: integer("sms_opt_in_enabled", { mode: "boolean" }).notNull().default(true),
  confirmationMessage: text("confirmation_message"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const schedulerSettings = sqliteTable("scheduler_settings", {
  id: text("id").primaryKey(),
  timezone: text("timezone").notNull().default("America/New_York"),
  bookingWindowDays: integer("booking_window_days").notNull().default(30),
  minimumNoticeMinutes: integer("minimum_notice_minutes").notNull().default(240),
  availabilityJson: text("availability_json").notNull(),
  googleCalendarIds: text("google_calendar_ids"),
  googleCreateCalendarId: text("google_create_calendar_id"),
  zoomJoinUrl: text("zoom_join_url"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const googleCalendarConnections = sqliteTable("google_calendar_connections", {
  id: text("id").primaryKey(),
  googleAccountEmail: text("google_account_email").notNull(),
  displayName: text("display_name"),
  refreshToken: text("refresh_token").notNull(),
  scope: text("scope"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const schedulerBookings = sqliteTable("scheduler_bookings", {
  id: text("id").primaryKey(),
  meetingTypeId: text("meeting_type_id").notNull().references(() => schedulerMeetingTypes.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  clientId: text("client_id").references(() => clients.id, { onDelete: "set null" }),
  attendeeName: text("attendee_name").notNull(),
  attendeeEmail: text("attendee_email").notNull(),
  attendeePhone: text("attendee_phone"),
  smsOptIn: integer("sms_opt_in", { mode: "boolean" }).notNull().default(false),
  inviteeAnswersJson: text("invitee_answers_json"),
  startAt: text("start_at").notNull(),
  endAt: text("end_at").notNull(),
  status: text("status").notNull().default("confirmed"),
  notes: text("notes"),
  source: text("source").notNull().default("booking_link"),
  googleCalendarEventId: text("google_calendar_event_id"),
  googleCalendarId: text("google_calendar_id"),
  calendarSyncStatus: text("calendar_sync_status").notNull().default("not_connected"),
  cancelledAt: text("cancelled_at"),
  cancellationReason: text("cancellation_reason"),
  rescheduledFromBookingId: text("rescheduled_from_booking_id"),
  reminderSentAt: text("reminder_sent_at"),
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  paymentMethod: text("payment_method"),
  paidAt: text("paid_at"),
  paidAmountCents: integer("paid_amount_cents").notNull().default(0),
  clientFeeCents: integer("client_fee_cents").notNull().default(0),
  processingFeeCents: integer("processing_fee_cents").notNull().default(0),
  grossCollectedCents: integer("gross_collected_cents").notNull().default(0),
  netDepositCents: integer("net_deposit_cents").notNull().default(0),
  externalPaymentId: text("external_payment_id"),
  paymentLink: text("payment_link"),
  paymentNotes: text("payment_notes"),
  paymentSourceType: text("payment_source_type"),
  paymentSourceId: text("payment_source_id"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const appSettings = sqliteTable("app_settings", {
  id: text("id").primaryKey(),
  businessName: text("business_name").notNull(),
  publicBrandName: text("public_brand_name").notNull(),
  contactEmail: text("contact_email").notNull(),
  websiteUrl: text("website_url"),
  instagramUrl: text("instagram_url"),
  timezone: text("timezone").notNull().default("America/New_York"),
  paymentMethodsJson: text("payment_methods_json").notNull(),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const templates = sqliteTable("templates", {
  id: text("id").primaryKey(),
  type: text("type").notNull().default("email"),
  name: text("name").notNull(),
  trigger: text("trigger"),
  subject: text("subject"),
  body: text("body").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const questionnaires = sqliteTable("questionnaires", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("active"),
  sourceFormUrl: text("source_form_url"),
  responseSheetUrl: text("response_sheet_url"),
  responseSheetName: text("response_sheet_name"),
  externalQuestionCount: integer("external_question_count").notNull().default(0),
  lastResponseCount: integer("last_response_count").notNull().default(0),
  lastImportedAt: text("last_imported_at"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const questionnaireQuestions = sqliteTable("questionnaire_questions", {
  id: text("id").primaryKey(),
  questionnaireId: text("questionnaire_id").notNull().references(() => questionnaires.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  type: text("type").notNull().default("short_text"),
  required: integer("required", { mode: "boolean" }).notNull().default(false),
  optionsJson: text("options_json"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const questionnaireResponses = sqliteTable("questionnaire_responses", {
  id: text("id").primaryKey(),
  questionnaireId: text("questionnaire_id").notNull().references(() => questionnaires.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  clientId: text("client_id").references(() => clients.id, { onDelete: "set null" }),
  respondentName: text("respondent_name"),
  respondentEmail: text("respondent_email"),
  submittedAt: text("submitted_at"),
  sourceResponseId: text("source_response_id"),
  answersJson: text("answers_json").notNull(),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const projectTimelineItems = sqliteTable("project_timeline_items", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  startAt: text("start_at"),
  endAt: text("end_at"),
  sortOrder: integer("sort_order").notNull().default(0),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  createdBy: text("created_by").notNull().default("admin"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const projectSources = sqliteTable("project_sources", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("note"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  summary: text("summary"),
  occurredAt: text("occurred_at"),
  externalUrl: text("external_url"),
  capturedBy: text("captured_by"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const agentTasks = sqliteTable("agent_tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  instructions: text("instructions"),
  status: text("status").notNull().default("queued"),
  priority: text("priority").notNull().default("normal"),
  requestedBy: text("requested_by"),
  assignedAgent: text("assigned_agent"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  resultSummary: text("result_summary"),
  outputJson: text("output_json"),
  errorMessage: text("error_message"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const projectWorkflowRuns = sqliteTable("project_workflow_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  workflowKey: text("workflow_key").notNull(),
  workflowName: text("workflow_name").notNull(),
  status: text("status").notNull().default("active"),
  selectedStepKeysJson: text("selected_step_keys_json").notNull(),
  createdBy: text("created_by").notNull().default("Tyler"),
  startedAt: text("started_at"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const projectWorkflowSteps = sqliteTable("project_workflow_steps", {
  id: text("id").primaryKey(),
  workflowRunId: text("workflow_run_id").notNull().references(() => projectWorkflowRuns.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  stepKey: text("step_key").notNull(),
  title: text("title").notNull(),
  instructions: text("instructions").notNull(),
  assignedAgent: text("assigned_agent").notNull(),
  triggerLabel: text("trigger_label"),
  status: text("status").notNull().default("configured"),
  automationEnabled: integer("automation_enabled", { mode: "boolean" }).notNull().default(true),
  agentTaskId: text("agent_task_id").references(() => agentTasks.id, { onDelete: "set null" }),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const projectCommunications = sqliteTable("project_communications", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  clientId: text("client_id").references(() => clients.id, { onDelete: "set null" }),
  direction: text("direction").notNull().default("outbound"),
  channel: text("channel").notNull().default("email"),
  status: text("status").notNull().default("draft"),
  subject: text("subject"),
  body: text("body").notNull(),
  recipientName: text("recipient_name"),
  recipientEmail: text("recipient_email"),
  scheduledFor: text("scheduled_for"),
  sentAt: text("sent_at"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  createdBy: text("created_by").notNull().default("admin"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const vendors = sqliteTable("vendors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull().unique(),
  email: text("email"),
  websiteUrl: text("website_url"),
  notes: text("notes"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const expenses = sqliteTable("expenses", {
  id: text("id").primaryKey(),
  vendorId: text("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  category: text("category").notNull().default("general"),
  description: text("description").notNull(),
  amountCents: integer("amount_cents").notNull().default(0),
  status: text("status").notNull().default("paid"),
  paidAt: text("paid_at"),
  paymentMethod: text("payment_method"),
  externalPaymentId: text("external_payment_id"),
  receiptUrl: text("receipt_url"),
  taxDeductible: integer("tax_deductible", { mode: "boolean" }).notNull().default(true),
  notes: text("notes"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const proposals = sqliteTable("proposals", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: text("status").notNull().default("draft"),
  packageName: text("package_name"),
  totalCents: integer("total_cents"),
  validUntil: text("valid_until"),
  scopeSummary: text("scope_summary"),
  contractStatus: text("contract_status").notNull().default("not_started"),
  contractTemplateId: text("contract_template_id"),
  contractTitle: text("contract_title"),
  contractBody: text("contract_body"),
  invoiceStatus: text("invoice_status").notNull().default("not_created"),
  sentAt: text("sent_at"),
  acceptedAt: text("accepted_at"),
  signedAt: text("signed_at"),
  signerName: text("signer_name"),
  signerEmail: text("signer_email"),
  signatureIp: text("signature_ip"),
  signatureUserAgent: text("signature_user_agent"),
  signatureConsentText: text("signature_consent_text"),
  signatureConsentVersion: text("signature_consent_version"),
  selectedOptionalLineItemIdsJson: text("selected_optional_line_item_ids_json"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const proposalLineItems = sqliteTable("proposal_line_items", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull().references(() => proposals.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  quantity: integer("quantity").notNull().default(1),
  unitPriceCents: integer("unit_price_cents").notNull().default(0),
  isOptional: integer("is_optional", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const proposalAccessTokens = sqliteTable("proposal_access_tokens", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull().references(() => proposals.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  clientId: text("client_id").references(() => clients.id, { onDelete: "set null" }),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label"),
  expiresAt: text("expires_at").notNull(),
  sentAt: text("sent_at"),
  viewedAt: text("viewed_at"),
  revokedAt: text("revoked_at"),
  lastUsedAt: text("last_used_at"),
  lastUsedIp: text("last_used_ip"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const invoices = sqliteTable("invoices", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  proposalId: text("proposal_id").references(() => proposals.id, { onDelete: "set null" }),
  invoiceNumber: text("invoice_number").notNull().unique(),
  status: text("status").notNull().default("draft"),
  totalCents: integer("total_cents").notNull().default(0),
  amountPaidCents: integer("amount_paid_cents").notNull().default(0),
  dueDate: text("due_date"),
  paymentNotes: text("payment_notes"),
  acceptedPaymentMethodsJson: text("accepted_payment_methods_json"),
  cardFeePolicy: text("card_fee_policy").notNull().default("studio_absorbs"),
  cardFeePercentBps: integer("card_fee_percent_bps").notNull().default(0),
  cardFeeFixedCents: integer("card_fee_fixed_cents").notNull().default(0),
  cardFeeAmountCents: integer("card_fee_amount_cents").notNull().default(0),
  stripePaymentLink: text("stripe_payment_link"),
  zelleInfo: text("zelle_info"),
  venmoInfo: text("venmo_info"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  sentAt: text("sent_at"),
  paidAt: text("paid_at"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const invoicePayments = sqliteTable("invoice_payments", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  amountCents: integer("amount_cents").notNull().default(0),
  dueDate: text("due_date"),
  status: text("status").notNull().default("pending"),
  paidAt: text("paid_at"),
  paymentMethod: text("payment_method"),
  paidAmountCents: integer("paid_amount_cents").notNull().default(0),
  clientFeeCents: integer("client_fee_cents").notNull().default(0),
  processingFeeCents: integer("processing_fee_cents").notNull().default(0),
  grossCollectedCents: integer("gross_collected_cents").notNull().default(0),
  netDepositCents: integer("net_deposit_cents").notNull().default(0),
  externalPaymentId: text("external_payment_id"),
  stripeCheckoutUrl: text("stripe_checkout_url"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  stripeCheckoutStatus: text("stripe_checkout_status").notNull().default("not_created"),
  notes: text("notes"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const portalAccessTokens = sqliteTable("portal_access_tokens", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  clientId: text("client_id").references(() => clients.id, { onDelete: "set null" }),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label"),
  // Phase 6.5: distinguishes the existing 30-day session token ("session",
  // default for every pre-6.5 row) from a short-TTL, single-use magic-request
  // token ("magic_request") minted by the self-service email login.
  kind: text("kind").notNull().default("session"),
  // Set once when a magic-request token is redeemed. The single-use claim is an
  // atomic `UPDATE ... WHERE consumed_at IS NULL RETURNING`.
  consumedAt: text("consumed_at"),
  // Shared across every token minted for one request (one per active project),
  // so the per-email cap counts request-batches, not raw tokens.
  requestBatchId: text("request_batch_id"),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  lastUsedAt: text("last_used_at"),
  lastUsedIp: text("last_used_ip"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const assetObjects = sqliteTable("asset_objects", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  kind: text("kind").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  proposalId: text("proposal_id").references(() => proposals.id, { onDelete: "set null" }),
  invoiceId: text("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  createdBy: text("created_by").notNull(),
  deletedAt: text("deleted_at"),
});

// Phase 8a: pre-canonical staging table for inbound inquiry emails. The entire
// message is attacker-controlled; rows here NEVER become canonical without an
// explicit admin approval action. Inbound only ever inserts (create-if-absent
// by message_id); the drafter writes only the draft_* columns; nothing here
// mutates projects/clients/communications on its own.
export const inboundInquiries = sqliteTable("inbound_inquiries", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("new"),
  // new | proposed | approved | dismissed | spam
  // --- raw (audit) ---
  messageId: text("message_id"),
  inReplyTo: text("in_reply_to"),
  referencesHeader: text("references_header"),
  envelopeFrom: text("envelope_from"),
  headerFrom: text("header_from"),
  toAddress: text("to_address"),
  subject: text("subject"),
  rawStorageKey: text("raw_storage_key"),
  bodyText: text("body_text"),
  // --- auth trust signals (display only, never authz) ---
  spfResult: text("spf_result"),
  dkimResult: text("dkim_result"),
  dmarcResult: text("dmarc_result"),
  // --- parsed guesses (best-effort, low-trust) ---
  parsedName: text("parsed_name"),
  parsedEmail: text("parsed_email"),
  parsedEventDate: text("parsed_event_date"),
  parsedVenue: text("parsed_venue"),
  parsedJson: text("parsed_json"),
  // --- linkage after approval ---
  agentTaskId: text("agent_task_id").references(() => agentTasks.id, { onDelete: "set null" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  proposedProjectJson: text("proposed_project_json"),
  draftReplySubject: text("draft_reply_subject"),
  draftReplyBody: text("draft_reply_body"),
  dismissedReason: text("dismissed_reason"),
  receivedAt: text("received_at").notNull(),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const activityLogs = sqliteTable("activity_logs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  clientId: text("client_id").references(() => clients.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  actorType: text("actor_type").notNull().default("admin"),
  actorName: text("actor_name"),
  metadata: text("metadata"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

export type Client = typeof clients.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ProjectEvent = typeof projectEvents.$inferSelect;
export type ProjectLocation = typeof projectLocations.$inferSelect;
export type ShootingLocation = typeof shootingLocations.$inferSelect;
export type SchedulerMeetingType = typeof schedulerMeetingTypes.$inferSelect;
export type SchedulerBooking = typeof schedulerBookings.$inferSelect;
export type SchedulerSettings = typeof schedulerSettings.$inferSelect;
export type GoogleCalendarConnection = typeof googleCalendarConnections.$inferSelect;
export type AppSettings = typeof appSettings.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type Questionnaire = typeof questionnaires.$inferSelect;
export type QuestionnaireQuestion = typeof questionnaireQuestions.$inferSelect;
export type QuestionnaireResponse = typeof questionnaireResponses.$inferSelect;
export type ProjectTimelineItem = typeof projectTimelineItems.$inferSelect;
export type ProjectWorkflowRun = typeof projectWorkflowRuns.$inferSelect;
export type ProjectWorkflowStep = typeof projectWorkflowSteps.$inferSelect;
export type ProjectCommunication = typeof projectCommunications.$inferSelect;
export type Vendor = typeof vendors.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type Proposal = typeof proposals.$inferSelect;
export type ProposalLineItem = typeof proposalLineItems.$inferSelect;
export type ProposalAccessToken = typeof proposalAccessTokens.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoicePayment = typeof invoicePayments.$inferSelect;
export type PortalAccessToken = typeof portalAccessTokens.$inferSelect;
export type AssetObject = typeof assetObjects.$inferSelect;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type InboundInquiry = typeof inboundInquiries.$inferSelect;
