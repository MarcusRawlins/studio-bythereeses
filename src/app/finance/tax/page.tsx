import { AppShell } from "@/components/AppShell";
import { formatMoney } from "@/lib/format";
import { get1099VendorReport, getFinanceTaxSettings, getMileageReport, getQuarterlyTaxEstimate } from "@/lib/tax";
import { Download } from "lucide-react";

export const dynamic = "force-dynamic";

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function FinanceTaxPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams ? await searchParams : {};
  const now = new Date();
  const year = Number(firstQueryValue(params.year)) || now.getUTCFullYear();
  const quarter = Number(firstQueryValue(params.quarter)) || (Math.floor(now.getUTCMonth() / 3) + 1);

  const [estimate, vendorReport, mileage, settings] = await Promise.all([
    getQuarterlyTaxEstimate({ year, quarter }),
    get1099VendorReport({ year }),
    getMileageReport({ year }),
    getFinanceTaxSettings(),
  ]);

  return (
    <AppShell>
      <div className="space-y-8">
        <header className="border-b border-neutral-200 pb-4">
          <h1 className="text-3xl font-semibold">Tax &amp; 1099</h1>
          <p className="mt-1 text-neutral-500">Estimates and deduction tracking — not tax advice.</p>
        </header>
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Quarterly tax estimate</h2>
            <a className="inline-flex items-center gap-1 text-sm text-blue-600" href={`/api/finance/tax-estimate.csv?year=${year}&quarter=${quarter}`}>
              <Download className="h-4 w-4" /> CSV
            </a>
          </div>
          <form method="get" className="mt-3 flex flex-wrap items-end gap-3 text-sm">
            <label className="flex flex-col">Year<input name="year" type="number" defaultValue={year} className="rounded border px-2 py-1" /></label>
            <label className="flex flex-col">Quarter
              <select name="quarter" defaultValue={quarter} className="rounded border px-2 py-1">
                <option value={1}>Q1 (Jan–Mar)</option>
                <option value={2}>Q2 (Apr–Jun)</option>
                <option value={3}>Q3 (Jul–Sep)</option>
                <option value={4}>Q4 (Oct–Dec)</option>
              </select>
            </label>
            <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-white">View</button>
          </form>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <div><dt className="text-neutral-500">Net revenue</dt><dd className="font-semibold">{formatMoney(estimate.netRevenueCents)}</dd></div>
            <div><dt className="text-neutral-500">Deductible expenses</dt><dd className="font-semibold">{formatMoney(estimate.deductibleExpenseCents)}</dd></div>
            <div><dt className="text-neutral-500">Mileage deduction</dt><dd className="font-semibold">{formatMoney(estimate.mileageDeductionCents)} ({estimate.mileageMiles} mi)</dd></div>
            <div><dt className="text-neutral-500">Est. net SE income</dt><dd className="font-semibold">{formatMoney(estimate.estimatedNetSelfEmploymentIncomeCents)}</dd></div>
            <div><dt className="text-neutral-500">Set-aside ({estimate.taxSetAsideRatePercent}%)</dt><dd className="font-semibold">{formatMoney(estimate.estimatedSetAsideCents)}</dd></div>
          </dl>
          <p className="mt-3 text-xs text-neutral-500">{estimate.disclaimer}</p>
        </section>

        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold">Finance rate settings</h2>
          <form method="post" action="/api/finance/tax-settings" className="mt-3 flex flex-wrap items-end gap-3 text-sm">
            <label className="flex flex-col">Set-aside %<input name="taxSetAsideRatePercent" type="number" defaultValue={settings.taxSetAsideRatePercent} className="rounded border px-2 py-1" /></label>
            <label className="flex flex-col">Mileage rate (¢/mi)<input name="mileageRateCents" type="number" defaultValue={settings.mileageRateCents} className="rounded border px-2 py-1" /></label>
            <label className="flex flex-col">1099 threshold (¢)<input name="form1099ThresholdCents" type="number" defaultValue={settings.form1099ThresholdCents} className="rounded border px-2 py-1" /></label>
            <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-white">Save</button>
          </form>
        </section>

        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">1099 vendors ({year})</h2>
            <a className="inline-flex items-center gap-1 text-sm text-blue-600" href={`/api/finance/1099-summary.csv?year=${year}`}>
              <Download className="h-4 w-4" /> CSV
            </a>
          </div>
          <p className="mt-1 text-xs text-neutral-500">Reportable = non-card payments ≥ {formatMoney(vendorReport.thresholdCents)}. Card / processor payments excluded (1099-K).</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-neutral-500">
                <tr><th className="py-1">Vendor</th><th>Reportable</th><th>Card</th><th>W-9</th><th>Flag</th><th>Update W-9</th></tr>
              </thead>
              <tbody>
                {vendorReport.vendors.map((row) => (
                  <tr key={row.vendorId} className="border-t border-neutral-100 align-top">
                    <td className="py-2">{row.vendorName}{row.legalName ? ` (${row.legalName})` : ""}</td>
                    <td>{formatMoney(row.reportableCents)}</td>
                    <td>{formatMoney(row.cardCents)}</td>
                    <td>{row.taxIdLast4 ? `••••${row.taxIdLast4}` : "—"}</td>
                    <td>{row.needsReconciliation ? <span className="text-amber-600">needs W-9/review</span> : row.crossesThreshold ? <span className="text-emerald-600">1099</span> : "—"}</td>
                    <td>
                      <form method="post" action="/api/finance/vendors" className="flex flex-wrap items-center gap-1">
                        <input type="hidden" name="vendorId" value={row.vendorId} />
                        <input name="legalName" placeholder="Legal name" defaultValue={row.legalName ?? ""} className="w-28 rounded border px-1" />
                        <input name="taxIdLast4" placeholder="TIN last4" defaultValue={row.taxIdLast4 ?? ""} className="w-20 rounded border px-1" />
                        <label className="flex items-center gap-1"><input type="checkbox" name="is1099Tracked" defaultChecked={row.is1099Tracked} /> track</label>
                        <button type="submit" className="rounded bg-neutral-900 px-2 py-0.5 text-white">Save</button>
                      </form>
                    </td>
                  </tr>
                ))}
                {vendorReport.vendors.length === 0 && (
                  <tr><td colSpan={6} className="py-3 text-neutral-500">No paid vendor expenses this year.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Mileage ({year})</h2>
            <a className="inline-flex items-center gap-1 text-sm text-blue-600" href={`/api/finance/mileage.csv?year=${year}`}>
              <Download className="h-4 w-4" /> CSV
            </a>
          </div>
          <p className="mt-1 text-sm">Total: <strong>{mileage.totalMiles} mi</strong> → deduction <strong>{formatMoney(mileage.deductionCents)}</strong> ({mileage.mileageRateCents}¢/mi)</p>
          <form method="post" action="/api/finance/mileage" className="mt-3 flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col">Date<input name="tripDate" type="date" required className="rounded border px-2 py-1" /></label>
            <label className="flex flex-col">Miles<input name="miles" type="number" step="0.1" required className="rounded border px-2 py-1" /></label>
            <label className="flex flex-col">Purpose<input name="purpose" className="rounded border px-2 py-1" /></label>
            <label className="flex flex-col">From<input name="fromLocation" className="rounded border px-2 py-1" /></label>
            <label className="flex flex-col">To<input name="toLocation" className="rounded border px-2 py-1" /></label>
            <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-white">Add trip</button>
          </form>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-neutral-500"><tr><th className="py-1">Date</th><th>Miles</th><th>Purpose</th><th>Route</th><th></th></tr></thead>
              <tbody>
                {mileage.rows.map((row) => (
                  <tr key={row.id} className="border-t border-neutral-100">
                    <td className="py-2">{row.tripDate}</td>
                    <td>{row.miles}</td>
                    <td>{row.purpose ?? "—"}</td>
                    <td>{[row.fromLocation, row.toLocation].filter(Boolean).join(" → ") || "—"}</td>
                    <td>
                      <form method="post" action="/api/finance/mileage">
                        <input type="hidden" name="_action" value="delete" />
                        <input type="hidden" name="id" value={row.id} />
                        <button type="submit" className="text-red-600">Delete</button>
                      </form>
                    </td>
                  </tr>
                ))}
                {mileage.rows.length === 0 && (
                  <tr><td colSpan={5} className="py-3 text-neutral-500">No mileage logged for this year.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <p className="text-sm">
          <a className="inline-flex items-center gap-1 text-blue-600" href="/api/finance/accounting-export.csv">
            <Download className="h-4 w-4" /> Accountant export (QuickBooks / Xero CSV)
          </a>
        </p>
      </div>
    </AppShell>
  );
}
