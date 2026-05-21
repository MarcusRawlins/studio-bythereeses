import { createProposalLinkFromForm } from "@/lib/sales";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const { id } = await params;
    const formData = await request.formData();
    formData.set("proposalId", id);
    const { proposalId, url } = await createProposalLinkFromForm(formData);

    const redirectUrl = new URL(`/proposals/${proposalId}`, request.url);
    redirectUrl.searchParams.set("share", url);
    return NextResponse.redirect(redirectUrl, 303);
  } catch (error) {
    console.error("Proposal link creation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Proposal link creation failed." },
      { status: 400 },
    );
  }
}
