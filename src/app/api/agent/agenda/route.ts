import { getAgenda, type AgendaCategory } from "@/lib/agenda";
import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { dateKeyInTimeZone } from "@/lib/timezone";

const agendaCategorySet = new Set<AgendaCategory>(["wedding", "engagement", "other", "call"]);

function optionalStringParam(url: URL, key: string) {
  const value = url.searchParams.get(key)?.trim();
  return value || undefined;
}

function agendaTypesParam(url: URL) {
  const values = [
    ...url.searchParams.getAll("type"),
    ...url.searchParams.getAll("types").flatMap((value) => value.split(",")),
  ];
  const types = values
    .map((value) => value.trim())
    .filter((value): value is AgendaCategory => agendaCategorySet.has(value as AgendaCategory));

  return types.length ? Array.from(new Set(types)) : undefined;
}

function limitParam(url: URL) {
  const rawLimit = Number(url.searchParams.get("limit") ?? "");
  if (!Number.isFinite(rawLimit) || rawLimit <= 0) return undefined;
  return Math.min(Math.trunc(rawLimit), 100);
}

export async function GET(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const unauthorized = await guardAgentApiRequest(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const timeZone = optionalStringParam(url, "timeZone") ?? "America/New_York";
  const agenda = await getAgenda({
    fromDate: optionalStringParam(url, "fromDate") ?? dateKeyInTimeZone(new Date(), timeZone),
    toDate: optionalStringParam(url, "toDate"),
    types: agendaTypesParam(url),
    limit: limitParam(url),
    timeZone,
  });

  return Response.json({ agenda });
}
