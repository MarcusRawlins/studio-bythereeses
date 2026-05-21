import { createPortalLinkFromForm } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id } = await params;

  try {
    const formData = await request.formData();
    formData.set("projectId", id);
    const { url } = await createPortalLinkFromForm(formData);

    const redirectUrl = new URL(`/projects/${id}`, request.url);
    redirectUrl.searchParams.set("portalLink", url);
    return NextResponse.redirect(redirectUrl, 303);
  } catch (error) {
    console.error("Portal link creation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Portal link creation failed." },
      { status: 400 },
    );
  }
}
