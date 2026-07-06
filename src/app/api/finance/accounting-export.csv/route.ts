import { accountingExportCsv, getAccountingExportRows } from "@/lib/accounting-export";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";

export async function GET(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const fromDate = url.searchParams.get("fromDate");
  const toDate = url.searchParams.get("toDate");
  const rows = await getAccountingExportRows({ fromDate, toDate });

  return new Response(accountingExportCsv(rows, { fromDate, toDate }), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="the-reeses-studio-accounting-export-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
