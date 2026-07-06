// Phase 10 — Intelligence + forecasting. READ-ONLY derived analytics over data
// Phases 1–9a already persist. Every number is recomputed at read time from the
// existing report builders (bookkeeping, payment ledger, agent finance) and raw
// SELECTs. Nothing here is a new source of truth; nothing writes a canonical
// business row. The ONLY write is `updateIntelligenceSettings`, which touches the
// four nullable admin columns on `app_settings` and nothing else.
//
// Metric-integrity rules (spec §2): explainable models only; state the window +
// formula in `method`; label confidence + dataPoints; keep Contracted (facts)
// separate from Projected (run-rate); revenue comes ONLY from getBookkeepingReport
// (paid+refunded settled, refunds subtracted on the money-event date) — never a
// fresh `status='paid'`-only query.

import { db } from "@/db/client";
import {
  appSettings,
  clients,
  invoices,
  projectEvents,
  projectParticipants,
  projects,
  proposals,
} from "@/db/schema";
import { getAgentFinanceReport } from "@/lib/agent-finance";
import { getBookkeepingReport } from "@/lib/bookkeeping";
import { getPaymentLedgerReport } from "@/lib/sales";
import { asc, eq, inArray } from "drizzle-orm";

const SETTINGS_ID = "business";

// --- Safe code defaults (used when the app-setting column is NULL) --------------
export const DEFAULT_FORECAST_HORIZON_MONTHS = 3;
export const DEFAULT_FORECAST_TRAILING_MONTHS = 6;
export const DEFAULT_MATURATION_WINDOW_DAYS = 28;

// Booked-milestone project stages (RETAINER_STAGE_PRECEDENCE, sales.ts:92 ranks).
const BOOKED_STAGES = new Set(["retainer_paid", "planning", "editing", "delivered", "completed"]);
const SETTLED_LEDGER_STATUSES = new Set(["paid", "refunded"]);
// Inbound inquiry statuses that are NOT a real human inquiry (spec §3.2).
const EXCLUDED_INBOUND_STATUSES = new Set(["spam", "dismissed"]);

export type Confidence = "high" | "medium" | "low" | "insufficient_data";

export type IntelligenceSettings = {
  forecastHorizonMonths: number;
  forecastTrailingMonths: number;
  monthlyCapacityTarget: number | null;
  leadSourceTaxonomyJson: Record<string, unknown>;
};

export type IntelligenceInput = {
  fromDate?: string | null;
  toDate?: string | null;
  asOfDate?: string | null;
  horizonMonths?: number | null;
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function clampPositiveInt(value: number | null | undefined, min = 1): number | null {
  if (value == null || !Number.isFinite(value) || value < min) return null;
  return Math.round(value);
}

function parseTaxonomy(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export async function getIntelligenceSettings(): Promise<IntelligenceSettings> {
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.id, SETTINGS_ID) });
  return {
    forecastHorizonMonths: clampPositiveInt(row?.forecastHorizonMonths) ?? DEFAULT_FORECAST_HORIZON_MONTHS,
    forecastTrailingMonths: clampPositiveInt(row?.forecastTrailingMonths) ?? DEFAULT_FORECAST_TRAILING_MONTHS,
    // Capacity target has NO safe non-null default — "no target set" is meaningful.
    monthlyCapacityTarget: clampPositiveInt(row?.monthlyCapacityTarget),
    leadSourceTaxonomyJson: parseTaxonomy(row?.leadSourceTaxonomyJson),
  };
}

export type IntelligenceSettingsInput = {
  forecastHorizonMonths?: number | null;
  forecastTrailingMonths?: number | null;
  monthlyCapacityTarget?: number | null;
  leadSourceTaxonomyJson?: string | null;
};

// Admin-only. Called solely by the guarded settings route (§6.4). Writes ONLY the
// four app_settings columns — never a business row. Nulls a value when explicitly
// asked (empty capacity/taxonomy), otherwise clamps.
export async function updateIntelligenceSettings(input: IntelligenceSettingsInput) {
  const existing = await db.query.appSettings.findFirst({ where: eq(appSettings.id, SETTINGS_ID) });
  if (!existing) throw new Error("Business settings must be configured before intelligence settings.");

  const has = (key: keyof IntelligenceSettingsInput) => Object.prototype.hasOwnProperty.call(input, key);
  const taxonomyRaw = has("leadSourceTaxonomyJson") ? (input.leadSourceTaxonomyJson ?? "") : null;
  // Persist taxonomy only when it parses to a plain object; store the re-serialized
  // canonical form so a malformed blob is never written.
  const nextTaxonomy = has("leadSourceTaxonomyJson")
    ? (String(taxonomyRaw).trim() ? JSON.stringify(parseTaxonomy(String(taxonomyRaw))) : null)
    : existing.leadSourceTaxonomyJson;

  const now = new Date().toISOString();
  await db.update(appSettings).set({
    forecastHorizonMonths: has("forecastHorizonMonths")
      ? clampPositiveInt(input.forecastHorizonMonths)
      : existing.forecastHorizonMonths,
    forecastTrailingMonths: has("forecastTrailingMonths")
      ? clampPositiveInt(input.forecastTrailingMonths)
      : existing.forecastTrailingMonths,
    monthlyCapacityTarget: has("monthlyCapacityTarget")
      ? clampPositiveInt(input.monthlyCapacityTarget)
      : existing.monthlyCapacityTarget,
    leadSourceTaxonomyJson: nextTaxonomy,
    updatedAt: now,
  }).where(eq(appSettings.id, SETTINGS_ID));
  return { settingsId: SETTINGS_ID };
}

// ---------------------------------------------------------------------------
// Date / month helpers (all UTC YYYY-MM bucketing)
// ---------------------------------------------------------------------------

function monthKeyFromDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = value.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(key) ? key : null;
}

function monthKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseMonthKey(monthKey: string): { year: number; month: number } {
  const [year, month] = monthKey.split("-").map((part) => Number(part));
  return { year, month };
}

// Add `count` months to a "YYYY-MM" key.
function addMonths(monthKey: string, count: number): string {
  const { year, month } = parseMonthKey(monthKey);
  const base = new Date(Date.UTC(year, month - 1 + count, 1));
  return monthKeyOf(base);
}

// Calendar-date bounds (YYYY-MM-DD) for a month key — feeds getBookkeepingReport,
// which floors fromDate at T00:00 and ceils toDate at T23:59:59.999.
function monthDateBounds(monthKey: string): { fromDate: string; toDate: string } {
  const { year, month } = parseMonthKey(monthKey);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    fromDate: `${monthKey}-01`,
    toDate: `${monthKey}-${String(lastDay).padStart(2, "0")}`,
  };
}

// Defensively coerce a date-ish input: only accept a real non-empty string, else
// null. Guards every read path against hostile/non-string args (e.g. toDate:{}).
function cleanDateInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.trim().slice(0, 10);
  if (!day) return null;
  return Number.isFinite(Date.parse(`${day}T00:00:00.000Z`)) ? day : null;
}

function asOfDate(input: IntelligenceInput): string {
  return cleanDateInput(input.asOfDate) || new Date().toISOString().slice(0, 10);
}

function daysBetween(laterDate: string, earlierDate: string): number {
  const later = Date.parse(`${laterDate.slice(0, 10)}T12:00:00.000Z`);
  const earlier = Date.parse(`${earlierDate.slice(0, 10)}T12:00:00.000Z`);
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return 0;
  return Math.round((later - earlier) / 86_400_000);
}

function round(value: number): number {
  return Math.round(value);
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function confidenceForDataPoints(dataPoints: number): Confidence {
  if (dataPoints === 0) return "insufficient_data";
  if (dataPoints < 3) return "low";
  if (dataPoints < 24) return "medium";
  return "high";
}

// ---------------------------------------------------------------------------
// 3.1 Revenue forecast — Contracted (facts) vs Projected (run-rate)
// ---------------------------------------------------------------------------

export type RevenueForecastMonth = {
  month: string;
  contractedCents: number;
  projectedCents: number;
  confidence: Confidence;
  note: string | null;
};

export type RevenueForecast = {
  asOfDate: string;
  thisMonth: string;
  horizonMonths: number;
  trailingMonths: number;
  carryInCents: number;
  dataPoints: number;
  firstActivityMonth: string | null;
  baseRunRateCents: number;
  confidence: Confidence;
  note: string | null;
  months: RevenueForecastMonth[];
  method: string;
};

export async function getRevenueForecast(input: IntelligenceInput = {}): Promise<RevenueForecast> {
  const settings = await getIntelligenceSettings();
  // Cap the horizon at 240 months (20 years) so a hostile/typo'd `?horizonMonths=10000000`
  // on the admin CSV surface can't allocate a giant month array (Fable code-review #3).
  const MAX_HORIZON_MONTHS = 240;
  const horizon = Math.min(
    clampPositiveInt(input.horizonMonths) ?? settings.forecastHorizonMonths,
    MAX_HORIZON_MONTHS,
  );
  const trailingMonths = settings.forecastTrailingMonths;
  const asOf = asOfDate(input);
  const thisMonth = monthKeyOf(new Date(`${asOf}T00:00:00.000Z`));

  // Horizon month keys [thisMonth, thisMonth + horizon).
  const horizonMonths: string[] = [];
  for (let i = 0; i < horizon; i += 1) horizonMonths.push(addMonths(thisMonth, i));
  const horizonIndex = new Map(horizonMonths.map((m, i) => [m, i]));

  // (A) Contracted + carry-in: partition the openCents > 0 rows PURELY by dueDate.
  // No independent status re-filter — a refunded booking keeps openCents > 0, and a
  // status filter would break the `== totals.openCents` reconciliation invariant.
  const ledger = await getPaymentLedgerReport({ status: "all" });
  const contractedCents = horizonMonths.map(() => 0);
  let carryInCents = 0;
  let earliestSettledPaidAt: string | null = null;

  for (const row of ledger.rows) {
    if (row.openCents > 0) {
      const dueMonth = monthKeyFromDate(row.payment.dueDate);
      if (dueMonth === null || dueMonth < thisMonth) {
        carryInCents += row.openCents; // overdue OR unscheduled (NULL dueDate)
      } else {
        const idx = horizonIndex.get(dueMonth);
        if (idx !== undefined) contractedCents[idx] += row.openCents;
        // Future-beyond-horizon open rows fall in no bucket for a finite horizon;
        // they re-enter the buckets only under an unbounded horizon (reconciliation).
      }
    }
    // First real money movement (min paidAt over settled rows; refund included).
    if (SETTLED_LEDGER_STATUSES.has(row.payment.status) && row.payment.paidAt) {
      if (earliestSettledPaidAt === null || row.payment.paidAt < earliestSettledPaidAt) {
        earliestSettledPaidAt = row.payment.paidAt;
      }
    }
  }

  // (B) Statistical projection driven by dataPoints (NOT a fixed window length).
  const firstActivityMonth = monthKeyFromDate(earliestSettledPaidAt);
  const lastClosedMonth = addMonths(thisMonth, -1); // current month is not fully elapsed
  let dataPoints = 0;
  if (firstActivityMonth && firstActivityMonth <= lastClosedMonth) {
    // inclusive count of months [firstActivityMonth, lastClosedMonth], capped.
    const { year: fy, month: fm } = parseMonthKey(firstActivityMonth);
    const { year: ly, month: lm } = parseMonthKey(lastClosedMonth);
    const spanned = (ly - fy) * 12 + (lm - fm) + 1;
    dataPoints = Math.min(Math.max(spanned, 0), trailingMonths);
  }

  // history[] = netRevenueCents for the last `dataPoints` fully-elapsed months —
  // ONLY months at/after firstActivityMonth (never pad pre-activity zero months).
  const historyMonths: string[] = [];
  for (let i = dataPoints - 1; i >= 0; i -= 1) historyMonths.push(addMonths(lastClosedMonth, -i));
  const history: number[] = [];
  for (const monthKey of historyMonths) {
    const bounds = monthDateBounds(monthKey);
    const report = await getBookkeepingReport({ fromDate: bounds.fromDate, toDate: bounds.toDate });
    history.push(report.totals.netRevenueCents);
  }

  const baseRunRateCents = dataPoints > 0 ? round(mean(history)) : 0;
  const overallConfidence = confidenceForDataPoints(dataPoints);

  // Seasonal index only with >= 24 datapoints (>=2 calendar years of real months).
  const seasonalIndex = new Map<number, number>();
  if (dataPoints >= 24) {
    const byCalMonth = new Map<number, number[]>();
    historyMonths.forEach((monthKey, i) => {
      const { month } = parseMonthKey(monthKey);
      byCalMonth.set(month, [...(byCalMonth.get(month) ?? []), history[i]]);
    });
    const calMonthAvg = new Map<number, number>();
    for (const [calMonth, values] of byCalMonth) calMonthAvg.set(calMonth, mean(values));
    const overallMonthlyAvg = mean(Array.from(calMonthAvg.values()));
    if (overallMonthlyAvg !== 0) {
      for (const [calMonth, avg] of calMonthAvg) seasonalIndex.set(calMonth, avg / overallMonthlyAvg);
    }
  }

  const nonPositiveRunRate = baseRunRateCents <= 0;
  const clampUpperBound = 4 * baseRunRateCents;

  const months: RevenueForecastMonth[] = horizonMonths.map((monthKey, idx) => {
    const contracted = contractedCents[idx];
    if (dataPoints === 0) {
      return {
        month: monthKey,
        contractedCents: contracted,
        projectedCents: 0,
        confidence: "insufficient_data",
        note: "Not enough revenue history to project — showing contracted pipeline only.",
      };
    }
    if (nonPositiveRunRate) {
      // Refund-heavy trailing window → non-positive run-rate. Suppress projection
      // (never apply the standard clamp — 4× a negative base inverts the bound).
      return {
        month: monthKey,
        contractedCents: contracted,
        projectedCents: 0,
        confidence: "low",
        note: "Trailing net revenue is non-positive — projection suppressed.",
      };
    }
    const { month: calMonth } = parseMonthKey(monthKey);
    const seasonal = seasonalIndex.get(calMonth) ?? 1;
    const raw = round(baseRunRateCents * seasonal);
    const clamped = Math.min(Math.max(raw, 0), clampUpperBound);
    const wasClamped = clamped !== raw;
    return {
      month: monthKey,
      contractedCents: contracted,
      projectedCents: clamped,
      confidence: wasClamped ? "low" : overallConfidence,
      note: wasClamped ? "Projection clamped to 4× run-rate (outlier guard)." : null,
    };
  });

  const topNote = dataPoints === 0
    ? "Not enough revenue history for a statistical forecast — contracted pipeline only."
    : nonPositiveRunRate
      ? "Trailing net revenue is non-positive — projection suppressed."
      : null;

  const method = [
    `Contracted = Σ openCents of payment-ledger rows (openCents>0) due in each of the next ${horizon} month(s); carry-in = openCents rows overdue or with no due date.`,
    `Projected = trailing mean of net revenue over ${dataPoints} fully-elapsed month(s) since first settled money movement${firstActivityMonth ? ` (${firstActivityMonth})` : ""}, capped at trailing window ${trailingMonths}.`,
    dataPoints >= 24 ? "Seasonal index applied (>=24 datapoints)." : "No seasonal index (needs >=24 datapoints).",
    "Revenue uses getBookkeepingReport net revenue (paid+refunded settled, refunds subtracted on money-event date).",
  ].join(" ");

  return {
    asOfDate: asOf,
    thisMonth,
    horizonMonths: horizon,
    trailingMonths,
    carryInCents,
    dataPoints,
    firstActivityMonth,
    baseRunRateCents: nonPositiveRunRate ? Math.min(baseRunRateCents, 0) : baseRunRateCents,
    confidence: nonPositiveRunRate && dataPoints > 0 ? "low" : overallConfidence,
    note: topNote,
    months,
    method,
  };
}

// ---------------------------------------------------------------------------
// 3.2 Booking-conversion rate — key-set-union identity (NOT inquiryIdentity)
// ---------------------------------------------------------------------------

type InquiryRow = {
  kind: "project" | "booking" | "inbound";
  touchAt: string;
  keys: string[];
  // Booked contribution: a project row contributes its own booked status; a
  // booking/inbound row contributes the booked status of a referenced project.
  bookedProjectId: string | null;
};

function emailKey(email: string | null | undefined): string | null {
  const trimmed = (email ?? "").trim().toLowerCase();
  return trimmed ? `email:${trimmed}` : null;
}

class UnionFind {
  private parent: number[] = [];
  add(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

export type ConversionReport = {
  windowFromDate: string;
  windowToDate: string;
  asOfDate: string;
  totalInquiries: number;
  bookedCount: number;
  stillMaturingCount: number;
  cohortDenominator: number;
  cohortBookedCount: number;
  cohortConversionRate: number | null;
  runRateBookedInWindow: number;
  runRateRatio: number | null;
  maturationWindowDays: number;
  confidence: Confidence;
  dataPoints: number;
  showRawCountsOnly: boolean;
  method: string;
};

export async function getConversionReport(input: IntelligenceInput = {}): Promise<ConversionReport> {
  const asOf = asOfDate(input);
  const toDate = cleanDateInput(input.toDate) || asOf;
  // Default to a trailing 30-day window (matches getBusinessReview + the MCP schema's stated
  // default). A today-only default window (fromDate == toDate) makes the standalone report
  // page / conversion.csv show "no inquiries" nearly every day even when last month had a dozen
  // — misleading (Fable code-review #2).
  const fromDate = cleanDateInput(input.fromDate)
    || new Date(new Date(`${toDate}T00:00:00.000Z`).getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
  const windowFrom = fromDate;
  const windowTo = toDate;

  const inWindow = (dateValue: string | null | undefined): boolean => {
    const day = dateValue?.slice(0, 10);
    if (!day) return false;
    return day >= windowFrom && day <= windowTo;
  };

  const [projectRows, participantRows, clientRows, bookingRows, inboundRows, proposalRows] = await Promise.all([
    db.select().from(projects),
    db.select().from(projectParticipants),
    db.select().from(clients),
    db.query.schedulerBookings.findMany(),
    db.query.inboundInquiries.findMany(),
    db.select({ projectId: proposals.projectId, status: proposals.status, acceptedAt: proposals.acceptedAt, signedAt: proposals.signedAt }).from(proposals),
  ]);

  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  // Primary participant (client id) per project.
  const primaryClientIdByProject = new Map<string, string>();
  for (const participant of participantRows) {
    if (participant.isPrimaryContact && !primaryClientIdByProject.has(participant.projectId)) {
      primaryClientIdByProject.set(participant.projectId, participant.clientId);
    }
  }

  const acceptedProjectIds = new Set(
    proposalRows.filter((p) => p.status === "accepted").map((p) => p.projectId),
  );
  const bookedProjectIds = new Set<string>();
  for (const project of projectRows) {
    if (BOOKED_STAGES.has(project.stage) || acceptedProjectIds.has(project.id)) {
      bookedProjectIds.add(project.id);
    }
  }

  const rows: InquiryRow[] = [];

  for (const project of projectRows) {
    if (!inWindow(project.createdAt)) continue;
    const keys = [`project:${project.id}`];
    const primaryClientId = primaryClientIdByProject.get(project.id);
    if (primaryClientId) {
      keys.push(`client:${primaryClientId}`);
      const key = emailKey(clientById.get(primaryClientId)?.email);
      if (key) keys.push(key);
    }
    rows.push({ kind: "project", touchAt: project.createdAt, keys, bookedProjectId: project.id });
  }

  for (const booking of bookingRows) {
    if (!inWindow(booking.createdAt)) continue;
    const keys: string[] = [];
    if (booking.projectId) keys.push(`project:${booking.projectId}`);
    if (booking.clientId) keys.push(`client:${booking.clientId}`);
    const key = emailKey(booking.attendeeEmail); // NOT NULL — always present
    if (key) keys.push(key);
    rows.push({ kind: "booking", touchAt: booking.createdAt, keys, bookedProjectId: booking.projectId ?? null });
  }

  for (const inbound of inboundRows) {
    if (EXCLUDED_INBOUND_STATUSES.has(inbound.status)) continue;
    if (!inWindow(inbound.receivedAt)) continue;
    const keys: string[] = [];
    if (inbound.projectId) keys.push(`project:${inbound.projectId}`);
    const key = emailKey(inbound.parsedEmail); // nullable — only when non-empty
    if (key) keys.push(key);
    // A row with ZERO keys forms its own singleton identity (never merged).
    rows.push({ kind: "inbound", touchAt: inbound.receivedAt, keys, bookedProjectId: inbound.projectId ?? null });
  }

  // Key-set union: merge rows sharing ANY key (union-find over the key graph).
  const uf = new UnionFind();
  const nodeIndex = rows.map(() => uf.add());
  const keyToFirstRow = new Map<string, number>();
  rows.forEach((row, i) => {
    for (const key of row.keys) {
      const seen = keyToFirstRow.get(key);
      if (seen === undefined) keyToFirstRow.set(key, i);
      else uf.union(nodeIndex[seen], nodeIndex[i]);
    }
  });

  type Identity = { earliestTouch: string; booked: boolean; bookedDate: string | null };
  const identities = new Map<number, Identity>();
  rows.forEach((row, i) => {
    const root = uf.find(nodeIndex[i]);
    const existing = identities.get(root) ?? { earliestTouch: row.touchAt, booked: false, bookedDate: null };
    if (row.touchAt < existing.earliestTouch) existing.earliestTouch = row.touchAt;
    if (row.bookedProjectId && bookedProjectIds.has(row.bookedProjectId)) {
      existing.booked = true;
      // Booked date = acceptedAt (fallback first retainer paidAt is approximated
      // by the project's own booked recognition; we use acceptedAt when available).
      const proposal = proposalRows.find((p) => p.projectId === row.bookedProjectId && p.status === "accepted");
      const bookedDate = proposal?.acceptedAt ?? proposal?.signedAt ?? row.touchAt;
      if (!existing.bookedDate || bookedDate < existing.bookedDate) existing.bookedDate = bookedDate;
    }
    identities.set(root, existing);
  });

  const identityList = Array.from(identities.values());
  const totalInquiries = identityList.length;
  const bookedCount = identityList.filter((id) => id.booked).length;

  // Maturation window: default 28 days, or observed median inquiry→booked lag if a
  // handful (>=5) of booked pairs with a positive lag exist.
  const bookedLags = identityList
    .filter((id) => id.booked && id.bookedDate)
    .map((id) => daysBetween(id.bookedDate as string, id.earliestTouch))
    .filter((lag) => lag >= 0);
  const maturationWindowDays = bookedLags.length >= 5
    ? Math.max(Math.round(median(bookedLags)), 1)
    : DEFAULT_MATURATION_WINDOW_DAYS;

  // A cohort identity is "matured" only once it has aged past the maturation window. Do NOT
  // count a young-but-already-booked identity as matured (Fable code-review #1): including
  // `|| id.booked` is survivorship bias — it keeps the quick wins in the denominator while
  // excluding the young inquiries still deciding, inflating the headline rate (e.g. 6 recent
  // inquiries, 2 booked fast → a false "100% (2/2 matured)"). §3.2: young cohorts are excluded
  // from the headline rate, full stop.
  let cohortDenominator = 0;
  let cohortBookedCount = 0;
  let stillMaturingCount = 0;
  let runRateBookedInWindow = 0;
  for (const id of identityList) {
    const age = daysBetween(asOf, id.earliestTouch);
    const matured = age >= maturationWindowDays;
    if (matured) {
      cohortDenominator += 1;
      if (id.booked) cohortBookedCount += 1;
    } else {
      stillMaturingCount += 1;
    }
    if (id.booked && id.bookedDate && inWindow(id.bookedDate)) runRateBookedInWindow += 1;
  }

  const cohortConversionRate = cohortDenominator > 0 ? cohortBookedCount / cohortDenominator : null;
  const runRateRatio = totalInquiries > 0 ? runRateBookedInWindow / totalInquiries : null;

  const confidence: Confidence = totalInquiries === 0
    ? "insufficient_data"
    : totalInquiries < 5
      ? "low"
      : "medium";
  const showRawCountsOnly = totalInquiries > 0 && totalInquiries < 5;

  const method = [
    `Inquiries = distinct key-set-union identities (project/client/email keys; blank email emits no key; zero-key rows are singletons) first-touched in ${windowFrom}..${windowTo}.`,
    `Booked = identity shares a key with a project at an accepted proposal or a booked stage.`,
    `Cohort conversion excludes identities younger than the maturation window (${maturationWindowDays} days${bookedLags.length >= 5 ? ", observed median lag" : ", default"}).`,
    `Run-rate ratio = bookings dated in window / inquiries first-touched in window (mixes cohorts).`,
  ].join(" ");

  return {
    windowFromDate: windowFrom,
    windowToDate: windowTo,
    asOfDate: asOf,
    totalInquiries,
    bookedCount,
    stillMaturingCount,
    cohortDenominator,
    cohortBookedCount,
    cohortConversionRate,
    runRateBookedInWindow,
    runRateRatio,
    maturationWindowDays,
    confidence,
    dataPoints: totalInquiries,
    showRawCountsOnly,
    method,
  };
}

// ---------------------------------------------------------------------------
// Shared: booked contract value per project (accepted-invoice-total picker, §3.4)
// ---------------------------------------------------------------------------

type BookedProposalValue = {
  projectId: string;
  proposalId: string;
  acceptedAt: string | null;
  bookedContractCents: number;
  estimated: boolean;
};

async function loadAcceptedProposalValues(): Promise<BookedProposalValue[]> {
  const acceptedProposals = await db
    .select({ id: proposals.id, projectId: proposals.projectId, acceptedAt: proposals.acceptedAt, signedAt: proposals.signedAt, totalCents: proposals.totalCents })
    .from(proposals)
    .where(eq(proposals.status, "accepted"));
  if (!acceptedProposals.length) return [];

  const proposalIds = acceptedProposals.map((p) => p.id);
  const linkedInvoices = await db
    .select({ id: invoices.id, proposalId: invoices.proposalId, totalCents: invoices.totalCents, createdAt: invoices.createdAt })
    .from(invoices)
    .where(inArray(invoices.proposalId, proposalIds))
    .orderBy(asc(invoices.createdAt), asc(invoices.id));

  // Earliest-created linked invoice per proposal (order by createdAt asc, id asc).
  const earliestInvoiceByProposal = new Map<string, { totalCents: number }>();
  for (const invoice of linkedInvoices) {
    if (!invoice.proposalId) continue;
    if (!earliestInvoiceByProposal.has(invoice.proposalId)) {
      earliestInvoiceByProposal.set(invoice.proposalId, { totalCents: invoice.totalCents });
    }
  }

  return acceptedProposals.map((proposal) => {
    const linked = earliestInvoiceByProposal.get(proposal.id);
    const estimated = !linked;
    const bookedContractCents = linked ? linked.totalCents : (proposal.totalCents ?? 0);
    return {
      projectId: proposal.projectId,
      proposalId: proposal.id,
      acceptedAt: proposal.acceptedAt ?? proposal.signedAt ?? null,
      bookedContractCents,
      estimated,
    };
  });
}

// ---------------------------------------------------------------------------
// 3.3 Lead-source performance (NOT ROI — no spend data)
// ---------------------------------------------------------------------------

export type LeadSourceBucket = {
  source: string;
  projectCount: number;
  bookedCount: number;
  netCollectedCents: number;
  collectedProfitCents: number;
  avgPackageValueCents: number;
  sparse: boolean;
};

export type LeadSourcePerformance = {
  buckets: LeadSourceBucket[];
  totalProjects: number;
  unknownProjectCount: number;
  unknownBannerFlag: boolean;
  confidence: Confidence;
  dataPoints: number;
  method: string;
};

function titleCase(value: string): string {
  return value.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function normalizeSourceBucket(referralSource: string | null | undefined, taxonomy: Record<string, unknown>): string {
  const raw = (referralSource ?? "").trim();
  if (!raw) return "Unknown";
  const mapped = taxonomy[raw.toLowerCase()];
  if (typeof mapped === "string" && mapped.trim()) return mapped.trim();
  if (mapped && typeof mapped === "object" && typeof (mapped as { label?: unknown }).label === "string") {
    const label = (mapped as { label: string }).label.trim();
    if (label) return label;
  }
  return titleCase(raw);
}

export async function getLeadSourcePerformance(input: IntelligenceInput = {}): Promise<LeadSourcePerformance> {
  const settings = await getIntelligenceSettings();
  const [projectRows, participantRows, clientRows, ledger, financeReport, bookedValues] = await Promise.all([
    db.select().from(projects),
    db.select().from(projectParticipants),
    db.select().from(clients),
    getPaymentLedgerReport({ status: "all", fromDate: input.fromDate, toDate: input.toDate }),
    getAgentFinanceReport({ fromDate: input.fromDate, toDate: input.toDate }),
    loadAcceptedProposalValues(),
  ]);

  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const primaryClientIdByProject = new Map<string, string>();
  for (const participant of participantRows) {
    if (participant.isPrimaryContact && !primaryClientIdByProject.has(participant.projectId)) {
      primaryClientIdByProject.set(participant.projectId, participant.clientId);
    }
  }

  // Booked status per project (accepted proposal or booked stage).
  const bookedProjectIds = new Set(bookedValues.map((value) => value.projectId));
  for (const project of projectRows) {
    if (BOOKED_STAGES.has(project.stage)) bookedProjectIds.add(project.id);
  }
  const bookedValueByProject = new Map<string, number>();
  for (const value of bookedValues) {
    // Prefer the earliest accepted proposal's booked value per project.
    if (!bookedValueByProject.has(value.projectId)) bookedValueByProject.set(value.projectId, value.bookedContractCents);
  }

  // Source bucket per project.
  const bucketByProject = new Map<string, string>();
  for (const project of projectRows) {
    const primaryClientId = primaryClientIdByProject.get(project.id);
    const referralSource = primaryClientId ? clientById.get(primaryClientId)?.referralSource : null;
    // No primary participant, or participant with no client row → Unknown.
    bucketByProject.set(project.id, primaryClientId && clientById.has(primaryClientId)
      ? normalizeSourceBucket(referralSource, settings.leadSourceTaxonomyJson)
      : "Unknown");
  }

  // Paid expense per project (from agent finance project financials).
  const paidExpenseByProject = new Map<string, number>();
  for (const statement of financeReport.projectFinancials) {
    paidExpenseByProject.set(statement.projectId, statement.paidExpenseCents);
  }

  type Acc = {
    source: string;
    projectIds: Set<string>;
    bookedProjectIds: Set<string>;
    netCollectedCents: number;
    bookedValues: number[];
  };
  const bySource = new Map<string, Acc>();
  const ensure = (source: string): Acc => {
    const existing = bySource.get(source);
    if (existing) return existing;
    const acc: Acc = { source, projectIds: new Set(), bookedProjectIds: new Set(), netCollectedCents: 0, bookedValues: [] };
    bySource.set(source, acc);
    return acc;
  };
  // Always render Unknown, even at 0.
  ensure("Unknown");

  for (const project of projectRows) {
    const source = bucketByProject.get(project.id) ?? "Unknown";
    const acc = ensure(source);
    acc.projectIds.add(project.id);
    if (bookedProjectIds.has(project.id)) {
      acc.bookedProjectIds.add(project.id);
      const value = bookedValueByProject.get(project.id);
      if (value != null) acc.bookedValues.push(value);
    }
  }

  // netCollectedCents = Σ per-ledger-row refund-adjusted netCollectedCents, grouped
  // by project → primary participant → referralSource. This is the ONLY figure that
  // respects refunds (a fully-refunded booking contributes $0 to its source).
  const paidExpenseBySource = new Map<string, number>();
  for (const row of ledger.rows) {
    const source = bucketByProject.get(row.project.id) ?? "Unknown";
    ensure(source).netCollectedCents += row.netCollectedCents;
  }
  for (const [projectId, paidExpense] of paidExpenseByProject) {
    const source = bucketByProject.get(projectId) ?? "Unknown";
    paidExpenseBySource.set(source, (paidExpenseBySource.get(source) ?? 0) + paidExpense);
  }

  const totalProjects = projectRows.length;
  const buckets: LeadSourceBucket[] = Array.from(bySource.values()).map((acc) => ({
    source: acc.source,
    projectCount: acc.projectIds.size,
    bookedCount: acc.bookedProjectIds.size,
    netCollectedCents: acc.netCollectedCents,
    collectedProfitCents: acc.netCollectedCents - (paidExpenseBySource.get(acc.source) ?? 0),
    avgPackageValueCents: acc.bookedValues.length ? round(mean(acc.bookedValues)) : 0,
    sparse: acc.projectIds.size < 3,
  })).sort((a, b) => b.netCollectedCents - a.netCollectedCents || a.source.localeCompare(b.source));

  const unknownBucket = buckets.find((bucket) => bucket.source === "Unknown");
  const unknownProjectCount = unknownBucket?.projectCount ?? 0;
  const unknownBannerFlag = totalProjects > 0 && unknownProjectCount / totalProjects >= 0.5;

  return {
    buckets,
    totalProjects,
    unknownProjectCount,
    unknownBannerFlag,
    confidence: totalProjects === 0 ? "insufficient_data" : totalProjects < 3 ? "low" : "medium",
    dataPoints: totalProjects,
    method: "Revenue-per-source (NO cost data — not ROI). Source = primary contact referralSource, normalized via taxonomy; blank/no-primary → Unknown. netCollectedCents = Σ per-ledger-row refund-adjusted net (fully-refunded booking = $0). collectedProfit = net − paid project expenses.",
  };
}

// ---------------------------------------------------------------------------
// 3.4 Average-package-value trend
// ---------------------------------------------------------------------------

export type PackageValueMonth = {
  month: string;
  bookingCount: number;
  values: number[];
  avgPackageValueCents: number;
  thin: boolean;
};

export type PackageValueTrend = {
  months: PackageValueMonth[];
  totalBookings: number;
  firstMonthAvgCents: number | null;
  lastMonthAvgCents: number | null;
  deltaCents: number | null;
  percentChange: number | null;
  confidence: Confidence;
  dataPoints: number;
  method: string;
};

export async function getPackageValueTrend(input: IntelligenceInput = {}): Promise<PackageValueTrend> {
  const settings = await getIntelligenceSettings();
  const asOf = asOfDate(input);
  const thisMonth = monthKeyOf(new Date(`${asOf}T00:00:00.000Z`));
  const trailingMonths = settings.forecastTrailingMonths;

  // Trailing window of booking months ending at the current month (inclusive).
  const windowMonths: string[] = [];
  for (let i = trailingMonths - 1; i >= 0; i -= 1) windowMonths.push(addMonths(thisMonth, -i));
  const windowSet = new Set(windowMonths);

  const bookedValues = await loadAcceptedProposalValues();
  const valuesByMonth = new Map<string, number[]>();
  let totalBookings = 0;
  for (const value of bookedValues) {
    const monthKey = monthKeyFromDate(value.acceptedAt);
    if (!monthKey || !windowSet.has(monthKey)) continue;
    valuesByMonth.set(monthKey, [...(valuesByMonth.get(monthKey) ?? []), value.bookedContractCents]);
    totalBookings += 1;
  }

  const months: PackageValueMonth[] = windowMonths.map((monthKey) => {
    const values = valuesByMonth.get(monthKey) ?? [];
    return {
      month: monthKey,
      bookingCount: values.length,
      values,
      avgPackageValueCents: values.length ? round(mean(values)) : 0,
      thin: values.length < 2, // a month with <2 bookings shows raw value(s), not a "mean"
    };
  });

  const populated = months.filter((month) => month.bookingCount > 0);
  const firstMonthAvgCents = populated.length ? populated[0].avgPackageValueCents : null;
  const lastMonthAvgCents = populated.length ? populated[populated.length - 1].avgPackageValueCents : null;
  const suppressTrend = totalBookings < 3;
  const deltaCents = suppressTrend || firstMonthAvgCents == null || lastMonthAvgCents == null
    ? null
    : lastMonthAvgCents - firstMonthAvgCents;
  const percentChange = deltaCents == null || firstMonthAvgCents === 0 || firstMonthAvgCents == null
    ? null
    : deltaCents / firstMonthAvgCents;

  return {
    months,
    totalBookings,
    firstMonthAvgCents,
    lastMonthAvgCents,
    deltaCents,
    percentChange,
    confidence: totalBookings === 0 ? "insufficient_data" : suppressTrend ? "low" : "medium",
    dataPoints: totalBookings,
    method: `Booked value = earliest-created linked invoice total for each accepted proposal (fallback proposals.totalCents, flagged estimated); never summed across a proposal's invoices. Bucketed by acceptedAt over trailing ${trailingMonths} month(s). Months with <2 bookings shown raw (thin); <3 total suppresses the % trend.`,
  };
}

// ---------------------------------------------------------------------------
// 3.5 Seasonal capacity — shootable events (calls excluded)
// ---------------------------------------------------------------------------

export type SeasonalMonth = { month: string; count: number };
export type CalendarMonthStat = { calendarMonth: number; avgEvents: number; seasonalIndex: number | null };
export type UtilizationMonth = { month: string; count: number; utilization: number | null; overCapacity: boolean };

export type SeasonalCapacity = {
  eventsByMonth: SeasonalMonth[];
  calendarMonths: CalendarMonthStat[];
  utilization: UtilizationMonth[];
  monthlyCapacityTarget: number | null;
  peakCalendarMonths: number[];
  yearsOfData: number;
  seasonalIndexAvailable: boolean;
  confidence: Confidence;
  dataPoints: number;
  method: string;
};

export async function getSeasonalCapacity(input: IntelligenceInput = {}): Promise<SeasonalCapacity> {
  const settings = await getIntelligenceSettings();
  const asOf = asOfDate(input);
  const thisMonth = monthKeyOf(new Date(`${asOf}T00:00:00.000Z`));

  // Count ALL project_events with an eventDate in a month (rehearsal included; NO
  // type filter). Calls live only in scheduler_bookings — already excluded here.
  const eventRows = await db.select({ eventDate: projectEvents.eventDate }).from(projectEvents);
  const countByMonth = new Map<string, number>();
  const yearsWithData = new Set<number>();
  for (const row of eventRows) {
    const monthKey = monthKeyFromDate(row.eventDate);
    if (!monthKey) continue;
    countByMonth.set(monthKey, (countByMonth.get(monthKey) ?? 0) + 1);
    yearsWithData.add(parseMonthKey(monthKey).year);
  }

  const eventsByMonth: SeasonalMonth[] = Array.from(countByMonth.entries())
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Honest gate (Fable code-review #5): a seasonal index needs a genuine multi-year SPAN, not
  // just two calendar-year labels. Dec-2025 + Jan-2026 touches 2 distinct years but is 2 months
  // of data — presenting a "2+ years" seasonal index off that is the cold-start dishonesty this
  // phase forbids. Require ≥2 distinct years AND ≥12 months between the earliest and latest
  // populated month.
  const yearsOfData = yearsWithData.size;
  const monthSpan = eventsByMonth.length >= 2
    ? (() => {
        const first = parseMonthKey(eventsByMonth[0].month);
        const last = parseMonthKey(eventsByMonth[eventsByMonth.length - 1].month);
        return (last.year - first.year) * 12 + (last.month - first.month);
      })()
    : 0;
  const seasonalIndexAvailable = yearsOfData >= 2 && monthSpan >= 12;

  // Calendar-month averages across years with data.
  const byCalendarMonth = new Map<number, number[]>();
  for (const [monthKey, count] of countByMonth) {
    const { month } = parseMonthKey(monthKey);
    byCalendarMonth.set(month, [...(byCalendarMonth.get(month) ?? []), count]);
  }
  const calMonthAvg = new Map<number, number>();
  for (let m = 1; m <= 12; m += 1) calMonthAvg.set(m, mean(byCalendarMonth.get(m) ?? []));
  const overallAvg = mean(Array.from(calMonthAvg.values()));

  const calendarMonths: CalendarMonthStat[] = [];
  for (let m = 1; m <= 12; m += 1) {
    const avg = calMonthAvg.get(m) ?? 0;
    calendarMonths.push({
      calendarMonth: m,
      avgEvents: avg,
      seasonalIndex: seasonalIndexAvailable && overallAvg !== 0 ? avg / overallAvg : null,
    });
  }

  const peakCalendarMonths = seasonalIndexAvailable
    ? calendarMonths.filter((c) => (c.seasonalIndex ?? 0) > 1).map((c) => c.calendarMonth)
    : [];

  // Utilization vs target for the current + next 11 months (only when target set).
  const target = settings.monthlyCapacityTarget;
  const utilization: UtilizationMonth[] = [];
  for (let i = 0; i < 12; i += 1) {
    const monthKey = addMonths(thisMonth, i);
    const count = countByMonth.get(monthKey) ?? 0;
    utilization.push({
      month: monthKey,
      count,
      utilization: target ? count / target : null,
      overCapacity: target ? count > target : false,
    });
  }

  return {
    eventsByMonth,
    calendarMonths,
    utilization,
    monthlyCapacityTarget: target,
    peakCalendarMonths,
    yearsOfData,
    seasonalIndexAvailable,
    confidence: seasonalIndexAvailable ? "medium" : "insufficient_data",
    dataPoints: eventRows.length,
    method: `Shootable events = count of ALL project_events by eventDate month (rehearsal included; calls in scheduler_bookings excluded). Seasonal index needs >=2 calendar years (${yearsOfData} present). ${target ? `Utilization = events / monthly target ${target}.` : "No capacity target set — counts only."}`,
  };
}

// ---------------------------------------------------------------------------
// 4. Weekly "state of the business" review — aggregator + headlines[]
// ---------------------------------------------------------------------------

export type BusinessReview = {
  period: { fromDate: string; toDate: string; asOfDate: string };
  netRevenueCents: number;
  priorNetRevenueCents: number;
  netRevenueChangePercent: number | null;
  revenueForecast: RevenueForecast;
  conversion: ConversionReport;
  leadSource: LeadSourcePerformance;
  packageValue: PackageValueTrend;
  seasonalCapacity: SeasonalCapacity;
  headlines: string[];
  method: string;
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export async function getBusinessReview(input: IntelligenceInput = {}): Promise<BusinessReview> {
  const asOf = asOfDate(input);
  const toDate = cleanDateInput(input.toDate) || asOf;
  const fromDate = cleanDateInput(input.fromDate) || new Date(new Date(`${toDate}T00:00:00.000Z`).getTime() - 29 * 86_400_000).toISOString().slice(0, 10);

  // Prior period of equal length immediately before [fromDate, toDate].
  const periodDays = Math.max(daysBetween(toDate, fromDate) + 1, 1);
  const priorToDate = new Date(new Date(`${fromDate}T00:00:00.000Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const priorFromDate = new Date(new Date(`${priorToDate}T00:00:00.000Z`).getTime() - (periodDays - 1) * 86_400_000).toISOString().slice(0, 10);

  const [current, prior, revenueForecast, conversion, leadSource, packageValue, seasonalCapacity] = await Promise.all([
    getBookkeepingReport({ fromDate, toDate }),
    getBookkeepingReport({ fromDate: priorFromDate, toDate: priorToDate }),
    getRevenueForecast({ asOfDate: asOf }),
    getConversionReport({ fromDate, toDate, asOfDate: asOf }),
    getLeadSourcePerformance({}),
    getPackageValueTrend({ asOfDate: asOf }),
    getSeasonalCapacity({ asOfDate: asOf }),
  ]);

  const netRevenueCents = current.totals.netRevenueCents;
  const priorNetRevenueCents = prior.totals.netRevenueCents;
  const netRevenueChangePercent = priorNetRevenueCents !== 0
    ? (netRevenueCents - priorNetRevenueCents) / Math.abs(priorNetRevenueCents)
    : null;

  const headlines: string[] = [];
  headlines.push(
    netRevenueChangePercent == null
      ? `Net revenue ${formatCents(netRevenueCents)} (${fromDate}..${toDate}); no prior-period baseline.`
      : `Net revenue ${formatCents(netRevenueCents)}, ${netRevenueChangePercent >= 0 ? "+" : ""}${Math.round(netRevenueChangePercent * 100)}% vs prior ${periodDays}-day period.`,
  );
  headlines.push(
    conversion.totalInquiries === 0
      ? "No inquiries in the review window."
      : conversion.showRawCountsOnly
        ? `Conversion ${conversion.cohortBookedCount} of ${conversion.cohortDenominator} booked (low sample).`
        : `Conversion ${conversion.cohortConversionRate != null ? `${Math.round(conversion.cohortConversionRate * 100)}%` : "n/a"} (${conversion.cohortBookedCount}/${conversion.cohortDenominator} matured cohort).`,
  );
  headlines.push(
    revenueForecast.dataPoints === 0
      ? `Contracted pipeline ${formatCents(revenueForecast.months.reduce((sum, m) => sum + m.contractedCents, 0))} — not enough history to project.`
      : `Projected run-rate ${formatCents(revenueForecast.baseRunRateCents)}/mo (${revenueForecast.confidence}, ${revenueForecast.dataPoints} datapoints); carry-in ${formatCents(revenueForecast.carryInCents)}.`,
  );
  if (seasonalCapacity.seasonalIndexAvailable && seasonalCapacity.peakCalendarMonths.length) {
    const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    headlines.push(`Peak season: ${seasonalCapacity.peakCalendarMonths.map((m) => monthNames[m]).join(", ")}.`);
  }
  if (leadSource.unknownBannerFlag) {
    headlines.push(`Lead source unknown for ${leadSource.unknownProjectCount} of ${leadSource.totalProjects} projects — capture referral source.`);
  }

  return {
    period: { fromDate, toDate, asOfDate: asOf },
    netRevenueCents,
    priorNetRevenueCents,
    netRevenueChangePercent,
    revenueForecast,
    conversion,
    leadSource,
    packageValue,
    seasonalCapacity,
    headlines,
    method: "Aggregates §3.1–3.5 for the requested period + trailing context. Read-only; the agent composes prose from this JSON. Net revenue via getBookkeepingReport (paid+refunded settled, refunds subtracted on money-event date).",
  };
}

// ---------------------------------------------------------------------------
// CSV builders (csvCell/centsCsv copied from bookkeeping.ts:667)
// ---------------------------------------------------------------------------

function csvCell(value: string | number | boolean | null | undefined) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function centsCsv(value: number) {
  return (value / 100).toFixed(2);
}

function csvJoin(rows: Array<Array<string | number | boolean | null | undefined>>) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

export function revenueForecastCsv(forecast: RevenueForecast) {
  const header = ["Month", "Contracted", "Projected", "Confidence", "Note"];
  const body = forecast.months.map((month) => [
    month.month,
    centsCsv(month.contractedCents),
    centsCsv(month.projectedCents),
    month.confidence,
    month.note,
  ]);
  const footer: Array<Array<string | number | boolean | null | undefined>> = [
    [],
    ["Carry-in (overdue + unscheduled)", centsCsv(forecast.carryInCents), "", "", ""],
    ["Run-rate", centsCsv(forecast.baseRunRateCents), "", forecast.confidence, `${forecast.dataPoints} datapoints`],
    ["Method", forecast.method, "", "", ""],
  ];
  return csvJoin([header, ...body, ...footer]);
}

export function conversionCsv(report: ConversionReport) {
  const header = ["Field", "Value"];
  const rows: Array<Array<string | number | boolean | null | undefined>> = [
    ["Window", `${report.windowFromDate} to ${report.windowToDate}`],
    ["Total inquiries", report.totalInquiries],
    ["Booked", report.bookedCount],
    ["Still maturing", report.stillMaturingCount],
    ["Matured cohort denominator", report.cohortDenominator],
    ["Cohort booked", report.cohortBookedCount],
    ["Cohort conversion rate", report.cohortConversionRate == null ? "n/a" : `${(report.cohortConversionRate * 100).toFixed(1)}%`],
    ["Run-rate booked in window", report.runRateBookedInWindow],
    ["Run-rate ratio", report.runRateRatio == null ? "n/a" : `${(report.runRateRatio * 100).toFixed(1)}%`],
    ["Maturation window (days)", report.maturationWindowDays],
    ["Confidence", report.confidence],
    ["Method", report.method],
  ];
  return csvJoin([header, ...rows]);
}

export function leadSourceCsv(report: LeadSourcePerformance) {
  const header = ["Source", "Projects", "Booked", "Net collected", "Collected profit", "Avg package value", "Sparse"];
  const body = report.buckets.map((bucket) => [
    bucket.source,
    bucket.projectCount,
    bucket.bookedCount,
    centsCsv(bucket.netCollectedCents),
    centsCsv(bucket.collectedProfitCents),
    centsCsv(bucket.avgPackageValueCents),
    bucket.sparse ? "yes" : "no",
  ]);
  const footer: Array<Array<string | number | boolean | null | undefined>> = [
    [],
    ["Unknown share", `${report.unknownProjectCount}/${report.totalProjects}`, report.unknownBannerFlag ? "banner" : "", "", "", "", ""],
    ["Confidence", report.confidence, "", "", "", "", ""],
    ["Method", report.method, "", "", "", "", ""],
  ];
  return csvJoin([header, ...body, ...footer]);
}

export function packageValueCsv(report: PackageValueTrend) {
  const header = ["Month", "Bookings", "Avg package value", "Thin", "Values"];
  const body = report.months.map((month) => [
    month.month,
    month.bookingCount,
    centsCsv(month.avgPackageValueCents),
    month.thin ? "yes" : "no",
    month.values.map((value) => centsCsv(value)).join(" | "),
  ]);
  const footer: Array<Array<string | number | boolean | null | undefined>> = [
    [],
    ["Total bookings", report.totalBookings, "", "", ""],
    ["First vs last delta", report.deltaCents == null ? "n/a" : centsCsv(report.deltaCents), report.percentChange == null ? "n/a" : `${(report.percentChange * 100).toFixed(1)}%`, "", ""],
    ["Confidence", report.confidence, "", "", ""],
    ["Method", report.method, "", "", ""],
  ];
  return csvJoin([header, ...body, ...footer]);
}

export function seasonalCapacityCsv(report: SeasonalCapacity) {
  const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const header = ["Calendar month", "Avg events", "Seasonal index"];
  const body = report.calendarMonths.map((stat) => [
    monthNames[stat.calendarMonth],
    stat.avgEvents.toFixed(2),
    stat.seasonalIndex == null ? "n/a" : stat.seasonalIndex.toFixed(2),
  ]);
  const utilizationRows = report.utilization.map((month) => [
    month.month,
    month.count,
    month.utilization == null ? "n/a" : month.utilization.toFixed(2),
  ]);
  const footer: Array<Array<string | number | boolean | null | undefined>> = [
    [],
    ["Upcoming month", "Events", "Utilization"],
    ...utilizationRows,
    [],
    ["Years of data", report.yearsOfData, ""],
    ["Confidence", report.confidence, ""],
    ["Method", report.method, ""],
  ];
  return csvJoin([header, ...body, ...footer]);
}
