import { db } from "@/db/client";
import { activityLogs, clients, projects } from "@/db/schema";
import { formatActivityAction } from "@/lib/format";
import { and, desc, eq, type SQL } from "drizzle-orm";

type ActivityInput = {
  projectId?: string | null;
  clientId?: string | null;
  action: string;
  actorType?: "admin" | "client" | "system" | "agent";
  actorName?: string | null;
  metadata?: Record<string, unknown>;
};

export async function logActivity({
  projectId,
  clientId,
  action,
  actorType = "admin",
  actorName = "Tyler",
  metadata,
}: ActivityInput) {
  const id = crypto.randomUUID();
  await db.insert(activityLogs).values({
    id,
    projectId,
    clientId,
    action,
    actorType,
    actorName,
    metadata: metadata ? JSON.stringify(metadata) : null,
    createdAt: new Date().toISOString(),
  });
  return id;
}

type ActivityActorType = "admin" | "client" | "system" | "agent";

type StudioActivityLogOptions = {
  limit?: number;
  actorType?: ActivityActorType | "all";
  projectId?: string;
};

function safeMetadata(value?: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return { raw: value };
  }
}

function clientDisplayName(client: typeof clients.$inferSelect | null) {
  if (!client) return null;
  const name = `${client.firstName ?? ""} ${client.lastName ?? ""}`.trim();
  return name || client.email || "Unnamed client";
}

export async function listStudioActivityLog({
  limit = 100,
  actorType = "all",
  projectId,
}: StudioActivityLogOptions = {}) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 250);
  const filters: SQL[] = [];
  if (actorType !== "all") filters.push(eq(activityLogs.actorType, actorType));
  if (projectId) filters.push(eq(activityLogs.projectId, projectId));

  const query = db
    .select({
      activity: activityLogs,
      project: projects,
      client: clients,
    })
    .from(activityLogs)
    .leftJoin(projects, eq(activityLogs.projectId, projects.id))
    .leftJoin(clients, eq(activityLogs.clientId, clients.id))
    .orderBy(desc(activityLogs.createdAt))
    .limit(safeLimit);

  const rows = filters.length
    ? await query.where(and(...filters))
    : await query;

  return rows.map(({ activity, project, client }) => ({
    id: activity.id,
    action: activity.action,
    label: formatActivityAction(activity.action),
    actorType: activity.actorType,
    actorName: activity.actorName,
    createdAt: activity.createdAt,
    metadata: safeMetadata(activity.metadata),
    project: project ? { id: project.id, name: project.name } : null,
    client: client ? { id: client.id, name: clientDisplayName(client), email: client.email } : null,
  }));
}
