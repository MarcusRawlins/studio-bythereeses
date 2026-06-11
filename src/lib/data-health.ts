import { db } from "@/db/client";
import {
  agentTasks,
  clients,
  expenses,
  invoicePayments,
  invoices,
  projectCommunications,
  projectEvents,
  projectLocations,
  projectParticipants,
  projects,
  projectTimelineItems,
  proposals,
  questionnaireResponses,
} from "@/db/schema";
import { asc, desc, eq } from "drizzle-orm";

type HealthRecord = {
  id: string;
  name: string;
};

type HealthClient = HealthRecord & {
  email: string;
};

export type StudioDataHealthIssue = {
  id: string;
  type:
    | "project_without_client"
    | "project_without_primary_client"
    | "client_without_project"
    | "questionnaire_project_field_mismatch"
    | "agent_task_output_source_mismatch"
    | "invoice_paid_amount_mismatch"
    | "invoice_payment_schedule_mismatch";
  severity: "high" | "medium";
  label: string;
  detail: string;
  repair: {
    label: string;
    href: string;
    agentWorkflow: string;
    agentTools: string[];
  };
  project?: HealthRecord;
  client?: HealthClient;
  invoice?: HealthRecord;
};

export type StudioDataHealth = {
  summary: {
    projectCount: number;
    clientCount: number;
    invoiceCount: number;
    issueCount: number;
    highIssueCount: number;
    mediumIssueCount: number;
  };
  issues: StudioDataHealthIssue[];
};

function clientName(client: typeof clients.$inferSelect) {
  return [client.firstName, client.lastName].filter(Boolean).join(" ");
}

type StoredQuestionnaireAnswer = {
  title?: string;
  value?: unknown;
};

function normalizedQuestionTitle(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseQuestionnaireAnswers(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((answer): answer is StoredQuestionnaireAnswer => typeof answer === "object" && answer !== null);
  } catch {
    return [];
  }
}

function cleanTextAnswer(value: unknown) {
  return typeof value === "string" ? value.trim() || null : null;
}

function textAnswerForProject(answers: StoredQuestionnaireAnswer[], matcher: (title: string) => boolean) {
  for (const answer of answers) {
    const title = normalizedQuestionTitle(String(answer.title ?? ""));
    if (!matcher(title)) continue;
    const value = cleanTextAnswer(answer.value);
    if (value) return value;
  }

  return null;
}

function dateAnswerForProject(answers: StoredQuestionnaireAnswer[], matcher: (title: string) => boolean) {
  const value = textAnswerForProject(answers, matcher);
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

function questionnaireProjectFields(answersJson: string) {
  const answers = parseQuestionnaireAnswers(answersJson);
  return {
    eventDate: dateAnswerForProject(
      answers,
      (title) => title.includes("wedding date") || title.includes("event date") || title === "date",
    ),
    venueName: textAnswerForProject(
      answers,
      (title) => (title.includes("venue") || title.includes("location")) && !title.includes("address"),
    ),
    venueAddress: textAnswerForProject(
      answers,
      (title) => title.includes("venue address") || title === "address" || title.includes("location address"),
    ),
    city: textAnswerForProject(
      answers,
      (title) => title.includes("wedding city") || title.includes("event city") || title === "city",
    ),
    state: textAnswerForProject(
      answers,
      (title) => title.includes("wedding state") || title.includes("event state") || title === "state",
    ),
  };
}

function questionnaireProjectFieldMismatches(
  project: typeof projects.$inferSelect,
  response: typeof questionnaireResponses.$inferSelect,
) {
  const fields = questionnaireProjectFields(response.answersJson);
  return [
    { label: "Wedding date", projectValue: project.eventDate, responseValue: fields.eventDate },
    { label: "Venue name", projectValue: project.venueName, responseValue: fields.venueName },
    { label: "Venue address", projectValue: project.venueAddress, responseValue: fields.venueAddress },
    { label: "Wedding city", projectValue: project.city, responseValue: fields.city },
    { label: "Wedding state", projectValue: project.state, responseValue: fields.state },
  ].filter((field) => field.responseValue && field.responseValue !== field.projectValue);
}

function parseOutputJson(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function outputIds(output: Record<string, unknown>, singularKey: string, arrayKey: string) {
  const ids: string[] = [];
  const singular = output[singularKey];
  if (typeof singular === "string" && singular.trim()) ids.push(singular.trim());

  const array = output[arrayKey];
  if (Array.isArray(array)) {
    ids.push(...array.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()));
  }

  return Array.from(new Set(ids));
}

type SourceLinkedOutputRow = {
  id: string;
  projectId: string | null;
  sourceType: string | null;
  sourceId: string | null;
};

function outputCitationMismatches(
  task: typeof agentTasks.$inferSelect,
  output: Record<string, unknown>,
  outputMaps: Record<string, Map<string, SourceLinkedOutputRow>>,
) {
  if (task.sourceType !== "project_source" || !task.sourceId) return [];

  const checks: Array<{
    label: string;
    singularKey: string;
    arrayKey: string;
    rows: Map<string, SourceLinkedOutputRow>;
  }> = [
    { label: "proposal", singularKey: "proposalId", arrayKey: "proposalIds", rows: outputMaps.proposals },
    { label: "invoice", singularKey: "invoiceId", arrayKey: "invoiceIds", rows: outputMaps.invoices },
    { label: "invoice payment", singularKey: "invoicePaymentId", arrayKey: "invoicePaymentIds", rows: outputMaps.invoicePayments },
    { label: "payment", singularKey: "paymentId", arrayKey: "paymentIds", rows: outputMaps.invoicePayments },
    { label: "timeline item", singularKey: "timelineId", arrayKey: "timelineIds", rows: outputMaps.timelineItems },
    { label: "project event", singularKey: "eventId", arrayKey: "eventIds", rows: outputMaps.events },
    { label: "project location", singularKey: "locationId", arrayKey: "locationIds", rows: outputMaps.locations },
    { label: "communication", singularKey: "communicationId", arrayKey: "communicationIds", rows: outputMaps.communications },
    { label: "expense", singularKey: "expenseId", arrayKey: "expenseIds", rows: outputMaps.expenses },
  ];

  return checks.flatMap((check) => outputIds(output, check.singularKey, check.arrayKey).flatMap((id) => {
    const row = check.rows.get(id);
    if (!row) return [];
    if (row.projectId !== task.projectId) return [`${check.label} ${id} belongs to a different project`];
    if (row.sourceType !== task.sourceType || row.sourceId !== task.sourceId) {
      return [`${check.label} ${id} does not cite source ${task.sourceId}`];
    }
    return [];
  }));
}

export async function listStudioDataHealth(): Promise<StudioDataHealth> {
  const [
    projectRows,
    clientRows,
    participantRows,
    invoiceRows,
    paymentRows,
    submittedQuestionnaireResponses,
    agentTaskRows,
    proposalRows,
    timelineRows,
    eventRows,
    locationRows,
    communicationRows,
    expenseRows,
  ] = await Promise.all([
    db.select().from(projects).orderBy(desc(projects.createdAt)),
    db.select().from(clients).orderBy(asc(clients.firstName), asc(clients.lastName)),
    db
      .select({
        participant: projectParticipants,
        project: projects,
        client: clients,
      })
      .from(projectParticipants)
      .leftJoin(projects, eq(projectParticipants.projectId, projects.id))
      .leftJoin(clients, eq(projectParticipants.clientId, clients.id)),
    db
      .select({
        invoice: invoices,
        project: projects,
      })
      .from(invoices)
      .innerJoin(projects, eq(invoices.projectId, projects.id))
      .orderBy(asc(invoices.invoiceNumber)),
    db.select().from(invoicePayments),
    db.select().from(questionnaireResponses).where(eq(questionnaireResponses.submittedAt, questionnaireResponses.submittedAt)),
    db.select().from(agentTasks).orderBy(desc(agentTasks.createdAt)),
    db.select().from(proposals),
    db.select().from(projectTimelineItems),
    db.select().from(projectEvents),
    db.select().from(projectLocations),
    db.select().from(projectCommunications),
    db.select().from(expenses),
  ]);

  const participantsByProject = new Map<string, typeof participantRows>();
  const participantsByClient = new Map<string, typeof participantRows>();
  const paymentsByInvoice = new Map<string, Array<typeof invoicePayments.$inferSelect>>();
  const submittedResponsesByProject = new Map<string, Array<typeof questionnaireResponses.$inferSelect>>();

  for (const row of participantRows) {
    const projectId = row.participant.projectId;
    const clientId = row.participant.clientId;
    participantsByProject.set(projectId, [...(participantsByProject.get(projectId) ?? []), row]);
    participantsByClient.set(clientId, [...(participantsByClient.get(clientId) ?? []), row]);
  }

  for (const payment of paymentRows) {
    paymentsByInvoice.set(payment.invoiceId, [...(paymentsByInvoice.get(payment.invoiceId) ?? []), payment]);
  }

  for (const response of submittedQuestionnaireResponses) {
    if (!response.projectId || !response.submittedAt) continue;
    submittedResponsesByProject.set(response.projectId, [...(submittedResponsesByProject.get(response.projectId) ?? []), response]);
  }

  const issues: StudioDataHealthIssue[] = [];
  const projectsById = new Map(projectRows.map((project) => [project.id, project]));
  const invoiceProjectsById = new Map(invoiceRows.map((row) => [row.invoice.id, row.project.id]));
  const outputMaps = {
    proposals: new Map(proposalRows.map((row) => [row.id, row] satisfies [string, SourceLinkedOutputRow])),
    invoices: new Map(invoiceRows.map((row) => [row.invoice.id, row.invoice] satisfies [string, SourceLinkedOutputRow])),
    invoicePayments: new Map(paymentRows.map((row) => [row.id, {
      id: row.id,
      projectId: invoiceProjectsById.get(row.invoiceId) ?? null,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
    }] satisfies [string, SourceLinkedOutputRow])),
    timelineItems: new Map(timelineRows.map((row) => [row.id, row] satisfies [string, SourceLinkedOutputRow])),
    events: new Map(eventRows.map((row) => [row.id, row] satisfies [string, SourceLinkedOutputRow])),
    locations: new Map(locationRows.map((row) => [row.id, row] satisfies [string, SourceLinkedOutputRow])),
    communications: new Map(communicationRows.map((row) => [row.id, row] satisfies [string, SourceLinkedOutputRow])),
    expenses: new Map(expenseRows.map((row) => [row.id, row] satisfies [string, SourceLinkedOutputRow])),
  };

  for (const project of projectRows) {
    const projectParticipantsForProject = participantsByProject.get(project.id) ?? [];
    const projectRef = { id: project.id, name: project.name };

    if (projectParticipantsForProject.length === 0) {
      issues.push({
        id: `project_without_client:${project.id}`,
        type: "project_without_client",
        severity: "high",
        label: "Project has no linked client",
        detail: "This canonical project can disappear from client-centered views until a primary client is linked.",
        repair: {
          label: "Link an existing client",
          href: `/projects/${project.id}`,
          agentWorkflow: "Use studio_search_projects and studio_get_client_context to identify the correct existing client, then call studio_link_client_to_project. If that client should be primary, call studio_update_project with primaryClientId.",
          agentTools: ["studio_search_projects", "studio_get_client_context", "studio_link_client_to_project", "studio_update_project"],
        },
        project: projectRef,
      });
      continue;
    }

    if (!projectParticipantsForProject.some((row) => row.participant.isPrimaryContact)) {
      issues.push({
        id: `project_without_primary_client:${project.id}`,
        type: "project_without_primary_client",
        severity: "high",
        label: "Project has no primary client",
        detail: "The project has client links, but none is marked as the primary contact for proposals, invoices, and agent context.",
        repair: {
          label: "Choose primary client",
          href: `/projects/${project.id}`,
          agentWorkflow: "Use studio_get_project_context to inspect linked clients, then call studio_update_project with primaryClientId for the correct linked client.",
          agentTools: ["studio_get_project_context", "studio_update_project"],
        },
        project: projectRef,
      });
    }

    const fieldMismatches = (submittedResponsesByProject.get(project.id) ?? [])
      .flatMap((response) => questionnaireProjectFieldMismatches(project, response).map((field) => ({
        ...field,
        responseId: response.id,
      })));
    if (fieldMismatches.length) {
      issues.push({
        id: `questionnaire_project_field_mismatch:${project.id}`,
        type: "questionnaire_project_field_mismatch",
        severity: "high",
        label: "Questionnaire project facts differ from project record",
        detail: fieldMismatches
          .map((field) => `${field.label}: project is ${field.projectValue ?? "blank"}, questionnaire says ${field.responseValue}`)
          .join("; "),
        repair: {
          label: "Review questionnaire sync",
          href: `/projects/${project.id}`,
          agentWorkflow: "Use studio_get_project_context to compare submitted questionnaire answers with the canonical project fields, then call studio_update_project with the correct date, venue, and location facts.",
          agentTools: ["studio_get_project_context", "studio_update_project"],
        },
        project: projectRef,
      });
    }
  }

  for (const task of agentTaskRows) {
    const output = parseOutputJson(task.outputJson);
    if (!task.projectId || !output || task.sourceType !== "project_source" || !task.sourceId) continue;

    const mismatches = outputCitationMismatches(task, output, outputMaps);
    if (!mismatches.length) continue;

    const project = projectsById.get(task.projectId);
    issues.push({
      id: `agent_task_output_source_mismatch:${task.id}`,
      type: "agent_task_output_source_mismatch",
      severity: "high",
      label: "Agent task output is missing source citation",
      detail: `${task.title}: ${mismatches.join("; ")}.`,
      repair: {
        label: "Review agent task output",
        href: `/projects/${task.projectId}`,
        agentWorkflow: "Use studio_get_project_context and studio_list_agent_tasks to inspect the source-linked task, then update the generated output or task result so every cited proposal, invoice, timeline item, event, location, communication, or expense points back to the same project source.",
        agentTools: ["studio_get_project_context", "studio_list_agent_tasks", "studio_update_agent_task", "studio_update_proposal"],
      },
      project: project ? { id: project.id, name: project.name } : { id: task.projectId, name: task.projectId },
    });
  }

  for (const row of invoiceRows) {
    const invoice = row.invoice;
    const invoicePaymentRows = paymentsByInvoice.get(invoice.id) ?? [];
    const invoiceRef = { id: invoice.id, name: invoice.invoiceNumber };
    const projectRef = { id: row.project.id, name: row.project.name };
    const paidLedgerCents = invoicePaymentRows.reduce((sum, payment) => {
      if (payment.status !== "paid") return sum;
      return sum + payment.paidAmountCents;
    }, 0);
    const scheduledCents = invoicePaymentRows.reduce((sum, payment) => sum + payment.amountCents, 0);

    if (invoice.amountPaidCents !== paidLedgerCents) {
      issues.push({
        id: `invoice_paid_amount_mismatch:${invoice.id}`,
        type: "invoice_paid_amount_mismatch",
        severity: "high",
        label: "Invoice paid total does not match payment ledger",
        detail: `The invoice summary says ${invoice.amountPaidCents} cents paid, but paid payment rows total ${paidLedgerCents} cents.`,
        repair: {
          label: "Reconcile payment ledger",
          href: `/invoices/${invoice.id}`,
          agentWorkflow: "Use studio_get_project_context and the invoice payment ledger to compare paid invoice payments with the invoice summary, then use studio_record_invoice_payment or the invoice payment editor to correct the canonical payment rows.",
          agentTools: ["studio_get_project_context", "studio_record_invoice_payment", "studio_update_invoice_payment"],
        },
        project: projectRef,
        invoice: invoiceRef,
      });
    }

    if (invoice.status !== "draft" && invoice.status !== "void" && scheduledCents !== invoice.totalCents) {
      issues.push({
        id: `invoice_payment_schedule_mismatch:${invoice.id}`,
        type: "invoice_payment_schedule_mismatch",
        severity: "high",
        label: "Invoice payment schedule does not match invoice total",
        detail: `The invoice total is ${invoice.totalCents} cents, but scheduled payment rows total ${scheduledCents} cents.`,
        repair: {
          label: "Repair payment schedule",
          href: `/invoices/${invoice.id}`,
          agentWorkflow: "Use studio_get_project_context to inspect the invoice and proposal scope, then update the invoice payment schedule so scheduled payments equal the canonical invoice total.",
          agentTools: ["studio_get_project_context", "studio_update_invoice"],
        },
        project: projectRef,
        invoice: invoiceRef,
      });
    }
  }

  for (const client of clientRows) {
    if (participantsByClient.has(client.id)) continue;

    issues.push({
      id: `client_without_project:${client.id}`,
      type: "client_without_project",
      severity: "medium",
      label: "Client is not linked to a project",
      detail: "This client exists as a canonical contact but is not attached to any project yet.",
      repair: {
        label: "Create or link project",
        href: `/clients/${client.id}`,
        agentWorkflow: "Use studio_get_client_context first. If this client belongs to an existing project, call studio_link_client_to_project. If no project exists yet, call studio_create_project with primaryClient.clientId.",
        agentTools: ["studio_get_client_context", "studio_search_projects", "studio_link_client_to_project", "studio_create_project"],
      },
      client: {
        id: client.id,
        name: clientName(client),
        email: client.email,
      },
    });
  }

  const highIssueCount = issues.filter((issue) => issue.severity === "high").length;
  const mediumIssueCount = issues.filter((issue) => issue.severity === "medium").length;

  return {
    summary: {
      projectCount: projectRows.length,
      clientCount: clientRows.length,
      invoiceCount: invoiceRows.length,
      issueCount: issues.length,
      highIssueCount,
      mediumIssueCount,
    },
    issues,
  };
}
