import { archiveProjects } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { type NextRequest, NextResponse } from "next/server";

type BulkArchivePayload = {
  projectIds?: unknown;
};

export async function POST(request: NextRequest) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const payload = await request.json() as BulkArchivePayload;
    const projectIds = Array.isArray(payload.projectIds)
      ? payload.projectIds.map((value) => String(value ?? ""))
      : [];
    const result = await archiveProjects(projectIds);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Bulk project archive failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bulk project archive failed." },
      { status: 400 },
    );
  }
}
