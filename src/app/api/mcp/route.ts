import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { handleStudioMcpMessage } from "@/lib/studio-mcp";
import { NextResponse } from "next/server";

function acceptsStreamableHttp(request: Request) {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/json") && accept.includes("text/event-stream");
}

export async function POST(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  if (!acceptsStreamableHttp(request)) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "MCP requests must accept both application/json and text/event-stream.",
        },
      },
      { status: 406 },
    );
  }

  try {
    const message = await request.json();
    const response = await handleStudioMcpMessage(message);
    if (!response) return new NextResponse(null, { status: 202 });
    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error instanceof SyntaxError ? "Invalid JSON body." : "MCP request failed.",
        },
      },
      { status: 400 },
    );
  }
}

export async function GET() {
  return new NextResponse(null, {
    status: 405,
    headers: { Allow: "POST" },
  });
}
