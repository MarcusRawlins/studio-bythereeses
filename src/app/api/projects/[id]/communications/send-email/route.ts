import { sendApprovedProjectEmail } from "@/lib/project-communications";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Phase 14 — admin-only "send approved email" endpoint. A structural copy of
// send-sms/route.ts. This is the ONLY HTTP surface that invokes
// `sendApprovedProjectEmail` (the sole caller of `sendProjectEmail`). It:
//   - is POST-only (a send is a mutation, nothing to "read");
//   - is guarded by `guardDirectWorkerApiRequest` (blocks a direct-to-
//     *.workers.dev request lacking the proxy's stamped origin secret);
//   - is NOT listed in `isStudioPublicPath` / `isPublicOriginBypassApiPath` /
//     `adminProofRequired`'s exemptions, so it falls through to the default
//     "genuine admin surface" branch: authenticated Google admin session +
//     (under ADMIN_PROOF_ENFORCE=1) the admin proof;
//   - is NOT registered as an MCP/agent tool anywhere — no agent/automation
//     path can reach it. Identical trust model to send-sms.
//
// Reuses the full flag/suppression/recipient-bound-hash/fail-closed-key gate in
// `sendApprovedProjectEmail`; this route adds no send logic of its own.
// ---------------------------------------------------------------------------

function redirectToProject(request: Request, projectId: string, query: Record<string, string>) {
  const url = new URL(`/projects/${projectId}`, request.url);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url, 303);
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

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id } = await params;

  let communicationId: string | null = null;
  let approvedBodyHash = "";
  try {
    const formData = await request.formData();
    const rawCommunicationId = formData.get("communicationId");
    const rawApprovedBodyHash = formData.get("approvedBodyHash");
    communicationId = typeof rawCommunicationId === "string" ? rawCommunicationId.trim() : "";
    approvedBodyHash = typeof rawApprovedBodyHash === "string" ? rawApprovedBodyHash.trim() : "";
  } catch (error) {
    console.error("Approved email send: failed to read form data", error);
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!communicationId) {
    return NextResponse.json({ error: "communicationId is required." }, { status: 400 });
  }

  try {
    // projectId is sourced from the trusted URL path param (not the form body),
    // matching the sibling communications routes' trust model.
    const result = await sendApprovedProjectEmail({
      projectId: id,
      communicationId,
      approvedBodyHash,
      actorName: "Tyler",
    });

    revalidateProject(id);

    if (!result.ok) {
      // No silent drop: the refusal reason always reaches the admin page.
      return redirectToProject(request, id, { emailError: result.reason });
    }

    return redirectToProject(request, id, { saved: "email_sent" });
  } catch (error) {
    // Never put a raw error/PII in the URL — log it server-side only.
    console.error("Approved email send failed", error);
    return redirectToProject(request, id, { emailError: "send_failed" });
  }
}
