import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { getRevenueForecast, revenueForecastCsv } from "@/lib/intelligence";

export async function GET(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const forecast = await getRevenueForecast({
    asOfDate: url.searchParams.get("asOfDate"),
    horizonMonths: Number(url.searchParams.get("horizonMonths")) || null,
  });

  return new Response(revenueForecastCsv(forecast), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="the-reeses-studio-revenue-forecast-${forecast.thisMonth}.csv"`,
    },
  });
}
