import { createProposalFromForm } from "@/lib/sales";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const formData = await request.formData();
    const { proposalId } = await createProposalFromForm(formData);

    return NextResponse.redirect(new URL(`/proposals/${proposalId}`, request.url), 303);
  } catch (error) {
    console.error("Proposal creation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Proposal creation failed." },
      { status: 400 },
    );
  }
}
