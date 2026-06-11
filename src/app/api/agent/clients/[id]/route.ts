import { guardAgentApiRequest } from "@/lib/agent-api";
import { getClientWithProjects, updateClientFromAgent, type AgentClientUpdateInput } from "@/lib/crm";
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

  const { id } = await params;
  const clientContext = await getClientWithProjects(id);
  if (!clientContext) {
    return NextResponse.json({ error: "Client not found." }, { status: 404 });
  }

  return NextResponse.json({ clientContext });
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
    const body = await request.json() as AgentClientUpdateInput;
    const { client, linkedProjectIds } = await updateClientFromAgent(id, body);
    return NextResponse.json({ client, linkedProjectIds });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Client update failed." },
      { status: 400 },
    );
  }
}
