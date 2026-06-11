import { guardAgentApiRequest } from "@/lib/agent-api";
import { createProjectFromAgent, type AgentProjectCreateInput } from "@/lib/crm";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { searchStudioProjectIndex } from "@/lib/studio-mcp";
import { NextResponse } from "next/server";

function numberParam(value: string | null, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export async function GET(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const url = new URL(request.url);
    const projectSearch = await searchStudioProjectIndex({
      query: url.searchParams.get("q") ?? url.searchParams.get("query"),
      page: numberParam(url.searchParams.get("page"), 1),
      limit: numberParam(url.searchParams.get("limit"), 10),
      sort: url.searchParams.get("sort") as "eventDate" | "createdAt" | "name" | null,
    });

    return NextResponse.json(projectSearch);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project search failed." },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const body = await request.json() as AgentProjectCreateInput;
    const project = await createProjectFromAgent(body);
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project creation failed." },
      { status: 400 },
    );
  }
}
