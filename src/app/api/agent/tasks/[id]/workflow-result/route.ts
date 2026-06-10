import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { completeProjectWorkflowAgentTask } from "@/lib/project-workflow-execution";
import { NextResponse } from "next/server";

export async function POST(
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
      assignedAgent?: string | null;
      outputTitle?: string | null;
      outputBody?: string;
      outputSummary?: string | null;
      outputKind?: string | null;
      metadata?: unknown;
    };
    const result = await completeProjectWorkflowAgentTask(id, {
      assignedAgent: body.assignedAgent,
      outputTitle: body.outputTitle,
      outputBody: body.outputBody ?? "",
      outputSummary: body.outputSummary,
      outputKind: body.outputKind,
      metadata: body.metadata,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Workflow result submission failed." },
      { status: 400 },
    );
  }
}
