import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { getQuarterlyTaxEstimate, taxEstimateCsv } from "@/lib/tax";

export async function GET(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const now = new Date();
  const year = Number(url.searchParams.get("year")) || now.getUTCFullYear();
  const quarter = Number(url.searchParams.get("quarter")) || (Math.floor(now.getUTCMonth() / 3) + 1);
  const estimate = await getQuarterlyTaxEstimate({ year, quarter });

  return new Response(taxEstimateCsv(estimate), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="the-reeses-studio-tax-estimate-${year}-q${estimate.quarter}.csv"`,
    },
  });
}
