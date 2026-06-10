import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { createProjectQuestionnaireResponseDraft } from "@/lib/questionnaires";
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
    const questionnaireId = String(formData.get("questionnaireId") ?? "").trim();
    const clientId = String(formData.get("clientId") ?? "").trim();
    if (!questionnaireId) {
      throw new Error("Questionnaire and project are required.");
    }

    const responseId = await createProjectQuestionnaireResponseDraft({
      questionnaireId,
      projectId: id,
      clientId: clientId || null,
    });

    safeRevalidatePath(`/projects/${id}`);
    safeRevalidatePath(`/questionnaires/${questionnaireId}/responses`);

    return NextResponse.redirect(new URL(`/questionnaires/${questionnaireId}/responses/${responseId}/edit`, request.url), 303);
  } catch (error) {
    console.error("Project questionnaire response creation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project questionnaire response creation failed." },
      { status: 400 },
    );
  }
}
