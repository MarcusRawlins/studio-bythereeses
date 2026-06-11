import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { updateAppSettingsFromForm } from "@/lib/settings";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const formData = await request.formData();
    await updateAppSettingsFromForm(formData);

    return NextResponse.redirect(new URL("/settings?saved=1", request.url), 303);
  } catch (error) {
    console.error("Settings update failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Settings update failed." },
      { status: 400 },
    );
  }
}
