import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { getPackageValueTrend, packageValueCsv } from "@/lib/intelligence";

export async function GET(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const report = await getPackageValueTrend({
    asOfDate: url.searchParams.get("asOfDate"),
  });

  return new Response(packageValueCsv(report), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="the-reeses-studio-package-value.csv"`,
    },
  });
}
