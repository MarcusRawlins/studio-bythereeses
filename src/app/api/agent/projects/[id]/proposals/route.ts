import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { createProposalFromAgent, updateProposalFromAgent, type AgentProposalInput, type AgentProposalUpdateInput } from "@/lib/sales";
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
    const body = await request.json() as AgentProposalInput;
    const proposal = await createProposalFromAgent(id, body);
    return NextResponse.json({ proposal }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Proposal creation failed." },
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
    const proposalId = new URL(request.url).searchParams.get("id")?.trim();
    if (!proposalId) throw new Error("Proposal id is required.");
    const body = await request.json() as AgentProposalUpdateInput;
    const proposal = await updateProposalFromAgent(id, proposalId, body);
    return NextResponse.json({ proposal });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Proposal update failed." },
      { status: 400 },
    );
  }
}
