import { guardAgentApiRequest } from "@/lib/agent-api";
import { hydrateAgentTaskLinkedSource, updateAgentTaskStatus } from "@/lib/agent-tasks";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const { id } = await params;
    const body = await request.json() as {
      status?: string;
      assignedAgent?: string | null;
      resultSummary?: string | null;
      outputJson?: unknown;
      errorMessage?: string | null;
      sourceType?: string | null;
      sourceId?: string | null;
    };
    const updateInput = {
      status: body.status ?? "",
      assignedAgent: body.assignedAgent,
      resultSummary: body.resultSummary,
      outputJson: body.outputJson,
      errorMessage: body.errorMessage,
    } as {
      status: string;
      assignedAgent?: string | null;
      resultSummary?: string | null;
      outputJson?: unknown;
      errorMessage?: string | null;
      sourceType?: string | null;
      sourceId?: string | null;
    };
    if (Object.prototype.hasOwnProperty.call(body, "sourceType")) updateInput.sourceType = body.sourceType;
    if (Object.prototype.hasOwnProperty.call(body, "sourceId")) updateInput.sourceId = body.sourceId;

    const agentTask = await updateAgentTaskStatus(id, updateInput);

    return NextResponse.json({ agentTask: await hydrateAgentTaskLinkedSource(agentTask) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent task update failed." },
      { status: 400 },
    );
  }
}
