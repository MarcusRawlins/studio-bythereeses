import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { listStudioTemplates } from "@/lib/studio-mcp";

export async function GET(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const unauthorized = await guardAgentApiRequest(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const templates = await listStudioTemplates({
    type: url.searchParams.get("type"),
    includeArchived: url.searchParams.get("includeArchived") === "true",
  });

  return Response.json({ templates });
}
