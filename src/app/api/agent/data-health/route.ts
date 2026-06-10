import { guardAgentApiRequest } from "@/lib/agent-api";
import { listStudioDataHealth } from "@/lib/data-health";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";

export async function GET(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const unauthorized = await guardAgentApiRequest(request);
  if (unauthorized) return unauthorized;

  const dataHealth = await listStudioDataHealth();
  return Response.json({ dataHealth });
}
