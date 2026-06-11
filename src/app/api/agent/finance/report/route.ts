import { guardAgentApiRequest } from "@/lib/agent-api";
import { getAgentFinanceReport } from "@/lib/agent-finance";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";

export async function GET(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const unauthorized = await guardAgentApiRequest(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const financeReport = await getAgentFinanceReport({
    paymentStatus: url.searchParams.get("paymentStatus"),
    expenseStatus: url.searchParams.get("expenseStatus"),
    fromDate: url.searchParams.get("fromDate"),
    toDate: url.searchParams.get("toDate"),
    asOfDate: url.searchParams.get("asOfDate"),
  });

  return Response.json({ financeReport });
}
