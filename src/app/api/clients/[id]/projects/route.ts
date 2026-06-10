import { createProjectForExistingClientFromForm } from "@/lib/crm";
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
    formData.set("clientId", id);
    await createProjectForExistingClientFromForm(formData);
    return NextResponse.redirect(new URL(`/clients/${id}?saved=project`, request.url), 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Client project creation failed." },
      { status: 400 },
    );
  }
}
