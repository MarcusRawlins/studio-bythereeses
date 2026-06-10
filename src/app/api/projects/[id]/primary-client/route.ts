import { setProjectPrimaryClientFromForm } from "@/lib/crm";
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
    formData.set("projectId", id);
    await setProjectPrimaryClientFromForm(formData);
    return NextResponse.redirect(new URL(`/projects/${id}?saved=primary-client`, request.url), 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Primary client update failed." },
      { status: 400 },
    );
  }
}
