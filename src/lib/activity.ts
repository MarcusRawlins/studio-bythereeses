import { db } from "@/db/client";
import { activityLogs } from "@/db/schema";

type ActivityInput = {
  projectId?: string | null;
  clientId?: string | null;
  action: string;
  actorType?: "admin" | "client" | "system";
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
  await db.insert(activityLogs).values({
    id: crypto.randomUUID(),
    projectId,
    clientId,
    action,
    actorType,
    actorName,
    metadata: metadata ? JSON.stringify(metadata) : null,
    createdAt: new Date().toISOString(),
  });
}
