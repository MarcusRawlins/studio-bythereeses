import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { createProposalLinkFromAgent, type AgentProposalLinkInput } from "@/lib/sales";
import { NextResponse } from "next/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; proposalId: string }> },
) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const { id, proposalId } = await params;
    const body = await request.json() as AgentProposalLinkInput;
    const link = await createProposalLinkFromAgent(id, proposalId, body);
    return NextResponse.json({ link }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Proposal link creation failed." },
      { status: 400 },
    );
  }
}
