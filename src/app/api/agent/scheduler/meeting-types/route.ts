import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { listStudioSchedulerMeetingTypes } from "@/lib/scheduler";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const unauthorized = await guardAgentApiRequest(request);
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const meetingTypes = await listStudioSchedulerMeetingTypes({
      projectId: url.searchParams.get("projectId"),
      clientId: url.searchParams.get("clientId"),
      includeInactive: url.searchParams.get("includeInactive") === "true",
    });
    return Response.json({ meetingTypes });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Scheduler meeting type lookup failed." },
      { status: 400 },
    );
  }
}
