import { AppShell } from "@/components/AppShell";
import { formatMoney } from "@/lib/format";
import {
  getConversionReport,
  getIntelligenceSettings,
  getLeadSourcePerformance,
  getPackageValueTrend,
  getRevenueForecast,
  getSeasonalCapacity,
  type Confidence,
} from "@/lib/intelligence";
import { Download } from "lucide-react";

export const dynamic = "force-dynamic";

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const label = confidence.replace("_", " ");
  const tone =
    confidence === "high" ? "bg-emerald-100 text-emerald-700"
      : confidence === "medium" ? "bg-blue-100 text-blue-700"
        : confidence === "low" ? "bg-amber-100 text-amber-700"
          : "bg-neutral-200 text-neutral-600";
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}

export default async function FinanceIntelligencePage() {
  const [forecast, conversion, leadSource, packageValue, seasonal, settings] = await Promise.all([
    getRevenueForecast({}),
    getConversionReport({}),
    getLeadSourcePerformance({}),
    getPackageValueTrend({}),
    getSeasonalCapacity({}),
    getIntelligenceSettings(),
  ]);

  return (
    <AppShell>
      <div className="space-y-8">
        <header className="flex flex-col justify-between gap-3 border-b border-neutral-200 pb-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-3xl font-semibold">Intelligence &amp; forecasting</h1>
            <p className="mt-1 text-neutral-500">Derived analytics — every number is recomputed at read time. Facts (contracted) are kept separate from projections (run-rate).</p>
          </div>
          <nav className="flex gap-3 text-sm text-blue-600">
            <a href="/finance">Finance</a>
            <a href="/finance/tax">Tax &amp; 1099</a>
          </nav>
        </header>

        {/* Revenue forecast */}
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Revenue forecast</h2>
              <ConfidenceBadge confidence={forecast.confidence} />
            </div>
            <a className="inline-flex items-center gap-1 text-sm text-blue-600" href="/api/finance/revenue-forecast.csv">
              <Download className="h-4 w-4" /> CSV
            </a>
          </div>
          <p className="mt-1 text-sm">
            Carry-in (overdue + unscheduled receivables): <strong>{formatMoney(forecast.carryInCents)}</strong>
            {" · "}Run-rate: <strong>{formatMoney(forecast.baseRunRateCents)}</strong>/mo ({forecast.dataPoints} datapoints)
          </p>
          {forecast.note && <p className="mt-1 text-sm text-amber-600">{forecast.note}</p>}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-neutral-500"><tr><th className="py-1">Month</th><th>Contracted (facts)</th><th>Projected (run-rate)</th><th>Confidence</th><th>Note</th></tr></thead>
              <tbody>
                {forecast.months.map((month) => (
                  <tr key={month.month} className="border-t border-neutral-100">
                    <td className="py-2">{month.month}</td>
                    <td>{formatMoney(month.contractedCents)}</td>
                    <td>{formatMoney(month.projectedCents)}</td>
                    <td><ConfidenceBadge confidence={month.confidence} /></td>
                    <td className="text-xs text-neutral-500">{month.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-neutral-500">{forecast.method}</p>
        </section>

        {/* Conversion */}
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Booking conversion</h2>
              <ConfidenceBadge confidence={conversion.confidence} />
            </div>
            <a className="inline-flex items-center gap-1 text-sm text-blue-600" href="/api/finance/conversion.csv">
              <Download className="h-4 w-4" /> CSV
            </a>
          </div>
          <p className="mt-2 text-sm">
            {conversion.totalInquiries === 0
              ? "No inquiries in the window."
              : conversion.showRawCountsOnly
                ? `${conversion.cohortBookedCount} of ${conversion.cohortDenominator} booked (low sample — raw counts).`
                : `Cohort conversion ${conversion.cohortConversionRate != null ? `${Math.round(conversion.cohortConversionRate * 100)}%` : "n/a"} (${conversion.cohortBookedCount}/${conversion.cohortDenominator} matured). Still maturing: ${conversion.stillMaturingCount}.`}
          </p>
          <p className="mt-1 text-xs text-neutral-500">{conversion.method}</p>
        </section>

        {/* Lead source */}
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Lead-source performance</h2>
              <ConfidenceBadge confidence={leadSource.confidence} />
            </div>
            <a className="inline-flex items-center gap-1 text-sm text-blue-600" href="/api/finance/lead-source.csv">
              <Download className="h-4 w-4" /> CSV
            </a>
          </div>
          {leadSource.unknownBannerFlag && (
            <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-700">
              Lead source is unknown for {leadSource.unknownProjectCount} of {leadSource.totalProjects} projects — capture referral source to improve this report.
            </p>
          )}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-neutral-500"><tr><th className="py-1">Source</th><th>Projects</th><th>Booked</th><th>Net collected</th><th>Collected profit</th><th>Avg package</th></tr></thead>
              <tbody>
                {leadSource.buckets.map((bucket) => (
                  <tr key={bucket.source} className="border-t border-neutral-100">
                    <td className="py-2">{bucket.source}{bucket.sparse ? <span className="ml-1 text-xs text-neutral-400">(sparse)</span> : null}</td>
                    <td>{bucket.projectCount}</td>
                    <td>{bucket.bookedCount}</td>
                    <td>{formatMoney(bucket.netCollectedCents)}</td>
                    <td>{formatMoney(bucket.collectedProfitCents)}</td>
                    <td>{formatMoney(bucket.avgPackageValueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-neutral-500">{leadSource.method}</p>
        </section>

        {/* Package value */}
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Average package value</h2>
              <ConfidenceBadge confidence={packageValue.confidence} />
            </div>
            <a className="inline-flex items-center gap-1 text-sm text-blue-600" href="/api/finance/package-value.csv">
              <Download className="h-4 w-4" /> CSV
            </a>
          </div>
          <p className="mt-2 text-sm">
            {packageValue.totalBookings} booking{packageValue.totalBookings === 1 ? "" : "s"} in window.
            {packageValue.deltaCents != null && ` First-vs-last delta ${formatMoney(packageValue.deltaCents)} (${packageValue.percentChange != null ? `${Math.round(packageValue.percentChange * 100)}%` : "n/a"}).`}
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-neutral-500"><tr><th className="py-1">Month</th><th>Bookings</th><th>Avg / raw</th></tr></thead>
              <tbody>
                {packageValue.months.map((month) => (
                  <tr key={month.month} className="border-t border-neutral-100">
                    <td className="py-2">{month.month}</td>
                    <td>{month.bookingCount}</td>
                    <td>{month.thin ? month.values.map((value) => formatMoney(value)).join(", ") || "—" : formatMoney(month.avgPackageValueCents)}{month.thin && month.bookingCount > 0 ? <span className="ml-1 text-xs text-neutral-400">(thin)</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-neutral-500">{packageValue.method}</p>
        </section>

        {/* Seasonal capacity */}
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Seasonal capacity</h2>
              <ConfidenceBadge confidence={seasonal.confidence} />
            </div>
            <a className="inline-flex items-center gap-1 text-sm text-blue-600" href="/api/finance/seasonal-capacity.csv">
              <Download className="h-4 w-4" /> CSV
            </a>
          </div>
          {!seasonal.seasonalIndexAvailable && (
            <p className="mt-2 text-sm text-neutral-500">Not enough history for a seasonal index (need 2+ years). Showing raw counts.</p>
          )}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-neutral-500"><tr><th className="py-1">Calendar month</th><th>Avg events</th><th>Seasonal index</th></tr></thead>
              <tbody>
                {seasonal.calendarMonths.map((stat) => (
                  <tr key={stat.calendarMonth} className="border-t border-neutral-100">
                    <td className="py-2">{MONTH_NAMES[stat.calendarMonth]}</td>
                    <td>{stat.avgEvents.toFixed(1)}</td>
                    <td>{stat.seasonalIndex == null ? "—" : stat.seasonalIndex.toFixed(2)}{seasonal.peakCalendarMonths.includes(stat.calendarMonth) ? <span className="ml-1 text-xs text-emerald-600">plan ahead</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-neutral-500">{seasonal.method}</p>
        </section>

        {/* Settings */}
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold">Intelligence settings</h2>
          <form method="post" action="/api/finance/intelligence-settings" className="mt-3 flex flex-wrap items-end gap-3 text-sm">
            <label className="flex flex-col">Forecast horizon (months)<input name="forecastHorizonMonths" type="number" defaultValue={settings.forecastHorizonMonths} className="rounded border px-2 py-1" /></label>
            <label className="flex flex-col">Trailing window (months)<input name="forecastTrailingMonths" type="number" defaultValue={settings.forecastTrailingMonths} className="rounded border px-2 py-1" /></label>
            <label className="flex flex-col">Monthly capacity target<input name="monthlyCapacityTarget" type="number" defaultValue={settings.monthlyCapacityTarget ?? ""} className="rounded border px-2 py-1" /></label>
            <label className="flex w-full flex-col">Lead-source taxonomy (JSON map)<textarea name="leadSourceTaxonomyJson" defaultValue={JSON.stringify(settings.leadSourceTaxonomyJson)} className="rounded border px-2 py-1 font-mono text-xs" rows={2} /></label>
            <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-white">Save</button>
          </form>
          <p className="mt-2 text-xs text-neutral-500">Blank a field to clear it (falls back to the safe code default). Taxonomy maps raw referralSource (lowercased) → canonical bucket label.</p>
        </section>
      </div>
    </AppShell>
  );
}
