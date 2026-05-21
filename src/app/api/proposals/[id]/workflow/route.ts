import { updateProposalWorkflowFromForm } from "@/lib/sales";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const { id } = await params;
    const formData = await request.formData();
    formData.set("proposalId", id);
    const { proposalId } = await updateProposalWorkflowFromForm(formData);

    return NextResponse.redirect(new URL(`/proposals/${proposalId}`, request.url), 303);
  } catch (error) {
    console.error("Proposal workflow update failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Proposal workflow update failed." },
      { status: 400 },
    );
  }
}
