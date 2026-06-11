import { guardAgentApiRequest } from "@/lib/agent-api";
import { mergeClients } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

type AgentClientMergeInput = {
  duplicateClientId?: string | null;
  actorName?: string | null;
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
    const body = await request.json() as AgentClientMergeInput;
    const merge = await mergeClients({
      survivorClientId: id,
      duplicateClientId: body.duplicateClientId?.trim() ?? "",
      actorType: "agent",
      actorName: body.actorName?.trim() || "The Reeses Studio Agent",
    });
    return NextResponse.json({ merge });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Client merge failed." },
      { status: 400 },
    );
  }
}
