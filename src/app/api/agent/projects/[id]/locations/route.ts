import { guardAgentApiRequest } from "@/lib/agent-api";
import { createProjectLocationFromAgent, updateProjectLocationFromAgent, type AgentProjectLocationInput } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
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
    const body = await request.json() as AgentProjectLocationInput;
    const location = await createProjectLocationFromAgent(id, body);
    return NextResponse.json({ location }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project location creation failed." },
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
    const locationId = new URL(request.url).searchParams.get("id") ?? "";
    const body = await request.json() as AgentProjectLocationInput;
    const location = await updateProjectLocationFromAgent(id, locationId, body);
    return NextResponse.json({ location });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project location update failed." },
      { status: 400 },
    );
  }
}
