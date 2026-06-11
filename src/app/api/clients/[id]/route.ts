import { updateClientFromForm } from "@/lib/crm";
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
    await updateClientFromForm(formData);
    return NextResponse.redirect(new URL(`/clients/${id}?saved=client`, request.url), 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Client update failed." },
      { status: 400 },
    );
  }
}
