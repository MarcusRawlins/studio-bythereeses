import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { get1099VendorReport, vendor1099Csv } from "@/lib/tax";

export async function GET(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const year = Number(url.searchParams.get("year")) || new Date().getUTCFullYear();
  const report = await get1099VendorReport({ year });

  return new Response(vendor1099Csv(report), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="the-reeses-studio-1099-summary-${year}.csv"`,
    },
  });
}
