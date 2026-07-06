import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  // Phase 8b (SMS/TCPA): client-level SMS consent state. NOT NULL DEFAULT false so
  // every existing client is opted-OUT until an explicit opt-in — the legally safe
  // default. These are CURRENT-STATE only; the append-only proof of every consent
  // change lives in activity_logs (client.sms.opted_in / client.sms.opted_out).
  smsOptIn: integer("sms_opt_in", { mode: "boolean" }).notNull().default(false),
  smsConsentSource: text("sms_consent_source"), // "booking" | "portal" | "admin" | "inbound_start" | null
  smsConsentAt: text("sms_consent_at"),
  smsOptOutAt: text("sms_opt_out_at"),
  smsLastConsentNote: text("sms_last_consent_note"),
  ...timestamps,
});

// Phase 8b (SMS/TCPA): number-level suppression store. A STOP can arrive from a
// number that matches no current client, so the send gate consults this table
// independently of the client columns. Suppression WINS over the client column.
export const smsSuppressions = sqliteTable("sms_suppressions", {
  phoneE164: text("phone_e164").primaryKey(), // normalized destination; PRIMARY KEY = dedupe
  stoppedAt: text("stopped_at").notNull(),
  note: text("note"),
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
  // Phase 9a — finance rate settings (reports only; safe code defaults when NULL).
  taxSetAsideRatePercent: integer("tax_set_aside_rate_percent"),
  mileageRateCents: integer("mileage_rate_cents"),
  form1099ThresholdCents: integer("form_1099_threshold_cents"),
  // Phase 10 — intelligence/forecasting admin settings (reports only; safe code
  // defaults when NULL). Never agent-written; guarded admin CRUD only.
  forecastHorizonMonths: integer("forecast_horizon_months"),
  forecastTrailingMonths: integer("forecast_trailing_months"),
  monthlyCapacityTarget: integer("monthly_capacity_target"),
  leadSourceTaxonomyJson: text("lead_source_taxonomy_json"),
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
  // Phase 8b (SMS): Twilio Message SID + latest delivery status, updated by the
  // status callback route keyed on providerMessageId.
  providerMessageId: text("provider_message_id"),
  deliveryStatus: text("delivery_status"),
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
  // Phase 9a (1099/W-9): admin-entered vendor tax data. Store ONLY the last 4 of
  // the TIN — never the full SSN/EIN (PII minimization). Agents cannot write these
  // (finance-adjacent) — see agent-finance-guard.test.ts.
  taxIdLast4: text("tax_id_last4"),
  is1099Tracked: integer("is_1099_tracked", { mode: "boolean" }).notNull().default(false),
  legalName: text("legal_name"),
  taxAddress: text("tax_address"),
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
  // Phase 9a: refund/dispute summary columns (always-on read path — finance report +
  // reconcile status). `refunded_amount_cents` is set-to-authoritative (clamped to
  // grossCollected, never decreased); `dispute_status` ∈ NULL|open|won|lost|reinstated.
  refundedAmountCents: integer("refunded_amount_cents").notNull().default(0),
  disputeStatus: text("dispute_status"),
  disputedAmountCents: integer("disputed_amount_cents").notNull().default(0),
  lastRefundAt: text("last_refund_at"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  updatedAt: text("updated_at").notNull().default("CURRENT_TIMESTAMP"),
});

// ---------------------------------------------------------------------------
// Phase 9a — Refund / dispute WEBHOOK recording (Stripe is source of truth; we
// mirror inbound signature-verified events into our ledger). NO money moved.
// Every write is idempotent-by-construction: UNIQUE stripe id + set-to-authoritative,
// so a redelivered/replayed event converges to the same row state (no db.transaction —
// D1 rejects it). The event-id dedupe row is written LAST, after processing succeeds.
// ---------------------------------------------------------------------------

export const stripeWebhookEvents = sqliteTable("stripe_webhook_events", {
  eventId: text("event_id").primaryKey(), // Stripe event.id (evt_...); dedupe key
  eventType: text("event_type").notNull(),
  createdAt: text("created_at").notNull(), // our receive time
  stripeCreatedAt: text("stripe_created_at"), // event.created (epoch → ISO)
  result: text("result"), // short JSON of what we did (audit)
});

export const paymentRefunds = sqliteTable("payment_refunds", {
  id: text("id").primaryKey(),
  stripeRefundId: text("stripe_refund_id").notNull(), // re_...; UNIQUE (dedupe within table)
  stripeChargeId: text("stripe_charge_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"), // join key → external_payment_id
  invoicePaymentId: text("invoice_payment_id").references(() => invoicePayments.id, { onDelete: "set null" }),
  schedulerBookingId: text("scheduler_booking_id").references(() => schedulerBookings.id, { onDelete: "set null" }),
  amountCents: integer("amount_cents").notNull().default(0),
  currency: text("currency").notNull().default("usd"),
  reason: text("reason"),
  status: text("status"), // succeeded | pending | failed | canceled
  stripeCreatedAt: text("stripe_created_at"), // for out-of-order monotonic guard
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const paymentDisputes = sqliteTable("payment_disputes", {
  id: text("id").primaryKey(),
  stripeDisputeId: text("stripe_dispute_id").notNull(), // dp_...; UNIQUE
  stripeChargeId: text("stripe_charge_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  invoicePaymentId: text("invoice_payment_id").references(() => invoicePayments.id, { onDelete: "set null" }),
  schedulerBookingId: text("scheduler_booking_id").references(() => schedulerBookings.id, { onDelete: "set null" }),
  amountCents: integer("amount_cents").notNull().default(0),
  currency: text("currency").notNull().default("usd"),
  reason: text("reason"),
  status: text("status"), // warning_needs_response | needs_response | under_review | won | lost | ...
  fundsReinstated: integer("funds_reinstated").notNull().default(0),
  openedAt: text("opened_at"),
  closedAt: text("closed_at"),
  stripeCreatedAt: text("stripe_created_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Phase 9a — mileage log (tax deduction input). No money moved; admin CRUD only.
export const mileageLogs = sqliteTable("mileage_logs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  tripDate: text("trip_date").notNull(),
  miles: real("miles").notNull(),
  purpose: text("purpose"),
  fromLocation: text("from_location"),
  toLocation: text("to_location"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
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

// Phase 7a: provider-agnostic gallery delivery links. Provider-managed gallery
// (Pixieset/Pic-Time/Cloudinary/other) — Studio stores the admin-pasted https
// delivery URL only, never an owned asset. `provider` is free text (not an
// enum) so 7a stays provider-agnostic. `status` defaults to "draft" so a
// freshly attached gallery is admin-only until explicitly marked "delivered".
export const projectGalleries = sqliteTable("project_galleries", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  provider: text("provider"),
  title: text("title").notNull(),
  url: text("url").notNull(),
  // draft | delivered | archived
  status: text("status").notNull().default("draft"),
  passcode: text("passcode"),
  deliveredAt: text("delivered_at"),
  expiresAt: text("expires_at"),
  // admin | agent
  createdBy: text("created_by").notNull().default("admin"),
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

// ---------------------------------------------------------------------------
// Phase 8c — Automated communication sequences (dunning / pre-event / review).
// All THREE tables are additive + dark: read/written ONLY by the flag-gated
// sequence runner (`src/lib/sequences.ts`) and the public unsubscribe endpoint.
// Not an always-on read surface, so (unlike 0087) 0088 is NOT deploy-order
// critical. email_suppressions must SURVIVE a feature rollback (a client's
// unsubscribe is permanent) — same rule as sms_suppressions.
// ---------------------------------------------------------------------------

// Consent/compliance: an email one-click-unsubscribe suppression list. Checked
// before EVERY sequence email draft AND send. email is the PRIMARY KEY (dedupe);
// writes are always INSERT ON CONFLICT DO NOTHING (attacker-chosen input →
// insert-not-update). Suppression is fail-safe: the only thing an unsubscribe
// POST can ever do is ADD a row (never remove).
export const emailSuppressions = sqliteTable("email_suppressions", {
  email: text("email").primaryKey(), // lowercased; PRIMARY KEY = dedupe
  suppressedAt: text("suppressed_at").notNull(),
  source: text("source"), // "unsubscribe_link" | "admin" | "bounce"
  note: text("note"),
});

// Enrollment state: what anchor (invoice / event date / workflow step) a project
// is enrolled against for a given sequence. UNIQUE(sequenceKey, anchorKey) makes
// re-enrollment idempotent (ON CONFLICT DO NOTHING).
export const sequenceEnrollments = sqliteTable("sequence_enrollments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  clientId: text("client_id"),
  sequenceKey: text("sequence_key").notNull(),
  anchorKey: text("anchor_key").notNull(), // invoiceId | eventDateISO | workflowStepId
  status: text("status").notNull().default("active"), // "active" | "stopped" | "completed"
  enrolledBy: text("enrolled_by").notNull().default("system"), // "system" | "Tyler"
  enrolledAt: text("enrolled_at").notNull(),
  stoppedAt: text("stopped_at"),
  stopReason: text("stop_reason"),
}, (t) => ({ uq: uniqueIndex("uq_sequence_enrollment").on(t.sequenceKey, t.anchorKey) }));

// The AT-MOST-ONCE ledger. UNIQUE(dedupeKey) makes a double-fire a DB-level
// impossibility. status semantics:
//   "claimed"    — TERMINAL-UNKNOWN. A send may or may not have happened; NEVER
//                  auto-retried (retrying could double-send). Surfaced for manual
//                  review via a sequence.send_stuck activity.
//   "done"       — draft written, or auto-send accepted by Resend.
//   "failed"     — PROVABLY-not-sent (suppression refusal / definitive
//                  pre-acceptance 4xx). The ONLY retryable class.
//   "superseded" — a due step skipped because a later-due step fired this run
//                  (one-step-per-enrollment-per-run). Never emits a message.
export const sequenceSends = sqliteTable("sequence_sends", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  clientId: text("client_id"),
  // Binds the ledger row to its OWN enrollment so a retry renders from the
  // correct invoice/anchor (never another client's) and re-checks stop-on-paid
  // against the right invoice.
  enrollmentId: text("enrollment_id"),
  sequenceKey: text("sequence_key").notNull(),
  stepKey: text("step_key").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  channel: text("channel").notNull(), // "email" | "sms"
  mode: text("mode").notNull(), // "draft" | "auto_send"
  status: text("status").notNull().default("claimed"),
  communicationId: text("communication_id"),
  attempts: integer("attempts").notNull().default(0),
  firedAt: text("fired_at").notNull(),
  note: text("note"),
}, (t) => ({ dedupe: uniqueIndex("uq_sequence_sends_dedupe").on(t.dedupeKey) }));

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
export type ProjectGallery = typeof projectGalleries.$inferSelect;
export type EmailSuppression = typeof emailSuppressions.$inferSelect;
export type SequenceEnrollment = typeof sequenceEnrollments.$inferSelect;
export type SequenceSend = typeof sequenceSends.$inferSelect;
export type StripeWebhookEvent = typeof stripeWebhookEvents.$inferSelect;
export type PaymentRefund = typeof paymentRefunds.$inferSelect;
export type PaymentDispute = typeof paymentDisputes.$inferSelect;
export type MileageLog = typeof mileageLogs.$inferSelect;
