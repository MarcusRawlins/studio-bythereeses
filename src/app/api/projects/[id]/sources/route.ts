import { createProjectSourceFromForm } from "@/lib/agent-sources";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
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
    await createProjectSourceFromForm(id, formData);

    safeRevalidatePath(`/projects/${id}`);

    return NextResponse.redirect(new URL(`/projects/${id}?saved=source`, request.url), 303);
  } catch (error) {
    console.error("Project source creation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project source creation failed." },
      { status: 400 },
    );
  }
}
