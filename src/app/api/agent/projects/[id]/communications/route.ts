import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { createProjectCommunicationFromAgent, updateProjectCommunicationFromAgent } from "@/lib/project-communications";
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
    const body = await request.json();
    const communication = await createProjectCommunicationFromAgent(id, body);
    return NextResponse.json({ communication }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Communication creation failed." },
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
    const communicationId = new URL(request.url).searchParams.get("id") ?? "";
    const body = await request.json();
    const communication = await updateProjectCommunicationFromAgent(id, communicationId, body);
    return NextResponse.json({ communication });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Communication update failed." },
      { status: 400 },
    );
  }
}
