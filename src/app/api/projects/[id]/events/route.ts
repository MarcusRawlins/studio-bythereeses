import { addProjectEventFromForm } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id } = await params;

  try {
    const formData = await request.formData();
    formData.set("projectId", id);
    await addProjectEventFromForm(formData);

    return NextResponse.redirect(new URL(`/projects/${id}`, request.url), 303);
  } catch (error) {
    console.error("Project event creation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project event creation failed." },
      { status: 400 },
    );
  }
}
