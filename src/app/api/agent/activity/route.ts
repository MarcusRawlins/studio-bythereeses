import { listStudioActivityLog } from "@/lib/activity";
import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";

type ActivityActor = "all" | "admin" | "agent" | "client" | "system";

const activityActors = new Set<ActivityActor>(["all", "admin", "agent", "client", "system"]);

function actorParam(url: URL): ActivityActor {
  const value = url.searchParams.get("actor") ?? url.searchParams.get("actorType") ?? "all";
  return activityActors.has(value as ActivityActor) ? value as ActivityActor : "all";
}

function limitParam(url: URL) {
  const rawLimit = Number(url.searchParams.get("limit") ?? "");
  if (!Number.isFinite(rawLimit) || rawLimit <= 0) return undefined;
  return Math.min(Math.trunc(rawLimit), 150);
}

function optionalStringParam(url: URL, key: string) {
  const value = url.searchParams.get(key)?.trim();
  return value || undefined;
}

export async function GET(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const unauthorized = await guardAgentApiRequest(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const activity = await listStudioActivityLog({
    actorType: actorParam(url),
    projectId: optionalStringParam(url, "projectId"),
    limit: limitParam(url),
  });

  return Response.json({ activity });
}
