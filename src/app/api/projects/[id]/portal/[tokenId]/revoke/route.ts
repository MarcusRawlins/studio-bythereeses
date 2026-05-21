import { revokePortalTokenFromForm } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tokenId: string }> },
) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id, tokenId } = await params;

  try {
    const formData = await request.formData();
    formData.set("projectId", id);
    formData.set("tokenId", tokenId);
    await revokePortalTokenFromForm(formData);

    return NextResponse.redirect(new URL(`/projects/${id}`, request.url), 303);
  } catch (error) {
    console.error("Portal token revoke failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Portal token revoke failed." },
      { status: 400 },
    );
  }
}
