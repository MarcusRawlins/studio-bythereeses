import { addProjectLocationFromForm } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id } = await params;

  try {
    const formData = await request.formData();
    formData.set("projectId", id);
    await addProjectLocationFromForm(formData);

    return NextResponse.redirect(new URL(`/projects/${id}?saved=location`, request.url), 303);
  } catch (error) {
    console.error("Project location creation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project location creation failed." },
      { status: 400 },
    );
  }
}
