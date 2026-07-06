import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { getMileageReport, mileageCsv } from "@/lib/tax";

export async function GET(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const yearParam = Number(url.searchParams.get("year"));
  const fromDate = url.searchParams.get("fromDate");
  const toDate = url.searchParams.get("toDate");
  const report = await getMileageReport({
    year: Number.isFinite(yearParam) && yearParam ? yearParam : null,
    fromDate,
    toDate,
  });

  return new Response(mileageCsv(report), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="the-reeses-studio-mileage-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
