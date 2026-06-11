import { mergeClients } from "@/lib/crm";
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
    const duplicateClientId = String(formData.get("duplicateClientId") ?? "").trim();
    const actorName = String(formData.get("actorName") ?? "").trim() || "The Reeses Studio";
    await mergeClients({
      survivorClientId: id,
      duplicateClientId,
      actorName,
    });
    return NextResponse.redirect(new URL(`/clients/${id}?saved=merged`, request.url), 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Client merge failed." },
      { status: 400 },
    );
  }
}
