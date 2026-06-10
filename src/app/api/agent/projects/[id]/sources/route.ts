import { guardAgentApiRequest } from "@/lib/agent-api";
import { createProjectSourceFromAgent, listProjectSources, updateProjectSourceFromAgent } from "@/lib/agent-sources";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

function numberParam(value: string | null, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

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
    const url = new URL(request.url);
    const projectSources = await listProjectSources(id, {
      kind: url.searchParams.get("kind"),
      limit: numberParam(url.searchParams.get("limit"), 20),
    });
    return NextResponse.json({ projectSources });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project source lookup failed." },
      { status: 400 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const { id } = await params;
    const body = await request.json() as {
      kind?: string;
      title?: string;
      body?: string;
      summary?: string | null;
      occurredAt?: string | null;
      externalUrl?: string | null;
      capturedBy?: string | null;
      sourceType?: string | null;
      sourceId?: string | null;
      metadata?: unknown;
    };
    const projectSource = await createProjectSourceFromAgent(id, {
      kind: body.kind ?? "note",
      title: body.title ?? "",
      body: body.body ?? "",
      summary: body.summary,
      occurredAt: body.occurredAt,
      externalUrl: body.externalUrl,
      capturedBy: body.capturedBy,
      sourceType: body.sourceType,
      sourceId: body.sourceId,
      metadata: body.metadata,
    });
    return NextResponse.json({ projectSource }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project source creation failed." },
      { status: 400 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const { id } = await params;
    const sourceId = new URL(request.url).searchParams.get("id")?.trim();
    if (!sourceId) throw new Error("Project source id is required.");
    const body = await request.json() as {
      kind?: string;
      title?: string;
      body?: string;
      summary?: string | null;
      occurredAt?: string | null;
      externalUrl?: string | null;
      capturedBy?: string | null;
      sourceType?: string | null;
      sourceId?: string | null;
      metadata?: unknown;
    };
    const projectSource = await updateProjectSourceFromAgent(id, sourceId, body);
    return NextResponse.json({ projectSource });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project source update failed." },
      { status: 400 },
    );
  }
}
