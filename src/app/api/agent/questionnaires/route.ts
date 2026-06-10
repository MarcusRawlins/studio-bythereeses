import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { listStudioQuestionnaires } from "@/lib/questionnaires";

export async function GET(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const unauthorized = await guardAgentApiRequest(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const questionnaires = await listStudioQuestionnaires({
    status: url.searchParams.get("status"),
    includeArchived: url.searchParams.get("includeArchived") === "true",
    includeQuestions: url.searchParams.get("includeQuestions") !== "false",
  });

  return Response.json({ questionnaires });
}
