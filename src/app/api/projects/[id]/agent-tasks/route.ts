import { createProjectAgentTaskFromForm, updateProjectAgentTaskFromForm } from "@/lib/agent-tasks";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

function revalidateProjectTaskSurfaces(projectId: string) {
  try {
    revalidatePath(`/projects/${projectId}`);
    revalidatePath("/inbox");
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
    const taskId = formData.get("taskId");

    if (typeof taskId === "string" && taskId.trim()) {
      await updateProjectAgentTaskFromForm(id, taskId, formData);
    } else {
      await createProjectAgentTaskFromForm(id, formData);
    }

    revalidateProjectTaskSurfaces(id);

    return NextResponse.redirect(new URL(`/projects/${id}?saved=agent-task`, request.url), 303);
  } catch (error) {
    console.error("Agent task creation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent task creation failed." },
      { status: 400 },
    );
  }
}
