import { db } from "@/db/client";
import { activityLogs, clients, invoices, portalAccessTokens, projectEvents, projectLocations, projectParticipants, projects, proposals } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { createGoogleCalendarAllDayEvent, deleteGoogleCalendarEvent, updateGoogleCalendarAllDayEvent } from "@/lib/google-calendar";
import { generatePortalLink, revokePortalToken } from "@/lib/portal";
import { projectEventCalendarStatusAfterEdit } from "@/lib/project-event-calendar";
import { getSchedulerSettings } from "@/lib/scheduler";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const projectStages = [
  "inquiry",
  "proposal_sent",
  "retainer_paid",
  "planning",
  "editing",
  "delivered",
  "completed",
];

export const projectStageOptions = projectStages.map((value) => ({
  value,
  label: value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()),
}));

function toCents(value: FormDataEntryValue | null) {
  const number = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number * 100);
}

function textValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function nullableTextValue(formData: FormData, key: string) {
  return textValue(formData, key) || null;
}

function formValues(formData: FormData, key: string) {
  return formData.getAll(key).map((value) => String(value ?? "").trim());
}

function at(values: string[], index: number) {
  return values[index]?.trim() || null;
}

function customType(type: string | null, custom: string | null) {
  return type === "other" && custom ? custom : type || "other";
}

function joinedText(...parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(", ");
}

function calendarDescription(...parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join("\n");
}

function projectStageValue(value: FormDataEntryValue | null) {
  const stage = String(value ?? "inquiry");
  if (!projectStages.includes(stage)) return "inquiry";
  return stage;
}

export async function listProjects() {
  return db
    .select({
      project: projects,
      client: clients,
    })
    .from(projectParticipants)
    .innerJoin(projects, eq(projectParticipants.projectId, projects.id))
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .orderBy(desc(projects.createdAt)) as unknown as Promise<Array<{
      project: typeof projects.$inferSelect;
      client: typeof clients.$inferSelect;
    }>>;
}

export async function listClients() {
  const rows = await db
    .select({
      client: clients,
      project: projects,
    })
    .from(clients)
    .leftJoin(projectParticipants, eq(projectParticipants.clientId, clients.id))
    .leftJoin(projects, eq(projectParticipants.projectId, projects.id))
    .orderBy(desc(clients.createdAt));

  const clientMap = new Map<string, { client: typeof clients.$inferSelect; projectCount: number; latestProjectDate: string | null }>();

  for (const row of rows) {
    const existing = clientMap.get(row.client.id) ?? {
      client: row.client,
      projectCount: 0,
      latestProjectDate: null,
    };

    if (row.project) {
      existing.projectCount += 1;
      const projectDate = row.project.eventDate ?? row.project.createdAt;
      if (!existing.latestProjectDate || String(projectDate).localeCompare(existing.latestProjectDate) > 0) {
        existing.latestProjectDate = projectDate;
      }
    }

    clientMap.set(row.client.id, existing);
  }

  return Array.from(clientMap.values());
}

export async function listRecentActivity(limit = 6) {
  return db.query.activityLogs.findMany({
    orderBy: desc(activityLogs.createdAt),
    limit,
  });
}

export async function getProject(projectId: string) {
  const rows = await db
    .select({
      project: projects,
      client: clients,
    })
    .from(projectParticipants)
    .innerJoin(projects, eq(projectParticipants.projectId, projects.id))
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(projects.id, projectId));

  const project = rows[0]?.project;
  if (!project) return null;

  const [tokens, activity, events, locations, projectProposals, projectInvoices] = await Promise.all([
    db.query.portalAccessTokens.findMany({
      where: eq(portalAccessTokens.projectId, projectId),
      orderBy: desc(portalAccessTokens.createdAt),
    }),
    db.query.activityLogs.findMany({
      where: eq(activityLogs.projectId, projectId),
      orderBy: desc(activityLogs.createdAt),
      limit: 12,
    }),
    db.query.projectEvents.findMany({
      where: eq(projectEvents.projectId, projectId),
      orderBy: desc(projectEvents.eventDate),
    }),
    db.query.projectLocations.findMany({
      where: eq(projectLocations.projectId, projectId),
      orderBy: desc(projectLocations.createdAt),
    }),
    db.query.proposals.findMany({
      where: eq(proposals.projectId, projectId),
      orderBy: desc(proposals.createdAt),
    }),
    db.query.invoices.findMany({
      where: eq(invoices.projectId, projectId),
      orderBy: desc(invoices.createdAt),
    }),
  ]);

  return {
    project,
    clients: rows.map((row) => row.client),
    events,
    locations,
    proposals: projectProposals,
    invoices: projectInvoices,
    tokens,
    activity,
  };
}

export async function getClientWithProjects(clientId: string) {
  const client = await db.query.clients.findFirst({
    where: eq(clients.id, clientId),
  });
  if (!client) return null;

  const linkedProjects = await db
    .select({
      project: projects,
      participant: projectParticipants,
    })
    .from(projectParticipants)
    .innerJoin(projects, eq(projectParticipants.projectId, projects.id))
    .where(eq(projectParticipants.clientId, clientId))
    .orderBy(desc(projects.createdAt)) as unknown as Array<{
      project: typeof projects.$inferSelect;
      participant: typeof projectParticipants.$inferSelect;
    }>;

  return {
    client,
    projects: linkedProjects,
  };
}

export async function listProjectsForClientLink(clientId: string) {
  const linkedRows = await db.query.projectParticipants.findMany({
    where: eq(projectParticipants.clientId, clientId),
  });
  if (linkedRows.length === 0) {
    return db.query.projects.findMany({
      orderBy: desc(projects.createdAt),
    });
  }

  return db.query.projects.findMany({
    where: notInArray(projects.id, linkedRows.map((row) => row.projectId)),
    orderBy: desc(projects.createdAt),
  });
}

async function findOrCreateClient({
  firstName,
  lastName,
  preferredName,
  email,
  phone,
  now,
}: {
  firstName: string;
  lastName: string | null;
  preferredName: string | null;
  email: string;
  phone: string | null;
  now: string;
}) {
  const existing = await db.query.clients.findFirst({
    where: eq(clients.email, email),
  });
  if (existing) return existing.id;

  const clientId = crypto.randomUUID();
  await db.insert(clients).values({
    id: clientId,
    firstName,
    lastName,
    email,
    phone,
    preferredName: preferredName || firstName,
    notes: null,
    createdAt: now,
    updatedAt: now,
  });
  return clientId;
}

export async function createProjectFromForm(formData: FormData) {
  const now = new Date().toISOString();
  const projectId = crypto.randomUUID();

  const firstName = String(formData.get("firstName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const projectName = String(formData.get("projectName") ?? "").trim();

  if (!firstName || !email || !projectName) {
    throw new Error("Client first name, email, and project name are required.");
  }

  const primaryClientId = await findOrCreateClient({
    firstName,
    lastName: nullableTextValue(formData, "lastName"),
    preferredName: nullableTextValue(formData, "preferredName"),
    email,
    phone: nullableTextValue(formData, "phone"),
    now,
  });

  const eventDate = nullableTextValue(formData, "eventDate");
  const venueName = nullableTextValue(formData, "venueName");
  const venueAddress = nullableTextValue(formData, "venueAddress");
  const city = nullableTextValue(formData, "city");
  const state = nullableTextValue(formData, "state");
  const calendarSyncStatus = eventDate ? "needs_google_connection" : "not_connected";

  await db.insert(projects).values({
    id: projectId,
    name: projectName,
    type: String(formData.get("type") ?? "wedding"),
    stage: String(formData.get("stage") ?? "inquiry"),
    status: "active",
    eventDate,
    venueName,
    venueAddress,
    city,
    state,
    budgetCents: toCents(formData.get("budget")),
    calendarSyncStatus,
    notes: String(formData.get("notes") ?? "").trim() || null,
    createdAt: now,
    updatedAt: now,
  });

  if (eventDate || venueName || venueAddress) {
    await db.insert(projectEvents).values({
      id: crypto.randomUUID(),
      projectId,
      type: "wedding",
      title: "Wedding day",
      eventDate,
      venueName,
      venueAddress,
      city,
      state,
      calendarSyncStatus,
      createdAt: now,
      updatedAt: now,
    });
  }

  const eventTitles = formValues(formData, "projectEventTitle");
  const eventDates = formValues(formData, "projectEventDate");
  const eventTypes = formValues(formData, "projectEventType");
  const eventCustomTypes = formValues(formData, "projectEventCustomType");
  const eventVenues = formValues(formData, "projectEventVenueName");
  const eventAddresses = formValues(formData, "projectEventVenueAddress");
  const eventCities = formValues(formData, "projectEventCity");
  const eventStates = formValues(formData, "projectEventState");

  for (let index = 0; index < eventTitles.length; index += 1) {
    const title = at(eventTitles, index);
    const date = at(eventDates, index);
    const eventVenue = at(eventVenues, index);
    const eventAddress = at(eventAddresses, index);
    if (!title && !date && !eventVenue && !eventAddress) continue;

    await db.insert(projectEvents).values({
      id: crypto.randomUUID(),
      projectId,
      type: customType(at(eventTypes, index), at(eventCustomTypes, index)),
      title: title || "Additional project event",
      eventDate: date,
      venueName: eventVenue,
      venueAddress: eventAddress,
      city: at(eventCities, index),
      state: at(eventStates, index),
      calendarSyncStatus: date ? "needs_google_connection" : "not_connected",
      createdAt: now,
      updatedAt: now,
    });
  }

  const locationNames = formValues(formData, "projectLocationName");
  const locationAddresses = formValues(formData, "projectLocationAddress");
  const locationTypes = formValues(formData, "projectLocationType");
  const locationCustomTypes = formValues(formData, "projectLocationCustomType");
  const locationCities = formValues(formData, "projectLocationCity");
  const locationStates = formValues(formData, "projectLocationState");
  const locationNotes = formValues(formData, "projectLocationNotes");

  for (let index = 0; index < locationNames.length; index += 1) {
    const name = at(locationNames, index);
    const address = at(locationAddresses, index);
    if (!name && !address) continue;

    await db.insert(projectLocations).values({
      id: crypto.randomUUID(),
      projectId,
      type: customType(at(locationTypes, index), at(locationCustomTypes, index)),
      name: name || "Project location",
      address,
      city: at(locationCities, index),
      state: at(locationStates, index),
      notes: at(locationNotes, index),
      createdAt: now,
      updatedAt: now,
    });
  }

  await db.insert(projectParticipants).values({
    id: crypto.randomUUID(),
    projectId,
    clientId: primaryClientId,
    role: textValue(formData, "primaryClientRole") || "primary",
    isPrimaryContact: true,
    createdAt: now,
  });

  const additionalFirstNames = formValues(formData, "additionalClientFirstName");
  const additionalLastNames = formValues(formData, "additionalClientLastName");
  const additionalPreferredNames = formValues(formData, "additionalClientPreferredName");
  const additionalEmails = formValues(formData, "additionalClientEmail");
  const additionalPhones = formValues(formData, "additionalClientPhone");
  const additionalRoles = formValues(formData, "additionalClientRole");
  const additionalCustomRoles = formValues(formData, "additionalClientCustomRole");

  for (let index = 0; index < additionalFirstNames.length; index += 1) {
    const extraFirstName = at(additionalFirstNames, index);
    const extraEmail = at(additionalEmails, index)?.toLowerCase() ?? null;
    if (!extraFirstName || !extraEmail) continue;

    const extraClientId = await findOrCreateClient({
      firstName: extraFirstName,
      lastName: at(additionalLastNames, index),
      preferredName: at(additionalPreferredNames, index),
      email: extraEmail,
      phone: at(additionalPhones, index),
      now,
    });

    await db.insert(projectParticipants).values({
      id: crypto.randomUUID(),
      projectId,
      clientId: extraClientId,
      role: customType(at(additionalRoles, index), at(additionalCustomRoles, index)),
      isPrimaryContact: false,
      createdAt: now,
    });
  }

  await logActivity({
    projectId,
    clientId: primaryClientId,
    action: "project.created",
    metadata: { projectName, clientEmail: email },
  });

  revalidatePath("/");
  revalidatePath("/projects");
  return projectId;
}

export async function createProjectAction(formData: FormData) {
  "use server";

  const projectId = await createProjectFromForm(formData);
  redirect(`/projects/${projectId}`);
}

export async function updateClientAction(formData: FormData) {
  "use server";

  const clientId = String(formData.get("clientId") ?? "");
  const firstName = String(formData.get("firstName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  if (!clientId || !firstName || !email) {
    throw new Error("Client first name and email are required.");
  }

  await db
    .update(clients)
    .set({
      firstName,
      lastName: String(formData.get("lastName") ?? "").trim() || null,
      preferredName: String(formData.get("preferredName") ?? "").trim() || null,
      email,
      phone: String(formData.get("phone") ?? "").trim() || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(clients.id, clientId));

  await logActivity({
    clientId,
    action: "client.updated",
    metadata: { clientEmail: email },
  });

  revalidatePath("/clients");
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/projects");
  redirect(`/clients/${clientId}`);
}

export async function linkClientToProjectAction(formData: FormData) {
  "use server";

  const clientId = textValue(formData, "clientId");
  const projectId = textValue(formData, "projectId");
  const role = customType(textValue(formData, "role"), nullableTextValue(formData, "customRole"));

  if (!clientId || !projectId) {
    throw new Error("Client and project are required.");
  }

  const existingRows = await db.query.projectParticipants.findMany({
    where: eq(projectParticipants.clientId, clientId),
  });
  const alreadyLinked = existingRows.some((row) => row.projectId === projectId);

  if (!alreadyLinked) {
    await db.insert(projectParticipants).values({
      id: crypto.randomUUID(),
      projectId,
      clientId,
      role,
      isPrimaryContact: false,
      createdAt: new Date().toISOString(),
    });
  }

  await logActivity({
    projectId,
    clientId,
    action: "client.linked_to_project",
    metadata: { role },
  });

  revalidatePath("/clients");
  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/projects/${projectId}`);
  redirect(`/clients/${clientId}`);
}

export async function updateProjectAction(formData: FormData) {
  "use server";

  const projectId = textValue(formData, "projectId");
  const existingProject = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!existingProject) {
    throw new Error("Project not found.");
  }

  const name = textValue(formData, "name");
  if (!name) {
    throw new Error("Project name is required.");
  }

  const updates = {
    name,
    type: textValue(formData, "type") || existingProject.type,
    stage: projectStageValue(formData.get("stage")),
    status: textValue(formData, "status") || "active",
    eventDate: nullableTextValue(formData, "eventDate"),
    venueName: nullableTextValue(formData, "venueName"),
    venueAddress: nullableTextValue(formData, "venueAddress"),
    city: nullableTextValue(formData, "city"),
    state: nullableTextValue(formData, "state"),
    budgetCents: toCents(formData.get("budgetCents")),
    calendarSyncStatus: nullableTextValue(formData, "eventDate") ? "needs_google_connection" : "not_connected",
    notes: nullableTextValue(formData, "notes"),
    updatedAt: new Date().toISOString(),
  };

  await db.update(projects).set(updates).where(eq(projects.id, projectId));

  const participant = await db.query.projectParticipants.findFirst({
    where: eq(projectParticipants.projectId, projectId),
  });

  const changedFields = Object.entries(updates)
    .filter(([key, value]) => key !== "updatedAt" && existingProject[key as keyof typeof existingProject] !== value)
    .map(([key]) => key);

  await logActivity({
    projectId,
    clientId: participant?.clientId ?? null,
    action: "project.updated",
    metadata: { changedFields },
  });

  revalidatePath("/");
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/edit`);
  redirect(`/projects/${projectId}`);
}

export async function updateProjectDetailsFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  if (!projectId) {
    throw new Error("Project is required.");
  }

  const existingProject = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!existingProject) {
    throw new Error("Project not found.");
  }

  const updates = {
    type: textValue(formData, "type") || existingProject.type,
    venueName: nullableTextValue(formData, "venueName"),
    venueAddress: nullableTextValue(formData, "venueAddress"),
    city: nullableTextValue(formData, "city"),
    state: nullableTextValue(formData, "state"),
    notes: nullableTextValue(formData, "notes"),
    updatedAt: new Date().toISOString(),
  };

  await db.update(projects).set(updates).where(eq(projects.id, projectId));

  const participant = await db.query.projectParticipants.findFirst({
    where: eq(projectParticipants.projectId, projectId),
  });

  const changedFields = Object.entries(updates)
    .filter(([key, value]) => key !== "updatedAt" && existingProject[key as keyof typeof existingProject] !== value)
    .map(([key]) => key);

  await logActivity({
    projectId,
    clientId: participant?.clientId ?? null,
    action: "project.details_updated",
    metadata: { changedFields },
  });

  revalidatePath("/");
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/edit`);
  return projectId;
}

export async function updateProjectStageFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const nextStage = projectStageValue(formData.get("stage"));
  const existingProject = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!existingProject) {
    throw new Error("Project not found.");
  }

  if (existingProject.stage !== nextStage) {
    await db
      .update(projects)
      .set({
        stage: nextStage,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(projects.id, projectId));

    const participant = await db.query.projectParticipants.findFirst({
      where: eq(projectParticipants.projectId, projectId),
    });

    await logActivity({
      projectId,
      clientId: participant?.clientId ?? null,
      action: "project.stage_changed",
      metadata: { from: existingProject.stage, to: nextStage },
    });
  }

  revalidatePath("/");
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  return projectId;
}

export async function updateProjectStageAction(formData: FormData) {
  "use server";

  const projectId = await updateProjectStageFromForm(formData);
  redirect(`/projects/${projectId}`);
}

export async function addProjectEventFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const title = textValue(formData, "title");
  const eventDate = nullableTextValue(formData, "eventDate");

  if (!projectId || !title) {
    throw new Error("Project and event title are required.");
  }

  const participant = await db.query.projectParticipants.findFirst({
    where: eq(projectParticipants.projectId, projectId),
  });
  const now = new Date().toISOString();

  await db.insert(projectEvents).values({
    id: crypto.randomUUID(),
    projectId,
    type: customType(textValue(formData, "type"), nullableTextValue(formData, "customType")),
    title,
    eventDate,
    venueName: nullableTextValue(formData, "venueName"),
    venueAddress: nullableTextValue(formData, "venueAddress"),
    city: nullableTextValue(formData, "city"),
    state: nullableTextValue(formData, "state"),
    calendarSyncStatus: eventDate ? "needs_google_connection" : "not_connected",
    notes: nullableTextValue(formData, "notes"),
    createdAt: now,
    updatedAt: now,
  });

  await logActivity({
    projectId,
    clientId: participant?.clientId ?? null,
    action: "project.event_added",
    metadata: { title, eventDate },
  });

  revalidatePath("/");
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  return projectId;
}

export async function addProjectEventAction(formData: FormData) {
  "use server";

  const projectId = await addProjectEventFromForm(formData);
  redirect(`/projects/${projectId}`);
}

export async function updateProjectEventFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const eventId = textValue(formData, "eventId");
  const title = textValue(formData, "title");
  const eventDate = nullableTextValue(formData, "eventDate");

  if (!projectId || !eventId || !title) {
    throw new Error("Project, event, and title are required.");
  }

  const [project, event, participant] = await Promise.all([
    db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
    db.query.projectEvents.findFirst({ where: eq(projectEvents.id, eventId) }),
    db.query.projectParticipants.findFirst({ where: eq(projectParticipants.projectId, projectId) }),
  ]);

  if (!project || !event || event.projectId !== projectId) {
    throw new Error("Project event not found.");
  }

  const settings = await getSchedulerSettings();
  const calendarId = settings?.googleCreateCalendarId || "hello@bythereeses.com";
  const type = customType(textValue(formData, "type"), nullableTextValue(formData, "customType"));
  const venueName = nullableTextValue(formData, "venueName");
  const venueAddress = nullableTextValue(formData, "venueAddress");
  const city = nullableTextValue(formData, "city");
  const state = nullableTextValue(formData, "state");
  const notes = nullableTextValue(formData, "notes");
  const now = new Date().toISOString();
  let googleCalendarEventId = event.googleCalendarEventId;
  let calendarSyncStatus = projectEventCalendarStatusAfterEdit({
    eventDate,
    googleCalendarEventId,
  });

  if (event.googleCalendarEventId && eventDate) {
    const updatedGoogleEventId = await updateGoogleCalendarAllDayEvent({
      eventId: event.googleCalendarEventId,
      summary: `${project.name}: ${title}`,
      date: eventDate,
      calendarId,
      location: joinedText(venueName, venueAddress, city, state),
      description: calendarDescription(
        project.name,
        type ? `Type: ${type.replaceAll("_", " ")}` : null,
        notes,
      ),
    });
    googleCalendarEventId = updatedGoogleEventId ?? event.googleCalendarEventId;
    calendarSyncStatus = updatedGoogleEventId ? "synced" : "sync_failed";
  }

  if (event.googleCalendarEventId && !eventDate) {
    const deleted = await deleteGoogleCalendarEvent({
      calendarId,
      eventId: event.googleCalendarEventId,
    });
    googleCalendarEventId = deleted ? null : event.googleCalendarEventId;
    calendarSyncStatus = deleted ? "not_connected" : "sync_failed";
  }

  await db
    .update(projectEvents)
    .set({
      type,
      title,
      eventDate,
      venueName,
      venueAddress,
      city,
      state,
      googleCalendarEventId,
      calendarSyncStatus,
      notes,
      updatedAt: now,
    })
    .where(eq(projectEvents.id, event.id));

  await logActivity({
    projectId,
    clientId: participant?.clientId ?? null,
    action: "project.event_updated",
    metadata: { eventId, title, eventDate, calendarSyncStatus },
  });

  revalidatePath("/");
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  return projectId;
}

export async function updateProjectEventAction(formData: FormData) {
  "use server";

  const projectId = await updateProjectEventFromForm(formData);
  redirect(`/projects/${projectId}?saved=event`);
}

export async function syncProjectCalendarFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const eventId = nullableTextValue(formData, "eventId");

  if (!projectId) {
    throw new Error("Project is required.");
  }

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!project) {
    throw new Error("Project not found.");
  }

  const participant = await db.query.projectParticipants.findFirst({
    where: eq(projectParticipants.projectId, projectId),
  });
  const settings = await getSchedulerSettings();
  const calendarId = settings?.googleCreateCalendarId || "hello@bythereeses.com";
  const now = new Date().toISOString();

  if (eventId) {
    const event = await db.query.projectEvents.findFirst({
      where: eq(projectEvents.id, eventId),
    });

    if (!event || event.projectId !== projectId) {
      throw new Error("Project event not found.");
    }

    if (!event.eventDate) {
      return { ok: false, kind: "calendar-event" as const, reason: "missing_date" as const };
    }

    if (event.googleCalendarEventId && event.calendarSyncStatus === "synced") {
      return { ok: true, kind: "calendar-event" as const, alreadySynced: true };
    }

    const googleEventId = await createGoogleCalendarAllDayEvent({
      summary: `${project.name}: ${event.title}`,
      date: event.eventDate,
      calendarId,
      location: joinedText(event.venueName, event.venueAddress, event.city, event.state),
      description: calendarDescription(
        project.name,
        event.type ? `Type: ${event.type.replaceAll("_", " ")}` : null,
        event.notes,
      ),
    });

    await db
      .update(projectEvents)
      .set({
        googleCalendarEventId: googleEventId,
        calendarSyncStatus: googleEventId ? "synced" : "sync_failed",
        updatedAt: now,
      })
      .where(eq(projectEvents.id, event.id));

    await logActivity({
      projectId,
      clientId: participant?.clientId ?? null,
      action: googleEventId ? "project_event.calendar_synced" : "project_event.calendar_sync_failed",
      metadata: { eventId: event.id, googleEventId, calendarId },
    });

    revalidatePath("/");
    revalidatePath("/projects");
    revalidatePath(`/projects/${projectId}`);
    return { ok: Boolean(googleEventId), kind: "calendar-event" as const };
  }

  if (!project.eventDate) {
    return { ok: false, kind: "calendar" as const, reason: "missing_date" as const };
  }

  if (project.googleCalendarEventId && project.calendarSyncStatus === "synced") {
    return { ok: true, kind: "calendar" as const, alreadySynced: true };
  }

  const googleEventId = await createGoogleCalendarAllDayEvent({
    summary: project.name,
    date: project.eventDate,
    calendarId,
    location: joinedText(project.venueName, project.venueAddress, project.city, project.state),
    description: calendarDescription(
      project.type ? `Type: ${project.type.replaceAll("_", " ")}` : null,
      project.notes,
    ),
  });

  await db
    .update(projects)
    .set({
      googleCalendarEventId: googleEventId,
      calendarSyncStatus: googleEventId ? "synced" : "sync_failed",
      updatedAt: now,
    })
    .where(eq(projects.id, project.id));

  await logActivity({
    projectId,
    clientId: participant?.clientId ?? null,
    action: googleEventId ? "project.calendar_synced" : "project.calendar_sync_failed",
    metadata: { googleEventId, calendarId },
  });

  revalidatePath("/");
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  return { ok: Boolean(googleEventId), kind: "calendar" as const };
}

export async function createPortalLinkFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  if (!projectId) {
    throw new Error("Project is required.");
  }

  const clientId = textValue(formData, "clientId") || null;
  const url = await generatePortalLink(projectId, clientId);
  return { projectId, url };
}

export async function generatePortalLinkAction(formData: FormData) {
  "use server";

  const { projectId, url } = await createPortalLinkFromForm(formData);
  redirect(`/projects/${projectId}?portalLink=${encodeURIComponent(url)}`);
}

export async function revokePortalTokenFromForm(formData: FormData) {
  const projectId = textValue(formData, "projectId");
  const tokenId = textValue(formData, "tokenId");
  if (!projectId || !tokenId) {
    throw new Error("Project and token are required.");
  }

  const token = await db.query.portalAccessTokens.findFirst({
    where: and(eq(portalAccessTokens.id, tokenId), eq(portalAccessTokens.projectId, projectId)),
  });
  if (!token) {
    throw new Error("Portal token was not found for this project.");
  }

  await revokePortalToken(tokenId);
  revalidatePath(`/projects/${projectId}`);
  return projectId;
}

export async function revokePortalTokenAction(formData: FormData) {
  "use server";

  const projectId = await revokePortalTokenFromForm(formData);
  redirect(`/projects/${projectId}`);
}
