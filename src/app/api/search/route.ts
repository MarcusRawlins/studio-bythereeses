import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { searchStudioProjects } from "@/lib/studio-mcp";
import { NextResponse } from "next/server";

function numberParam(value: string | null, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export async function GET(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const url = new URL(request.url);
    const projects = await searchStudioProjects({
      query: url.searchParams.get("q") ?? url.searchParams.get("query"),
      limit: numberParam(url.searchParams.get("limit"), 8),
    });

    return NextResponse.json({ projects });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Search failed." },
      { status: 400 },
    );
  }
}
