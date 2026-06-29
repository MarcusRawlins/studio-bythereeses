import { createProjectAgentTaskFromForm, updateProjectAgentTaskFromForm } from "@/lib/agent-tasks";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { runStudioTimelineDraftTask } from "@/lib/studio-mcp";
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

function formBoolean(formData: FormData, key: string) {
  const value = formData.get(key);
  return value === "1" || value === "true" || value === "yes";
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id } = await params;

  try {
    const formData = await request.formData();
    const taskId = formData.get("taskId");

    let savedState = "agent-task";
    if (typeof taskId === "string" && taskId.trim()) {
      await updateProjectAgentTaskFromForm(id, taskId, formData);
    } else {
      const task = await createProjectAgentTaskFromForm(id, formData);
      if (formBoolean(formData, "runTimelineDraft")) {
        await runStudioTimelineDraftTask({
          taskId: task.id,
          projectId: id,
          assignedAgent: "Timeline Agent",
        });
        savedState = "timeline-draft";
      }
    }

    revalidateProjectTaskSurfaces(id);

    return NextResponse.redirect(new URL(`/projects/${id}?saved=${savedState}`, request.url), 303);
  } catch (error) {
    console.error("Agent task creation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent task creation failed." },
      { status: 400 },
    );
  }
}
