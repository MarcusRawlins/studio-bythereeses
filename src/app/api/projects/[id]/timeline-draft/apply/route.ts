import { db } from "@/db/client";
import { agentTasks } from "@/db/schema";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { applyProjectTimelineDraft } from "@/lib/project-timeline";
import { questionnaireAutofillReviewEnabled } from "@/lib/questionnaire-autofill";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Phase 23 (CR-5), D6 — "Apply timeline draft". The draft
// (`buildTimelineDraftFromProjectContext` -> `agent_tasks.outputJson`) has
// always dead-ended read-only; this is the first apply step. It IS itself an
// admin approval action, so it doesn't strictly need the flag for safety, but
// it's gated behind the SAME QUESTIONNAIRE_AUTOFILL_REVIEW flag so the whole
// Phase 23 surface is one rollout unit (D6). Trust shape matches the
// questionnaire apply route / send-email/route.ts: guardDirectWorkerApiRequest,
// not in any public/agent bypass list, hardcoded actorName "Tyler".
// ---------------------------------------------------------------------------

function redirectToProject(request: Request, projectId: string, query: Record<string, string>) {
  const url = new URL(`/projects/${projectId}`, request.url);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url, 303);
}

function safeRevalidate(path: string) {
  try {
    revalidatePath(path);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("static generation store missing")) {
      throw error;
    }
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id: projectId } = await params;

  if (!questionnaireAutofillReviewEnabled()) {
    return redirectToProject(request, projectId, { applyError: "This feature is not enabled." });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    console.error("Timeline draft apply: failed to read form data", error);
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const taskId = String(formData.get("taskId") ?? "").trim();
  const confirmReplace = String(formData.get("confirmReplace") ?? "") === "1";
  if (!taskId) {
    return redirectToProject(request, projectId, { applyError: "Timeline draft task is required." });
  }

  try {
    const task = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, taskId) });
    if (!task || task.projectId !== projectId) {
      return redirectToProject(request, projectId, { applyError: "Timeline draft task not found for this project." });
    }

    const result = await applyProjectTimelineDraft({
      projectId,
      outputJson: task.outputJson,
      confirmReplace,
      actorName: "Tyler",
    });

    safeRevalidate(`/projects/${projectId}`);

    if (!result.ok) {
      if ("error" in result) {
        return redirectToProject(request, projectId, { applyError: result.error });
      }
      return redirectToProject(request, projectId, {
        applyConfirm: taskId,
        applyConfirmCount: String(result.handEditedCount),
      });
    }

    return redirectToProject(request, projectId, { saved: "timeline_draft_applied" });
  } catch (error) {
    console.error("Timeline draft apply failed", error);
    return redirectToProject(request, projectId, { applyError: "The apply failed. Please try again." });
  }
}
