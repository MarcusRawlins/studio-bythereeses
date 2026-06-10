import { enableSixFigureWorkflowFromForm, queueProjectWorkflowStepsFromForm } from "@/lib/project-workflow-automation";
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
    const action = String(formData.get("_action") ?? "setup");
    if (action === "queue") {
      await queueProjectWorkflowStepsFromForm(id, formData);
      return NextResponse.redirect(new URL(`/projects/${id}?saved=workflow-queued`, request.url), 303);
    }

    await enableSixFigureWorkflowFromForm(id, formData);
    return NextResponse.redirect(new URL(`/projects/${id}?saved=workflow`, request.url), 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project workflow setup failed." },
      { status: 400 },
    );
  }
}
