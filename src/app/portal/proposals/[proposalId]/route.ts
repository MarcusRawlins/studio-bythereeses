import { createPortalProposalAccessLink, requirePortalProject } from "@/lib/portal";
import { NextResponse } from "next/server";

export async function GET(request: Request, { params }: { params: Promise<{ proposalId: string }> }) {
  const data = await requirePortalProject();
  if (!data) {
    return NextResponse.redirect(new URL("/portal", request.url), 303);
  }

  const { proposalId } = await params;
  const proposal = data.proposals.find((candidate) => candidate.id === proposalId);
  if (!proposal) {
    return NextResponse.redirect(new URL("/portal", request.url), 303);
  }

  const access = await createPortalProposalAccessLink(data.project.id, proposalId, data.token.clientId ?? data.primaryClient?.id);
  if (!access) {
    return NextResponse.redirect(new URL("/portal", request.url), 303);
  }

  const url = new URL(access.url);
  url.searchParams.set("section", "contract");
  return NextResponse.redirect(url, 303);
}
