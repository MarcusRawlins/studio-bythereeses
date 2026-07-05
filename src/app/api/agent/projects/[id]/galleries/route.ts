import { guardAgentApiRequest } from "@/lib/agent-api";
import { attachProjectGalleryFromAgent, type AgentGalleryAttachInput } from "@/lib/gallery";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

// Phase 7a: draft/attach-only agent gallery tool. `attachProjectGalleryFromAgent`
// always forces status="draft" and createdBy="agent" regardless of the request
// body — this route never publishes a client-visible gallery. See
// src/lib/gallery.test.ts for the agent-authority guard test.
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
    const body = await request.json() as AgentGalleryAttachInput;
    const gallery = await attachProjectGalleryFromAgent(id, body);
    return NextResponse.json({ gallery }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Gallery attach failed." },
      { status: 400 },
    );
  }
}
