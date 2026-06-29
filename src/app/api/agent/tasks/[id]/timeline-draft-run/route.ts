import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { runStudioTimelineDraftTask } from "@/lib/studio-mcp";
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
      projectId?: string | null;
      assignedAgent?: string | null;
      previewOnly?: boolean | null;
    };
    const timelineDraftRun = await runStudioTimelineDraftTask({
      taskId: id,
      projectId: body.projectId,
      assignedAgent: body.assignedAgent,
      previewOnly: body.previewOnly,
    });

    if (!timelineDraftRun) {
      return NextResponse.json({ timelineDraftRun: null }, { status: 404 });
    }

    return NextResponse.json({ timelineDraftRun });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Timeline draft run failed." },
      { status: 400 },
    );
  }
}
