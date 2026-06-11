import { accountsReceivableAgingCsv, getPaymentLedgerReport } from "@/lib/sales";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";

export async function GET(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "all";
  const fromDate = url.searchParams.get("fromDate");
  const toDate = url.searchParams.get("toDate");
  const asOfDate = url.searchParams.get("asOfDate");
  const report = await getPaymentLedgerReport({ status, fromDate, toDate, asOfDate });

  return new Response(accountsReceivableAgingCsv(report.aging), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="the-reeses-studio-ar-aging-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
