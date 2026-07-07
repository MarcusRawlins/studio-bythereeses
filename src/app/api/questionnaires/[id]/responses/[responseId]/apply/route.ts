import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { applyQuestionnaireAutofillProposal, questionnaireAutofillReviewEnabled } from "@/lib/questionnaire-autofill";
import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Phase 23 (CR-5) — the ONE canonical-write door for the questionnaire autofill
// proposal (I3). This is an ADMIN surface, structurally identical in trust
// shape to send-email/route.ts:
//   - guarded by `guardDirectWorkerApiRequest` (blocks a direct-to-*.workers.dev
//     request lacking the proxy's stamped origin secret);
//   - NOT listed in `isPublicOriginBypassApiPath` (origin-guard.ts) or any
//     other public/agent bypass list (I4) — it falls through to the genuine
//     admin surface branch (authenticated Google admin session + admin proof);
//   - `actorName` is hardcoded "Tyler", matching send-email/route.ts:72.
//
// D8/B1: the apply form echoes the proposal-version token (computedAt +
// contentHash) Tyler was shown; `applyQuestionnaireAutofillProposal` rejects
// the WHOLE apply if the stored proposal has moved since then (a client
// re-submission between review and click). Nothing is written on rejection.
// ---------------------------------------------------------------------------

function redirectToResponse(
  request: Request,
  questionnaireId: string,
  responseId: string,
  query: Record<string, string>,
) {
  const url = new URL(`/questionnaires/${questionnaireId}/responses/${responseId}`, request.url);
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; responseId: string }> },
) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id: questionnaireId, responseId } = await params;

  if (!questionnaireAutofillReviewEnabled()) {
    return redirectToResponse(request, questionnaireId, responseId, { applyError: "This feature is not enabled." });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    console.error("Questionnaire autofill apply: failed to read form data", error);
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const acceptedFields = formData.getAll("acceptedFields").map((value) => String(value)).filter(Boolean);
  const computedAt = String(formData.get("proposalComputedAt") ?? "").trim();
  const contentHash = String(formData.get("proposalContentHash") ?? "").trim();

  try {
    const result = await applyQuestionnaireAutofillProposal({
      responseId,
      acceptedFields,
      expectedVersion: { computedAt, contentHash },
      actor: { actorType: "admin", actorName: "Tyler" },
    });

    safeRevalidate(`/questionnaires/${questionnaireId}/responses/${responseId}`);
    safeRevalidate(`/questionnaires/${questionnaireId}/responses`);

    if (result.rejected) {
      return redirectToResponse(request, questionnaireId, responseId, { applyError: result.error });
    }

    return redirectToResponse(request, questionnaireId, responseId, { saved: "applied" });
  } catch (error) {
    console.error("Questionnaire autofill apply failed", error);
    return redirectToResponse(request, questionnaireId, responseId, { applyError: "The apply failed. Please try again." });
  }
}
