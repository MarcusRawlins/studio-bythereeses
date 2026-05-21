import { createProjectFromForm } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const formData = await request.formData();
    const projectId = await createProjectFromForm(formData);

    return NextResponse.redirect(new URL(`/projects/${projectId}`, request.url), 303);
  } catch (error) {
    console.error("Project creation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project creation failed." },
      { status: 400 },
    );
  }
}
