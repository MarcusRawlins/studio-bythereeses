import { getPaymentLedgerReport, paymentLedgerCsv } from "@/lib/sales";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";

export async function GET(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "all";
  const fromDate = url.searchParams.get("fromDate");
  const toDate = url.searchParams.get("toDate");
  const report = await getPaymentLedgerReport({ status, fromDate, toDate });

  return new Response(paymentLedgerCsv(report.rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="the-reeses-studio-payment-ledger-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
