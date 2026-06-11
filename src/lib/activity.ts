import { db } from "@/db/client";
import { activityLogs } from "@/db/schema";

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
