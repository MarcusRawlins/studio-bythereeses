import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { getStudioProjectContext } from "@/lib/studio-mcp";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const { id } = await params;
    const projectContext = await getStudioProjectContext(id);
    return NextResponse.json({ projectContext });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project context lookup failed." },
      { status: 404 },
    );
  }
}
