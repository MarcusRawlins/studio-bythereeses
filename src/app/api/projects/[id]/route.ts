import { updateProjectDetailsFromForm } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id } = await params;

  try {
    const formData = await request.formData();
    formData.set("projectId", id);
    await updateProjectDetailsFromForm(formData);

    return NextResponse.redirect(new URL(`/projects/${id}?saved=details`, request.url), 303);
  } catch (error) {
    console.error("Project details update failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project details update failed." },
      { status: 400 },
    );
  }
}
