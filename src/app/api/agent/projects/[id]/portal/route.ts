import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { createPortalLinkFromAgent, type PortalLinkInput } from "@/lib/portal";
import { NextResponse } from "next/server";

type AgentPortalLinkInput = Pick<PortalLinkInput, "clientId" | "label">;

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
    const body = await request.json() as AgentPortalLinkInput;
    const link = await createPortalLinkFromAgent(id, body);
    return NextResponse.json({ link }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Portal link creation failed." },
      { status: 400 },
    );
  }
}
