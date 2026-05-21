import { updateProjectEventFromForm } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id, eventId } = await params;

  try {
    const formData = await request.formData();
    formData.set("projectId", id);
    formData.set("eventId", eventId);
    await updateProjectEventFromForm(formData);

    return NextResponse.redirect(new URL(`/projects/${id}?saved=event`, request.url), 303);
  } catch (error) {
    console.error("Project event update failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project event update failed." },
      { status: 400 },
    );
  }
}
