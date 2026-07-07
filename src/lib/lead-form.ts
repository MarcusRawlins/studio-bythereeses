// Phase 19 — embeddable lead-form config. A FIXED field vocabulary with per-field show/hide +
// required toggles and custom copy (NOT a form builder, spec §5). Stored as one JSON blob in
// `app_settings.lead_form_config_json`, normalized against code defaults exactly like
// `normalizePaymentSettings` (settings.ts:115-122).
//
// Config-injection / stored-XSS defense (MEDIUM-3): the free-text fields (introText,
// submitButtonText, confirmationMessage) are ADMIN-SET but rendered on a PUBLIC page framed into
// bythereeses.com. Two layers, both required:
//   (a) the embed page renders every config string as an ESCAPED JSX text node — NEVER via
//       dangerouslySetInnerHTML (see LeadFormBody). React escaping is the load-bearing guarantee.
//   (b) normalizeLeadFormConfig runs sanitizeLine/sanitizeBody + hard caps on EVERY string field
//       BEFORE store, so even a hand-edited DB row is control-char-stripped and bounded.

import { db } from "@/db/client";
import { appSettings } from "@/db/schema";
import { sanitizeBody, sanitizeLine } from "@/lib/inbound-inquiry";
import { defaultBusinessSettings, defaultPaymentSettings } from "@/lib/settings";
import { eq } from "drizzle-orm";

const SETTINGS_ID = "business";

export const MAX_INTRO_TEXT_LENGTH = 500;
export const MAX_SUBMIT_BUTTON_TEXT_LENGTH = 60;
export const MAX_CONFIRMATION_MESSAGE_LENGTH = 500;

// The fixed optional field vocabulary. name/email/message are identity fields — always on, always
// required — and are NOT in this list (they can never be disabled or made optional).
export const OPTIONAL_LEAD_FORM_FIELDS = ["phone", "eventDate", "eventType", "referralSource"] as const;
export type OptionalLeadFormField = (typeof OPTIONAL_LEAD_FORM_FIELDS)[number];
export type LeadFormFieldName = "name" | "email" | "message" | OptionalLeadFormField;

export type LeadFormFieldConfig = { enabled: boolean; required: boolean };

export type LeadFormConfig = {
  version: 1;
  rev: number;
  introText: string;
  submitButtonText: string;
  confirmationMessage: string;
  fields: Record<LeadFormFieldName, LeadFormFieldConfig>;
};

export const defaultLeadFormConfig: LeadFormConfig = {
  version: 1,
  rev: 0,
  introText: "Tell us a little about your day and we'll be in touch soon.",
  submitButtonText: "Send inquiry",
  confirmationMessage: "Thank you — we've received your inquiry and will be in touch soon.",
  fields: {
    name: { enabled: true, required: true },
    email: { enabled: true, required: true },
    message: { enabled: true, required: true },
    phone: { enabled: true, required: false },
    eventDate: { enabled: true, required: false },
    eventType: { enabled: true, required: false },
    referralSource: { enabled: false, required: false },
  },
};

// Human labels are FIXED code strings (v1 has no custom per-field labels), so they need no
// sanitize/escape budget of their own beyond React's default escaping at render time.
export const LEAD_FORM_FIELD_LABELS: Record<LeadFormFieldName, string> = {
  name: "Name",
  email: "Email",
  message: "Message",
  phone: "Phone",
  eventDate: "Event date",
  eventType: "Event type",
  referralSource: "How did you hear about us?",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeRev(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return defaultLeadFormConfig.rev;
  return n;
}

function normalizeOptionalField(key: OptionalLeadFormField, value: unknown): LeadFormFieldConfig {
  const input = asRecord(value);
  const defaults = defaultLeadFormConfig.fields[key];
  const enabled = "enabled" in input ? Boolean(input.enabled) : defaults.enabled;
  const required = "required" in input ? Boolean(input.required) : defaults.required;
  // A disabled field cannot be required (it is never rendered / never read on POST).
  return { enabled, required: enabled ? required : false };
}

// SHAPE + SANITIZE + CAP. Forces name/email/message on+required regardless of stored input, and
// runs the control-char/length sanitizers on every free-text field (MEDIUM-3, (b)).
export function normalizeLeadFormConfig(input: Partial<LeadFormConfig> | null | undefined = {}): LeadFormConfig {
  const source = asRecord(input);
  const fields = asRecord(source.fields);
  return {
    version: 1,
    rev: normalizeRev(source.rev),
    introText: sanitizeBody(String(source.introText ?? ""), MAX_INTRO_TEXT_LENGTH) || defaultLeadFormConfig.introText,
    submitButtonText:
      sanitizeLine(String(source.submitButtonText ?? ""), MAX_SUBMIT_BUTTON_TEXT_LENGTH) || defaultLeadFormConfig.submitButtonText,
    confirmationMessage:
      sanitizeBody(String(source.confirmationMessage ?? ""), MAX_CONFIRMATION_MESSAGE_LENGTH) ||
      defaultLeadFormConfig.confirmationMessage,
    fields: {
      // Identity fields — always on, always required (spec §5).
      name: { enabled: true, required: true },
      email: { enabled: true, required: true },
      message: { enabled: true, required: true },
      phone: normalizeOptionalField("phone", fields.phone),
      eventDate: normalizeOptionalField("eventDate", fields.eventDate),
      eventType: normalizeOptionalField("eventType", fields.eventType),
      referralSource: normalizeOptionalField("referralSource", fields.referralSource),
    },
  };
}

function parseStoredLeadFormConfig(value: string | null): LeadFormConfig {
  if (!value) return defaultLeadFormConfig;
  try {
    return normalizeLeadFormConfig(JSON.parse(value) as Partial<LeadFormConfig>);
  } catch {
    return defaultLeadFormConfig;
  }
}

export async function getLeadFormConfig(): Promise<LeadFormConfig> {
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.id, SETTINGS_ID) });
  return parseStoredLeadFormConfig(row?.leadFormConfigJson ?? null);
}

function checkbox(formData: FormData, key: string) {
  return formData.get(key) === "on";
}

// DEDICATED settings-write path (MINOR-9): this action writes ONLY `lead_form_config_json`. It is
// deliberately NOT joined into `updateAppSettingsFromForm`, which unconditionally rewrites the full
// business/payment column set — a second <form> posting that shared action WITHOUT the business
// fields would silently reset business settings to defaults. The onConflictDoUpdate below touches
// only the lead-form column, so an existing row's business/payment settings are preserved; a fresh
// row is seeded with safe business/payment defaults so the NOT NULL columns are satisfied.
export async function updateLeadFormConfigFromForm(formData: FormData): Promise<{ settingsId: string; config: LeadFormConfig }> {
  const current = await getLeadFormConfig();
  // Revocation is an explicit, opt-in Settings action (bump rev), so a routine copy edit never
  // silently invalidates every embed. "Copy embed snippet" always mints the CURRENT rev.
  const nextRev = checkbox(formData, "bumpRev") ? current.rev + 1 : current.rev;

  const config = normalizeLeadFormConfig({
    version: 1,
    rev: nextRev,
    introText: String(formData.get("introText") ?? ""),
    submitButtonText: String(formData.get("submitButtonText") ?? ""),
    confirmationMessage: String(formData.get("confirmationMessage") ?? ""),
    fields: {
      name: { enabled: true, required: true },
      email: { enabled: true, required: true },
      message: { enabled: true, required: true },
      phone: { enabled: checkbox(formData, "phoneEnabled"), required: checkbox(formData, "phoneRequired") },
      eventDate: { enabled: checkbox(formData, "eventDateEnabled"), required: checkbox(formData, "eventDateRequired") },
      eventType: { enabled: checkbox(formData, "eventTypeEnabled"), required: checkbox(formData, "eventTypeRequired") },
      referralSource: { enabled: checkbox(formData, "referralSourceEnabled"), required: checkbox(formData, "referralSourceRequired") },
    },
  });

  const now = new Date().toISOString();
  const serialized = JSON.stringify(config);

  await db
    .insert(appSettings)
    .values({
      id: SETTINGS_ID,
      businessName: defaultBusinessSettings.businessName,
      publicBrandName: defaultBusinessSettings.publicBrandName,
      contactEmail: defaultBusinessSettings.contactEmail,
      websiteUrl: defaultBusinessSettings.websiteUrl,
      instagramUrl: defaultBusinessSettings.instagramUrl,
      timezone: defaultBusinessSettings.timezone,
      paymentMethodsJson: JSON.stringify(defaultPaymentSettings),
      leadFormConfigJson: serialized,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: appSettings.id,
      // ONLY the lead-form column (+ updatedAt) — business/payment settings are left untouched.
      set: { leadFormConfigJson: serialized, updatedAt: now },
    });

  return { settingsId: SETTINGS_ID, config };
}
