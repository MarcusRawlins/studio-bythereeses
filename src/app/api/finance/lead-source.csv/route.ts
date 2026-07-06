import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { getLeadSourcePerformance, leadSourceCsv } from "@/lib/intelligence";

export async function GET(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const report = await getLeadSourcePerformance({
    fromDate: url.searchParams.get("fromDate"),
    toDate: url.searchParams.get("toDate"),
  });

  return new Response(leadSourceCsv(report), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="the-reeses-studio-lead-source.csv"`,
    },
  });
}
