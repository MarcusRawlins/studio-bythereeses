import { guardAgentApiRequest } from "@/lib/agent-api";
import { claimNextAgentTask, createAgentTask, hydrateAgentTaskLinkedSource, hydrateAgentTaskLinkedSources, listAgentTasks } from "@/lib/agent-tasks";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

function numberParam(value: string | null, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export async function GET(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const url = new URL(request.url);
    const agentTasks = await listAgentTasks({
      projectId: url.searchParams.get("projectId"),
      status: url.searchParams.get("status"),
      assignedAgent: url.searchParams.get("assignedAgent"),
      limit: numberParam(url.searchParams.get("limit"), 20),
    });

    return NextResponse.json({ agentTasks: await hydrateAgentTaskLinkedSources(agentTasks) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent task lookup failed." },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const body = await request.json() as {
      projectId?: string | null;
      title?: string;
      instructions?: string | null;
      priority?: string | null;
      requestedBy?: string | null;
      assignedAgent?: string | null;
      sourceType?: string | null;
      sourceId?: string | null;
    };
    const agentTask = await createAgentTask({
      projectId: body.projectId,
      title: body.title ?? "",
      instructions: body.instructions,
      priority: body.priority,
      requestedBy: body.requestedBy,
      assignedAgent: body.assignedAgent,
      sourceType: body.sourceType,
      sourceId: body.sourceId,
    });

    return NextResponse.json({ agentTask: await hydrateAgentTaskLinkedSource(agentTask) }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent task creation failed." },
      { status: 400 },
    );
  }
}

export async function PATCH(request: Request) {
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
    const agentTask = await claimNextAgentTask({
      taskId: body.taskId,
      projectId: body.projectId,
      assignedAgent: body.assignedAgent,
    });

    if (!agentTask) {
      return NextResponse.json({ agentTask: null }, { status: 404 });
    }

    return NextResponse.json({ agentTask: await hydrateAgentTaskLinkedSource(agentTask) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent task claim failed." },
      { status: 400 },
    );
  }
}
