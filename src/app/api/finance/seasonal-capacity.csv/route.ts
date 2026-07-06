import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { getSeasonalCapacity, seasonalCapacityCsv } from "@/lib/intelligence";

export async function GET(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const report = await getSeasonalCapacity({
    asOfDate: url.searchParams.get("asOfDate"),
  });

  return new Response(seasonalCapacityCsv(report), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="the-reeses-studio-seasonal-capacity.csv"`,
    },
  });
}
