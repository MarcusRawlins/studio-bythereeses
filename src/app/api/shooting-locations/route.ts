import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { archiveShootingLocationFromForm, createShootingLocationFromForm, updateShootingLocationFromForm } from "@/lib/shooting-locations";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const formData = await request.formData();
    const action = String(formData.get("_action") ?? "create");

    if (action === "update") {
      await updateShootingLocationFromForm(formData);
    } else if (action === "archive") {
      await archiveShootingLocationFromForm(formData);
    } else {
      await createShootingLocationFromForm(formData);
    }

    return NextResponse.redirect(new URL("/shooting-locations", request.url), 303);
  } catch (error) {
    console.error("Shooting location mutation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Shooting location mutation failed." },
      { status: 400 },
    );
  }
}
