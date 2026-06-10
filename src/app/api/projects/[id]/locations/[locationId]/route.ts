import { updateProjectLocationFromForm } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; locationId: string }> },
) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id, locationId } = await params;

  try {
    const formData = await request.formData();
    formData.set("projectId", id);
    formData.set("locationId", locationId);
    await updateProjectLocationFromForm(formData);

    return NextResponse.redirect(new URL(`/projects/${id}?saved=location`, request.url), 303);
  } catch (error) {
    console.error("Project location update failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project location update failed." },
      { status: 400 },
    );
  }
}
