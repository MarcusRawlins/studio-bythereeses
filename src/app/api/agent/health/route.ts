import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { computeSystemHealth } from "@/lib/system-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 21 — machine-readable systems health. It MUST live under /api/agent/ so it is reachable
// in prod with ZERO proxy changes: the Pages proxy already treats /api/agent/* as
// isStudioTrustedAgentApiPath (passes the studio host without a 303 -> /admin/login) and applies
// the STUDIO_AGENT_API_TOKEN bearer guard (401 missing/bad, 503 token unset). A bare /api/health
// would ship DEAD (studio host 303, workers.dev 404). Read-only, no flag. NOT an MCP tool — no
// agent/MCP surface for monitoring internals; only the smoke + on-demand checks hit it.
export async function GET(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const unauthorized = await guardAgentApiRequest(request);
  if (unauthorized) return unauthorized;

  const report = await computeSystemHealth();
  return Response.json(report);
}
