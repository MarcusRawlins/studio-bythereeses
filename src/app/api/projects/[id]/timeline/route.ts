import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { updateProjectTimelineItemFromForm } from "@/lib/project-timeline";
import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

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
    await updateProjectTimelineItemFromForm(id, formData);

    revalidateProject(id);
    return NextResponse.redirect(new URL(`/projects/${id}?saved=timeline`, request.url), 303);
  } catch (error) {
    console.error("Project timeline save failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project timeline save failed." },
      { status: 400 },
    );
  }
}
