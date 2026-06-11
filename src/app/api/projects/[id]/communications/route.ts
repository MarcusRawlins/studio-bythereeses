import { createProjectCommunicationFromForm, updateProjectCommunicationFromForm } from "@/lib/project-communications";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

function redirectToProject(request: Request, projectId: string) {
  return NextResponse.redirect(new URL(`/projects/${projectId}?saved=communication`, request.url), 303);
}

function revalidateProject(projectId: string) {
  try {
    revalidatePath(`/projects/${projectId}`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("static generation store missing")) {
      throw error;
    }
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id } = await params;

  try {
    const formData = await request.formData();
    const communicationId = formData.get("communicationId");

    if (typeof communicationId === "string" && communicationId.trim()) {
      await updateProjectCommunicationFromForm(id, communicationId, formData);
    } else {
      await createProjectCommunicationFromForm(id, formData);
    }

    revalidateProject(id);
    return redirectToProject(request, id);
  } catch (error) {
    console.error("Project communication save failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project communication save failed." },
      { status: 400 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id } = await params;

  try {
    const formData = await request.formData();
    const communicationId = new URL(request.url).searchParams.get("id") ?? "";
    await updateProjectCommunicationFromForm(id, communicationId, formData);

    revalidateProject(id);
    return redirectToProject(request, id);
  } catch (error) {
    console.error("Project communication update failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project communication update failed." },
      { status: 400 },
    );
  }
}
