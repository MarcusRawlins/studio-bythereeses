import { guardAgentApiRequest } from "@/lib/agent-api";
import { linkClientToProject } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

type AgentProjectClientLinkInput = {
  clientId?: string | null;
  role?: string | null;
  customRole?: string | null;
};

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
    const body = await request.json() as AgentProjectClientLinkInput;
    const role = body.role === "other" && body.customRole ? body.customRole : body.role;
    const link = await linkClientToProject({
      projectId: id,
      clientId: body.clientId?.trim() ?? "",
      role,
      actorType: "agent",
      actorName: "The Reeses Studio Agent",
    });
    return NextResponse.json({ link });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project client link failed." },
      { status: 400 },
    );
  }
}
