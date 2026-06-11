import { bookkeepingSummaryCsv, getBookkeepingReport } from "@/lib/bookkeeping";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";

export async function GET(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const status = url.searchParams.get("expenseStatus") ?? "paid";
  const fromDate = url.searchParams.get("fromDate");
  const toDate = url.searchParams.get("toDate");
  const report = await getBookkeepingReport({ status, fromDate, toDate });

  return new Response(bookkeepingSummaryCsv(report, { expenseStatus: status, fromDate, toDate }), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="the-reeses-studio-bookkeeping-summary-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
