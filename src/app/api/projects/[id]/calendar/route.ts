import { syncProjectCalendarFromForm } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

function redirectToProject(request: Request, projectId: string, params: Record<string, string>) {
  const url = new URL(`/projects/${projectId}`, request.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id } = await params;
  const formData = await request.formData();
  formData.set("projectId", id);

  try {
    const result = await syncProjectCalendarFromForm(formData);
    if (!result.ok) {
      return redirectToProject(request, id, {
        error: result.reason === "missing_date" ? "calendar-date" : "calendar-sync",
      });
    }

    return redirectToProject(request, id, {
      saved: result.kind,
    });
  } catch (error) {
    console.error("Project calendar sync failed", error);
    return redirectToProject(request, id, {
      error: "calendar-sync",
    });
  }
}
