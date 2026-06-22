import { db } from "@/db/client";
import { clients, projectParticipants, projects } from "@/db/schema";
import type { QuestionnaireLinkContext } from "@/lib/questionnaire-links";
import { asc, eq } from "drizzle-orm";

function clientName(client: Pick<typeof clients.$inferSelect, "firstName" | "lastName" | "preferredName" | "email">) {
  return client.preferredName || [client.firstName, client.lastName].filter(Boolean).join(" ") || client.email;
}

export async function getQuestionnairePublicHeaderName(context: QuestionnaireLinkContext | null) {
  if (!context?.projectId) return "Questionnaire";

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, context.projectId),
  });
  if (project?.name) return project.name;

  if (context.clientId) {
    const client = await db.query.clients.findFirst({
      where: eq(clients.id, context.clientId),
    });
    if (client) return clientName(client);
  }

  const [participant] = await db.select({
    firstName: clients.firstName,
    lastName: clients.lastName,
    preferredName: clients.preferredName,
    email: clients.email,
  })
    .from(projectParticipants)
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(projectParticipants.projectId, context.projectId))
    .orderBy(asc(projectParticipants.createdAt))
    .limit(1);

  return participant ? clientName(participant) : "Questionnaire";
}
