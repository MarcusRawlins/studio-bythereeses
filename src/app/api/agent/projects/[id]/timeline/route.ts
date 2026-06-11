import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { createProjectTimelineItem, createProjectTimelineItemsFromAgent, updateProjectTimelineItem } from "@/lib/project-timeline";
import { NextResponse } from "next/server";

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
      title?: string;
      description?: string | null;
      startAt?: string | null;
      endAt?: string | null;
      sourceType?: string | null;
      sourceId?: string | null;
      replaceExistingForSource?: boolean;
      timelineItems?: Array<{
        title?: string;
        description?: string | null;
        startAt?: string | null;
        endAt?: string | null;
        sourceType?: string | null;
        sourceId?: string | null;
      }>;
    };

    if (Array.isArray(body.timelineItems)) {
      const timelineItems = await createProjectTimelineItemsFromAgent(id, {
        sourceType: body.sourceType ?? "agent",
        sourceId: body.sourceId,
        replaceExistingForSource: body.replaceExistingForSource === true,
        timelineItems: body.timelineItems.map((item) => ({
          title: item.title ?? "",
          description: item.description,
          startAt: item.startAt,
          endAt: item.endAt,
          sourceType: item.sourceType,
          sourceId: item.sourceId,
        })),
      });

      return NextResponse.json({ timelineItems }, { status: 201 });
    }

    const timelineItem = await createProjectTimelineItem(id, {
      title: body.title ?? "",
      description: body.description,
      startAt: body.startAt,
      endAt: body.endAt,
      sourceType: body.sourceType ?? "agent",
      sourceId: body.sourceId,
    });

    return NextResponse.json({ timelineItem }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Timeline item creation failed." },
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
    const body = await request.json() as {
      timelineItemId?: string;
      title?: string | null;
      description?: string | null;
      startAt?: string | null;
      endAt?: string | null;
      sortOrder?: number | null;
      sourceType?: string | null;
      sourceId?: string | null;
    };

    const timelineItem = await updateProjectTimelineItem(id, body.timelineItemId ?? "", {
      title: body.title,
      description: body.description,
      startAt: body.startAt,
      endAt: body.endAt,
      sortOrder: body.sortOrder,
      sourceType: body.sourceType,
      sourceId: body.sourceId,
    }, "agent");

    return NextResponse.json({ timelineItem }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Timeline item update failed." },
      { status: 400 },
    );
  }
}
