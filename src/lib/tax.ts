// Phase 9a — Tax / 1099 / mileage. All read/report + simple guarded admin entry.
// NO money moved. Estimates are guides only ("not tax advice — confirm with your
// accountant"), no bracket logic, no filing.

import { db } from "@/db/client";
import { appSettings, expenses, mileageLogs, projects, vendors } from "@/db/schema";
import { getBookkeepingReport } from "@/lib/bookkeeping";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { revalidatePath } from "next/cache";

const SETTINGS_ID = "business";

// Safe defaults used when the app-setting is unset (all reports-only).
export const DEFAULT_TAX_SET_ASIDE_RATE_PERCENT = 25;
export const DEFAULT_MILEAGE_RATE_CENTS = 67; // 2024 IRS standard mileage rate
export const DEFAULT_FORM_1099_THRESHOLD_CENTS = 60000; // $600 IRS 1099-NEC threshold

// 1099-NEC is owed for NON-CARD payments (card/third-party is reported by the processor
// on 1099-K). payment_method is unvalidated free text, so match a NORMALIZED include-list
// — never an exact-string exclude (Fable finding #7): NOT IN ('stripe','credit_card')
// would miss 'card'/'Credit Card'/'visa' and over-report.
const REPORTABLE_1099_METHODS = new Set(["cash", "check", "zelle", "venmo", "ach", "wire"]);
// Card / processor-reported methods we deliberately EXCLUDE from the 1099 tally.
const CARD_1099_METHODS = new Set(["stripe", "credit_card", "card", "credit card", "debit", "debit_card", "visa", "mastercard", "amex", "discover", "paypal"]);

export type FinanceTaxSettings = {
  taxSetAsideRatePercent: number;
  mileageRateCents: number;
  form1099ThresholdCents: number;
};

export async function getFinanceTaxSettings(): Promise<FinanceTaxSettings> {
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.id, SETTINGS_ID) });
  return {
    taxSetAsideRatePercent: clampRatePercent(row?.taxSetAsideRatePercent) ?? DEFAULT_TAX_SET_ASIDE_RATE_PERCENT,
    mileageRateCents: clampPositiveInt(row?.mileageRateCents) ?? DEFAULT_MILEAGE_RATE_CENTS,
    form1099ThresholdCents: clampPositiveInt(row?.form1099ThresholdCents) ?? DEFAULT_FORM_1099_THRESHOLD_CENTS,
  };
}

function clampRatePercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.round(value), 0), 100);
}

function clampPositiveInt(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function isoFloorForDate(date: string) {
  return `${date}T00:00:00.000Z`;
}

function isoCeilingForDate(date: string) {
  return `${date}T23:59:59.999Z`;
}

// Calendar quarters for the MVP (label them; the IRS due-date quirk is UI copy, not
// encoded). Q1 Jan–Mar, Q2 Apr–Jun, Q3 Jul–Sep, Q4 Oct–Dec.
export function quarterBounds(year: number, quarter: number) {
  const q = Math.min(Math.max(Math.trunc(quarter), 1), 4);
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const fromDate = `${year}-${String(startMonth).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  const toDate = `${year}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { quarter: q, fromDate, toDate };
}

// ---------------------------------------------------------------------------
// Quarterly tax estimate (pure read over the existing ledger).
// ---------------------------------------------------------------------------

export async function getQuarterlyTaxEstimate({ year, quarter }: { year: number; quarter: number }) {
  const bounds = quarterBounds(year, quarter);
  const [settings, bookkeeping, mileage] = await Promise.all([
    getFinanceTaxSettings(),
    getBookkeepingReport({ status: "paid", fromDate: bounds.fromDate, toDate: bounds.toDate }),
    getMileageReport({ fromDate: bounds.fromDate, toDate: bounds.toDate }),
  ]);

  const netRevenueCents = bookkeeping.totals.netRevenueCents; // gross service − refunds − lost disputes
  const deductibleExpenseCents = bookkeeping.totals.taxDeductibleExpenseCents;
  const mileageDeductionCents = mileage.deductionCents;
  const estimatedNetSelfEmploymentIncomeCents = netRevenueCents - deductibleExpenseCents - mileageDeductionCents;
  const setAsideCents = Math.round(Math.max(estimatedNetSelfEmploymentIncomeCents, 0) * (settings.taxSetAsideRatePercent / 100));

  return {
    year,
    quarter: bounds.quarter,
    fromDate: bounds.fromDate,
    toDate: bounds.toDate,
    taxSetAsideRatePercent: settings.taxSetAsideRatePercent,
    netRevenueCents,
    deductibleExpenseCents,
    mileageMiles: mileage.totalMiles,
    mileageRateCents: settings.mileageRateCents,
    mileageDeductionCents,
    estimatedNetSelfEmploymentIncomeCents,
    estimatedSetAsideCents: setAsideCents,
    disclaimer: "Estimate only — not tax advice. Confirm with your accountant. Calendar quarters; note IRS estimated-tax due dates differ.",
  };
}

// ---------------------------------------------------------------------------
// 1099 vendor tracking.
// ---------------------------------------------------------------------------

export type Vendor1099Row = {
  vendorId: string;
  vendorName: string;
  legalName: string | null;
  taxIdLast4: string | null;
  is1099Tracked: boolean;
  reportableCents: number;
  cardCents: number;
  unrecognizedCents: number;
  crossesThreshold: boolean;
  missingW9: boolean;
  hasUnrecognizedMethod: boolean;
  needsReconciliation: boolean;
};

export async function get1099VendorReport({ year }: { year: number }) {
  const settings = await getFinanceTaxSettings();
  const fromDate = `${year}-01-01`;
  const toDate = `${year}-12-31`;
  const rows = await db
    .select({ expense: expenses, vendor: vendors })
    .from(expenses)
    .innerJoin(vendors, eq(expenses.vendorId, vendors.id))
    .where(and(
      eq(expenses.status, "paid"),
      gte(expenses.paidAt, isoFloorForDate(fromDate)),
      lte(expenses.paidAt, isoCeilingForDate(toDate)),
    )) as Array<{ expense: typeof expenses.$inferSelect; vendor: typeof vendors.$inferSelect }>;

  const byVendor = new Map<string, Vendor1099Row>();
  for (const row of rows) {
    const existing = byVendor.get(row.vendor.id) ?? {
      vendorId: row.vendor.id,
      vendorName: row.vendor.name,
      legalName: row.vendor.legalName,
      taxIdLast4: row.vendor.taxIdLast4,
      is1099Tracked: row.vendor.is1099Tracked,
      reportableCents: 0,
      cardCents: 0,
      unrecognizedCents: 0,
      crossesThreshold: false,
      missingW9: false,
      hasUnrecognizedMethod: false,
      needsReconciliation: false,
    };
    const method = (row.expense.paymentMethod ?? "").trim().toLowerCase();
    const amount = Math.max(row.expense.amountCents, 0);
    if (REPORTABLE_1099_METHODS.has(method)) {
      existing.reportableCents += amount;
    } else if (CARD_1099_METHODS.has(method)) {
      existing.cardCents += amount;
    } else {
      // Ambiguous/unknown method — never silently include or exclude (Fable finding #7).
      existing.unrecognizedCents += amount;
      existing.hasUnrecognizedMethod = true;
    }
    byVendor.set(row.vendor.id, existing);
  }

  const vendorsList = Array.from(byVendor.values()).map((row) => {
    const crossesThreshold = row.reportableCents >= settings.form1099ThresholdCents;
    const missingW9 = crossesThreshold && (!row.legalName || !row.taxIdLast4);
    // An unrecognized payment method on a vendor at/over threshold is a reconciliation item.
    const needsReconciliation = missingW9 || (crossesThreshold && row.hasUnrecognizedMethod);
    return { ...row, crossesThreshold, missingW9, needsReconciliation };
  }).sort((a, b) => b.reportableCents - a.reportableCents || a.vendorName.localeCompare(b.vendorName));

  return {
    year,
    thresholdCents: settings.form1099ThresholdCents,
    vendors: vendorsList,
    flaggedVendors: vendorsList.filter((row) => row.crossesThreshold),
    reconciliationCount: vendorsList.filter((row) => row.needsReconciliation).length,
  };
}

// ---------------------------------------------------------------------------
// Mileage log (deduction report + admin CRUD).
// ---------------------------------------------------------------------------

export type MileageReportInput = { year?: number | null; fromDate?: string | null; toDate?: string | null };

export async function getMileageReport(input: MileageReportInput = {}) {
  const settings = await getFinanceTaxSettings();
  const fromDate = input.fromDate ?? (input.year ? `${input.year}-01-01` : null);
  const toDate = input.toDate ?? (input.year ? `${input.year}-12-31` : null);
  const conditions = [];
  if (fromDate) conditions.push(gte(mileageLogs.tripDate, fromDate));
  if (toDate) conditions.push(lte(mileageLogs.tripDate, toDate));
  const rows = await db
    .select()
    .from(mileageLogs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(mileageLogs.tripDate)) as Array<typeof mileageLogs.$inferSelect>;

  const totalMiles = rows.reduce((sum, row) => sum + Math.max(row.miles, 0), 0);
  const deductionCents = Math.round(totalMiles * settings.mileageRateCents);
  return { fromDate, toDate, mileageRateCents: settings.mileageRateCents, totalMiles, deductionCents, rows };
}

export async function listMileageLogs(input: MileageReportInput = {}) {
  return (await getMileageReport(input)).rows;
}

function cleanText(value: string | null | undefined) {
  return value?.trim() || null;
}

function safeRevalidatePath(path: string) {
  try {
    revalidatePath(path);
  } catch {
    // Called outside a Next request store (tests / non-request contexts).
  }
}

export type MileageLogInput = {
  projectId?: string | null;
  tripDate: string;
  miles: number;
  purpose?: string | null;
  fromLocation?: string | null;
  toLocation?: string | null;
  notes?: string | null;
};

export async function createMileageLog(input: MileageLogInput) {
  const tripDate = cleanText(input.tripDate);
  if (!tripDate) throw new Error("Trip date is required.");
  const miles = Number.isFinite(input.miles) && input.miles > 0 ? input.miles : 0;
  if (!miles) throw new Error("Miles must be greater than zero.");
  const projectId = cleanText(input.projectId);
  if (projectId) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (!project) throw new Error("Project not found.");
  }
  const now = new Date().toISOString();
  const log = {
    id: crypto.randomUUID(),
    projectId,
    tripDate,
    miles,
    purpose: cleanText(input.purpose),
    fromLocation: cleanText(input.fromLocation),
    toLocation: cleanText(input.toLocation),
    notes: cleanText(input.notes),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(mileageLogs).values(log);
  safeRevalidatePath("/finance/tax");
  return log;
}

export async function updateMileageLog(id: string, input: Partial<MileageLogInput>) {
  const logId = cleanText(id);
  if (!logId) throw new Error("Mileage log id is required.");
  const existing = await db.query.mileageLogs.findFirst({ where: eq(mileageLogs.id, logId) });
  if (!existing) throw new Error("Mileage log not found.");
  const projectId = Object.prototype.hasOwnProperty.call(input, "projectId") ? cleanText(input.projectId) : existing.projectId;
  if (projectId) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (!project) throw new Error("Project not found.");
  }
  const miles = Object.prototype.hasOwnProperty.call(input, "miles")
    ? (Number.isFinite(input.miles) && (input.miles ?? 0) > 0 ? (input.miles as number) : 0)
    : existing.miles;
  if (!miles) throw new Error("Miles must be greater than zero.");
  const now = new Date().toISOString();
  await db.update(mileageLogs).set({
    projectId,
    tripDate: Object.prototype.hasOwnProperty.call(input, "tripDate") ? cleanText(input.tripDate) ?? existing.tripDate : existing.tripDate,
    miles,
    purpose: Object.prototype.hasOwnProperty.call(input, "purpose") ? cleanText(input.purpose) : existing.purpose,
    fromLocation: Object.prototype.hasOwnProperty.call(input, "fromLocation") ? cleanText(input.fromLocation) : existing.fromLocation,
    toLocation: Object.prototype.hasOwnProperty.call(input, "toLocation") ? cleanText(input.toLocation) : existing.toLocation,
    notes: Object.prototype.hasOwnProperty.call(input, "notes") ? cleanText(input.notes) : existing.notes,
    updatedAt: now,
  }).where(eq(mileageLogs.id, logId));
  safeRevalidatePath("/finance/tax");
  return { id: logId };
}

export async function deleteMileageLog(id: string) {
  const logId = cleanText(id);
  if (!logId) throw new Error("Mileage log id is required.");
  await db.delete(mileageLogs).where(eq(mileageLogs.id, logId));
  safeRevalidatePath("/finance/tax");
  return { id: logId };
}

// ---------------------------------------------------------------------------
// Vendor W-9 admin entry (store only the last 4 of the TIN — PII minimization).
// Admin-only (guarded route). Agents CANNOT write these (finance-adjacent).
// ---------------------------------------------------------------------------

export type VendorTaxInput = {
  legalName?: string | null;
  taxIdLast4?: string | null;
  taxAddress?: string | null;
  is1099Tracked?: boolean | null;
};

function normalizeTaxIdLast4(value: string | null | undefined) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.slice(-4); // NEVER store more than the last 4 of the SSN/EIN.
}

export async function updateVendorTaxInfo(vendorId: string, input: VendorTaxInput) {
  const id = cleanText(vendorId);
  if (!id) throw new Error("Vendor id is required.");
  const vendor = await db.query.vendors.findFirst({ where: eq(vendors.id, id) });
  if (!vendor) throw new Error("Vendor not found.");
  const now = new Date().toISOString();
  await db.update(vendors).set({
    legalName: Object.prototype.hasOwnProperty.call(input, "legalName") ? cleanText(input.legalName) : vendor.legalName,
    taxIdLast4: Object.prototype.hasOwnProperty.call(input, "taxIdLast4") ? normalizeTaxIdLast4(input.taxIdLast4) : vendor.taxIdLast4,
    taxAddress: Object.prototype.hasOwnProperty.call(input, "taxAddress") ? cleanText(input.taxAddress) : vendor.taxAddress,
    is1099Tracked: Object.prototype.hasOwnProperty.call(input, "is1099Tracked") ? Boolean(input.is1099Tracked) : vendor.is1099Tracked,
    updatedAt: now,
  }).where(eq(vendors.id, id));
  safeRevalidatePath("/finance/tax");
  return { vendorId: id };
}

// ---------------------------------------------------------------------------
// Finance rate settings admin update (reports-only; safe code defaults when unset).
// ---------------------------------------------------------------------------

export async function updateFinanceTaxSettings(input: Partial<FinanceTaxSettings>) {
  const now = new Date().toISOString();
  const existing = await db.query.appSettings.findFirst({ where: eq(appSettings.id, SETTINGS_ID) });
  if (!existing) throw new Error("Business settings must be configured before finance rates.");
  await db.update(appSettings).set({
    taxSetAsideRatePercent: input.taxSetAsideRatePercent != null ? clampRatePercent(input.taxSetAsideRatePercent) : existing.taxSetAsideRatePercent,
    mileageRateCents: input.mileageRateCents != null ? clampPositiveInt(input.mileageRateCents) : existing.mileageRateCents,
    form1099ThresholdCents: input.form1099ThresholdCents != null ? clampPositiveInt(input.form1099ThresholdCents) : existing.form1099ThresholdCents,
    updatedAt: now,
  }).where(eq(appSettings.id, SETTINGS_ID));
  safeRevalidatePath("/finance/tax");
  return { settingsId: SETTINGS_ID };
}

// CSV builders ---------------------------------------------------------------

function csvCell(value: string | number | boolean | null | undefined) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function centsCsv(value: number) {
  return (value / 100).toFixed(2);
}

export function taxEstimateCsv(estimate: Awaited<ReturnType<typeof getQuarterlyTaxEstimate>>) {
  const header = ["Field", "Value"];
  const rows: Array<Array<string | number>> = [
    ["Year", estimate.year],
    ["Quarter", `Q${estimate.quarter}`],
    ["Period", `${estimate.fromDate} to ${estimate.toDate}`],
    ["Net revenue", centsCsv(estimate.netRevenueCents)],
    ["Deductible expenses", centsCsv(estimate.deductibleExpenseCents)],
    ["Mileage miles", estimate.mileageMiles],
    ["Mileage deduction", centsCsv(estimate.mileageDeductionCents)],
    ["Estimated net self-employment income", centsCsv(estimate.estimatedNetSelfEmploymentIncomeCents)],
    ["Set-aside rate %", estimate.taxSetAsideRatePercent],
    ["Estimated set-aside", centsCsv(estimate.estimatedSetAsideCents)],
    ["Disclaimer", estimate.disclaimer],
  ];
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function vendor1099Csv(report: Awaited<ReturnType<typeof get1099VendorReport>>) {
  const header = ["Vendor", "Legal name", "TIN last4", "Tracked", "Reportable (non-card)", "Card", "Unrecognized", "Crosses $threshold", "Missing W-9", "Needs reconciliation"];
  const body = report.vendors.map((row) => [
    row.vendorName,
    row.legalName,
    row.taxIdLast4,
    row.is1099Tracked ? "yes" : "no",
    centsCsv(row.reportableCents),
    centsCsv(row.cardCents),
    centsCsv(row.unrecognizedCents),
    row.crossesThreshold ? "yes" : "no",
    row.missingW9 ? "yes" : "no",
    row.needsReconciliation ? "yes" : "no",
  ]);
  return [header, ...body].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function mileageCsv(report: Awaited<ReturnType<typeof getMileageReport>>) {
  const header = ["Date", "Miles", "Purpose", "From", "To", "Notes", "Project ID"];
  const body = report.rows.map((row) => [
    row.tripDate,
    row.miles,
    row.purpose,
    row.fromLocation,
    row.toLocation,
    row.notes,
    row.projectId,
  ]);
  const footer = [["Total miles", report.totalMiles, "", "", "", "", ""], ["Deduction", centsCsv(report.deductionCents), `${report.mileageRateCents}c/mi`, "", "", "", ""]];
  return [header, ...body, ...footer].map((row) => row.map(csvCell).join(",")).join("\n");
}
