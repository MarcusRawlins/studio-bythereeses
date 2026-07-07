import { createProjectCommunicationFromForm, updateProjectCommunicationFromForm } from "@/lib/project-communications";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

function redirectToProject(request: Request, projectId: string) {
  return NextResponse.redirect(new URL(`/projects/${projectId}?saved=communication`, request.url), 303);
}

function revalidateProject(projectId: string) {
  try {
    revalidatePath(`/projects/${projectId}`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("static generation store missing")) {
      throw error;
    }
  }
}

// Phase 20 (D10): the booking detail page now also renders this booking's notes (scheduler.ts),
// so a just-created linked note needs its cache busted there too.
function revalidateBookingPage(bookingId: string) {
  try {
    revalidatePath(`/scheduler/bookings/${bookingId}`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("static generation store missing")) {
      throw error;
    }
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id } = await params;

  try {
    const formData = await request.formData();
    const communicationId = formData.get("communicationId");

    // Phase 20 (D10, B-3): the booking-redirect branches ONLY off the CREATE path. Editing an
    // existing communication (or "logging as sent") is always initiated from, and must always
    // return to, the project page — regardless of the row's bookingId — since that's how the
    // project page's "Edit communication" form and "Log as sent" action both reach this branch.
    if (typeof communicationId === "string" && communicationId.trim()) {
      await updateProjectCommunicationFromForm(id, communicationId, formData);
      revalidateProject(id);
      return redirectToProject(request, id);
    }

    const communication = await createProjectCommunicationFromForm(id, formData);
    if (communication.bookingId) {
      // A meeting note created from the booking page (D9) — bounce Tyler back to the booking he
      // came from, not the project, and bust the booking page's cache so it shows the new note.
      revalidateBookingPage(communication.bookingId);
      revalidateProject(id);
      return NextResponse.redirect(
        new URL(`/scheduler/bookings/${communication.bookingId}?saved=communication`, request.url),
        303,
      );
    }

    revalidateProject(id);
    return redirectToProject(request, id);
  } catch (error) {
    console.error("Project communication save failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project communication save failed." },
      { status: 400 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id } = await params;

  try {
    const formData = await request.formData();
    const communicationId = new URL(request.url).searchParams.get("id") ?? "";
    await updateProjectCommunicationFromForm(id, communicationId, formData);

    revalidateProject(id);
    return redirectToProject(request, id);
  } catch (error) {
    console.error("Project communication update failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project communication update failed." },
      { status: 400 },
    );
  }
}
