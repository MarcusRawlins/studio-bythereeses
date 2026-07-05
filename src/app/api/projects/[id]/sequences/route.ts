import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { setSequenceEnrollment, type SequenceEnrollmentAction } from "@/lib/sequences";
import { NextResponse } from "next/server";

// Admin enroll/unenroll control for a project's sequences. Reachable only through
// the authenticated Studio front door (proxy admin session + Phase-6 admin proof)
// or direct origin with the proxy secret; no agent/MCP surface reaches it.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const { id } = await params;
  try {
    const formData = await request.formData();
    const sequenceKey = String(formData.get("sequenceKey") ?? "").trim();
    const action = String(formData.get("_action") ?? "").trim();
    if (!sequenceKey || (action !== "stop" && action !== "activate")) {
      return NextResponse.json({ error: "A sequenceKey and a stop/activate action are required." }, { status: 400 });
    }
    await setSequenceEnrollment({ projectId: id, sequenceKey, action: action as SequenceEnrollmentAction });
    return NextResponse.redirect(new URL(`/projects/${id}?saved=sequence`, request.url), 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sequence update failed." },
      { status: 400 },
    );
  }
}
