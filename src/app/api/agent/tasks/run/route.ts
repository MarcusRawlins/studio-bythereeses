import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { startStudioAgentTaskRun } from "@/lib/studio-mcp";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const body = await request.json() as {
      taskId?: string | null;
      projectId?: string | null;
      assignedAgent?: string | null;
    };
    const agentTaskRun = await startStudioAgentTaskRun({
      taskId: body.taskId,
      projectId: body.projectId,
      assignedAgent: body.assignedAgent,
    });

    if (!agentTaskRun) {
      return NextResponse.json({ agentTaskRun: null }, { status: 404 });
    }

    return NextResponse.json({ agentTaskRun });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent task run start failed." },
      { status: 400 },
    );
  }
}
