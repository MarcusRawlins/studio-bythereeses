import { guardAgentApiRequest } from "@/lib/agent-api";
import { enableSixFigureWorkflowForProject, listProjectWorkflowRuns, queueProjectWorkflowStepsForProject, sixFigureAutomationSteps } from "@/lib/project-workflow-automation";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const { id } = await params;
    const workflowRuns = await listProjectWorkflowRuns(id);
    return NextResponse.json({ availableSteps: sixFigureAutomationSteps, workflowRuns });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project workflow lookup failed." },
      { status: 400 },
    );
  }
}

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
      stepKeys?: string[];
      createdBy?: string;
    };
    const setup = await enableSixFigureWorkflowForProject({
      projectId: id,
      stepKeys: body.stepKeys,
      createdBy: body.createdBy ?? "The Reeses Studio Agent",
    });
    return NextResponse.json({ workflowRun: setup.run, workflowSteps: setup.steps }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project workflow setup failed." },
      { status: 400 },
    );
  }
}

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
      workflowRunId?: string;
      stepKeys?: string[];
    };
    const queued = await queueProjectWorkflowStepsForProject(id, body.workflowRunId ?? "", {
      stepKeys: body.stepKeys,
    });
    return NextResponse.json({ workflowRun: queued.run, workflowSteps: queued.steps, queuedTasks: queued.queuedTasks });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project workflow queue failed." },
      { status: 400 },
    );
  }
}
