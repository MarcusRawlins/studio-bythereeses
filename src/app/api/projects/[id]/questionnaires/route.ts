import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { createQuestionnaireTemplate } from "@/lib/questionnaires";
import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

function safeRevalidatePath(path: string) {
  try {
    revalidatePath(path);
  } catch (error) {
    if (error instanceof Error && error.message.includes("static generation store missing")) {
      return;
    }
    throw error;
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id } = await params;

  try {
    const formData = await request.formData();
    const title = String(formData.get("title") ?? "").trim();
    const description = String(formData.get("description") ?? "").trim();
    const status = String(formData.get("status") ?? "draft");
    const questionnaireId = await createQuestionnaireTemplate({
      title,
      description,
      status,
    });

    safeRevalidatePath("/questionnaires");
    safeRevalidatePath(`/projects/${id}`);

    return NextResponse.redirect(new URL(`/questionnaires/${questionnaireId}?projectId=${encodeURIComponent(id)}`, request.url), 303);
  } catch (error) {
    console.error("Project questionnaire creation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project questionnaire creation failed." },
      { status: 400 },
    );
  }
}
