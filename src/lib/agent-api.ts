import { NextResponse } from "next/server";

const AGENT_AUTH_SCHEME = "Bearer ";

function configuredAgentToken() {
  return process.env.STUDIO_AGENT_API_TOKEN?.trim() || null;
}

function requestBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith(AGENT_AUTH_SCHEME)) return null;
  return authorization.slice(AGENT_AUTH_SCHEME.length).trim() || null;
}

export async function guardAgentApiRequest(request: Request) {
  const expectedToken = configuredAgentToken();
  if (!expectedToken) {
    return NextResponse.json(
      { error: "Agent API is not configured." },
      { status: 503 },
    );
  }

  if (requestBearerToken(request) !== expectedToken) {
    return NextResponse.json(
      { error: "Unauthorized agent request." },
      { status: 401 },
    );
  }

  return null;
}
