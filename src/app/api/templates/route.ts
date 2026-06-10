import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { createTemplateFromForm, deleteTemplateFromForm, updateTemplateFromForm } from "@/lib/templates";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const formData = await request.formData();
    const action = String(formData.get("_action") ?? "create");

    if (action === "update") {
      await updateTemplateFromForm(formData);
    } else if (action === "delete") {
      await deleteTemplateFromForm(formData);
    } else {
      await createTemplateFromForm(formData);
    }

    return NextResponse.redirect(new URL("/templates", request.url), 303);
  } catch (error) {
    console.error("Template mutation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Template mutation failed." },
      { status: 400 },
    );
  }
}
