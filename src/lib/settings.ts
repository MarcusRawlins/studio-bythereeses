import { db } from "@/db/client";
import { appSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

const SETTINGS_ID = "business";

export type PaymentMethodKey = "stripe" | "zelle" | "venmo" | "cashCheck";

export type BusinessSettings = {
  businessName: string;
  publicBrandName: string;
  contactEmail: string;
  websiteUrl: string;
  instagramUrl: string;
  timezone: string;
};

export type PaymentMethodSettings = {
  enabled: boolean;
  passFees: boolean;
  displayName: string;
  instructions: string;
};

export type PaymentSettings = Record<PaymentMethodKey, PaymentMethodSettings>;

export type AppSettingsView = BusinessSettings & {
  paymentMethods: PaymentSettings;
};

export const defaultBusinessSettings: BusinessSettings = {
  businessName: "Alex & Tyler Reese",
  publicBrandName: "Alex & Tyler",
  contactEmail: "hello@bythereeses.com",
  websiteUrl: "https://bythereeses.com",
  instagramUrl: "https://instagram.com/thereeses",
  timezone: "America/New_York",
};

export const defaultPaymentSettings: PaymentSettings = {
  stripe: {
    enabled: false,
    passFees: false,
    displayName: "Credit card",
    instructions: "",
  },
  zelle: {
    enabled: true,
    passFees: false,
    displayName: "Zelle",
    instructions: "hello@bythereeses.com",
  },
  venmo: {
    enabled: false,
    passFees: false,
    displayName: "Venmo",
    instructions: "",
  },
  cashCheck: {
    enabled: true,
    passFees: false,
    displayName: "Cash or check",
    instructions: "Payment can be made by cash or check.",
  },
};

const paymentOrder: PaymentMethodKey[] = ["stripe", "zelle", "venmo", "cashCheck"];

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function cleanUrl(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return "";
  if (raw.startsWith("@")) return `https://instagram.com/${raw.slice(1)}`;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function cleanEmail(value: unknown) {
  return cleanText(value).toLowerCase();
}

function asRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function normalizePaymentMethod(
  key: PaymentMethodKey,
  value: unknown,
): PaymentMethodSettings {
  const input = asRecord(value);
  const defaults = defaultPaymentSettings[key];
  return {
    enabled: Boolean(input.enabled),
    passFees: Boolean(input.passFees),
    displayName: cleanText(input.displayName) || defaults.displayName,
    instructions: key === "stripe" ? "" : cleanText(input.instructions),
  };
}

export function normalizeBusinessSettings(input: Partial<BusinessSettings> = {}): BusinessSettings {
  return {
    businessName: cleanText(input.businessName) || defaultBusinessSettings.businessName,
    publicBrandName: cleanText(input.publicBrandName) || defaultBusinessSettings.publicBrandName,
    contactEmail: cleanEmail(input.contactEmail) || defaultBusinessSettings.contactEmail,
    websiteUrl: cleanUrl(input.websiteUrl) || defaultBusinessSettings.websiteUrl,
    instagramUrl: cleanUrl(input.instagramUrl) || defaultBusinessSettings.instagramUrl,
    timezone: cleanText(input.timezone) || defaultBusinessSettings.timezone,
  };
}

export function normalizePaymentSettings(input: Partial<PaymentSettings> = {}): PaymentSettings {
  return {
    stripe: normalizePaymentMethod("stripe", input.stripe),
    zelle: normalizePaymentMethod("zelle", input.zelle),
    venmo: normalizePaymentMethod("venmo", input.venmo),
    cashCheck: normalizePaymentMethod("cashCheck", input.cashCheck),
  };
}

export function enabledPaymentMethods(paymentMethods: PaymentSettings) {
  return paymentOrder
    .map((key) => ({ key, ...paymentMethods[key] }))
    .filter((method) => method.enabled);
}

function parseStoredPaymentMethods(value: string | null) {
  if (!value) return defaultPaymentSettings;
  try {
    return normalizePaymentSettings(JSON.parse(value) as Partial<PaymentSettings>);
  } catch {
    return defaultPaymentSettings;
  }
}

export async function getAppSettings(): Promise<AppSettingsView> {
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.id, SETTINGS_ID) });
  if (!row) return { ...defaultBusinessSettings, paymentMethods: defaultPaymentSettings };

  return {
    ...normalizeBusinessSettings({
      businessName: row.businessName,
      publicBrandName: row.publicBrandName,
      contactEmail: row.contactEmail,
      websiteUrl: row.websiteUrl ?? "",
      instagramUrl: row.instagramUrl ?? "",
      timezone: row.timezone,
    }),
    paymentMethods: parseStoredPaymentMethods(row.paymentMethodsJson),
  };
}

function checkbox(formData: FormData, key: string) {
  return formData.get(key) === "on";
}

function paymentFromForm(formData: FormData, key: PaymentMethodKey): PaymentMethodSettings {
  return {
    enabled: checkbox(formData, `${key}Enabled`),
    passFees: checkbox(formData, `${key}PassFees`),
    displayName: cleanText(formData.get(`${key}DisplayName`)),
    instructions: cleanText(formData.get(`${key}Instructions`)),
  };
}

export async function updateAppSettingsAction(formData: FormData) {
  "use server";

  const business = normalizeBusinessSettings({
    businessName: cleanText(formData.get("businessName")),
    publicBrandName: cleanText(formData.get("publicBrandName")),
    contactEmail: cleanText(formData.get("contactEmail")),
    websiteUrl: cleanText(formData.get("websiteUrl")),
    instagramUrl: cleanText(formData.get("instagramUrl")),
    timezone: cleanText(formData.get("timezone")),
  });
  const paymentMethods = normalizePaymentSettings({
    stripe: paymentFromForm(formData, "stripe"),
    zelle: paymentFromForm(formData, "zelle"),
    venmo: paymentFromForm(formData, "venmo"),
    cashCheck: paymentFromForm(formData, "cashCheck"),
  });
  const now = new Date().toISOString();

  await db.insert(appSettings).values({
    id: SETTINGS_ID,
    businessName: business.businessName,
    publicBrandName: business.publicBrandName,
    contactEmail: business.contactEmail,
    websiteUrl: business.websiteUrl,
    instagramUrl: business.instagramUrl,
    timezone: business.timezone,
    paymentMethodsJson: JSON.stringify(paymentMethods),
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: appSettings.id,
    set: {
      businessName: business.businessName,
      publicBrandName: business.publicBrandName,
      contactEmail: business.contactEmail,
      websiteUrl: business.websiteUrl,
      instagramUrl: business.instagramUrl,
      timezone: business.timezone,
      paymentMethodsJson: JSON.stringify(paymentMethods),
      updatedAt: now,
    },
  });

  revalidatePath("/settings");
  revalidatePath("/invoices/new");
  revalidatePath("/invoices");
}
