import { updateProjectStages } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { type NextRequest, NextResponse } from "next/server";

type BulkStagePayload = {
  projectIds?: unknown;
  stage?: unknown;
};

export async function POST(request: NextRequest) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const payload = await request.json() as BulkStagePayload;
    const projectIds = Array.isArray(payload.projectIds)
      ? payload.projectIds.map((value) => String(value ?? ""))
      : [];
    const stage = String(payload.stage ?? "");
    const result = await updateProjectStages(projectIds, stage);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Bulk project stage update failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bulk project stage update failed." },
      { status: 400 },
    );
  }
}
