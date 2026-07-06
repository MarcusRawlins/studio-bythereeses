import { sendApprovedProjectSms } from "@/lib/project-communications";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Phase 8b follow-up (task #27) — admin-only "send approved SMS" endpoint.
//
// This is the ONLY HTTP surface that invokes `sendApprovedProjectSms` (which is
// itself the sole caller of `sendProjectSms` in src/lib/sms.ts). It:
//   - is POST-only (no GET/PATCH — nothing to "read" here, a send is a mutation);
//   - is guarded by `guardDirectWorkerApiRequest` like every other
//     `/api/projects/[id]/*` admin route (blocks a direct-to-*.workers.dev
//     request lacking the proxy's stamped origin secret);
//   - is NOT listed in `isStudioPublicPath` / `isPublicOriginBypassApiPath` /
//     `adminProofRequired`'s exemptions, so it falls through to the default
//     "genuine admin surface" branch: the Pages proxy requires an authenticated
//     Google admin session, and (when ADMIN_PROOF_ENFORCE=1) the admin proof;
//   - is NOT registered as an MCP/agent tool anywhere in studio-mcp.ts — no
//     agent/automation path can reach this route. `sendProjectSms` itself is
//     only ever called from `sendApprovedProjectSms`, which is only ever
//     called from here and from the guard test.
//
// Reuses the FULL consent/suppression/flag/fail-closed gate transparently:
// `sendApprovedProjectSms` -> `sendProjectSms` enforces opt-in, E.164
// normalization, suppression, the SMS_ENABLED flag, and the B1(a) content-
// binding (approvedBodyHash) check before ever calling Twilio. This route adds
// no send logic of its own — it only translates the HTTP form into that call
// and reports the (possibly refused) result back to the admin page.
// ---------------------------------------------------------------------------

function redirectToProject(
  request: Request,
  projectId: string,
  query: Record<string, string>,
) {
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
    console.error("Approved SMS send: failed to read form data", error);
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!communicationId) {
    return NextResponse.json({ error: "communicationId is required." }, { status: 400 });
  }

  try {
    // projectId is sourced from the trusted URL path param (not the form body),
    // matching the sibling communications route's trust model.
    const result = await sendApprovedProjectSms({
      projectId: id,
      communicationId,
      approvedBodyHash,
      actorName: "Tyler",
    });

    revalidateProject(id);

    if (!result.ok) {
      // No silent drop (spec §2.3): the refusal reason always reaches the admin
      // page as a visible query param, never a swallowed no-op.
      return redirectToProject(request, id, { smsError: result.reason });
    }

    return redirectToProject(request, id, { saved: "sms_sent" });
  } catch (error) {
    console.error("Approved SMS send failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "SMS send failed." },
      { status: 400 },
    );
  }
}
