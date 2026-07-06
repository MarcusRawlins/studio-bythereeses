import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { conversionCsv, getConversionReport } from "@/lib/intelligence";

export async function GET(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const report = await getConversionReport({
    fromDate: url.searchParams.get("fromDate"),
    toDate: url.searchParams.get("toDate"),
    asOfDate: url.searchParams.get("asOfDate"),
  });

  return new Response(conversionCsv(report), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="the-reeses-studio-conversion-${report.windowFromDate}-to-${report.windowToDate}.csv"`,
    },
  });
}
