import { db } from "@/db/client";
import { agentTasks, clients, expenses, invoicePayments, invoices, projectParticipants, projects, projectWorkflowRuns, projectWorkflowSteps, proposalLineItems, proposals, questionnaireResponses, questionnaires, schedulerBookings, schedulerMeetingTypes, templates, vendors } from "@/db/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { createProjectSourceFromAgent, updateProjectSourceFromAgent } from "./agent-sources";
import { attachProjectGalleryFromAgent, type AgentGalleryAttachInput } from "./gallery";
import { claimNextAgentTask, createAgentTask, hydrateAgentTaskLinkedSource, hydrateAgentTaskLinkedSources, listAgentTasks, updateAgentTaskStatus } from "./agent-tasks";
import { getAgentFinanceReport } from "./agent-finance";
import { getBusinessReview } from "./intelligence";
import { getAgenda, type AgendaCategory } from "./agenda";
import { listStudioActivityLog } from "./activity";
import { createExpenseFromAgent, updateExpenseFromAgent, type AgentExpenseInput, type AgentExpenseUpdateInput } from "./bookkeeping";
import { createProjectEventFromAgent, createProjectFromAgent, createProjectLocationFromAgent, getClientWithProjects, getProject, linkClientToProject, listProjectIndex, mergeClients, updateClientFromAgent, updateProjectEventFromAgent, updateProjectFromAgent, updateProjectLocationFromAgent, type AgentClientUpdateInput, type AgentProjectCreateInput, type AgentProjectEventInput, type AgentProjectLocationInput, type AgentProjectUpdateInput, type ProjectIndexSort } from "./crm";
import { listStudioDataHealth } from "./data-health";
import { invoiceClientPayableBalanceCents, invoiceClientPayableCents, isSettledInvoicePaymentStatus } from "./invoice-balances";
import { createProjectCommunicationFromAgent, updateProjectCommunicationFromAgent } from "./project-communications";
import { summarizeProjectFinancials } from "./project-finance";
import { createProjectTimelineItem, createProjectTimelineItemsFromAgent, updateProjectTimelineItem } from "./project-timeline";
import { completeProjectWorkflowAgentTask } from "./project-workflow-execution";
import { enableSixFigureWorkflowForProject, listProjectWorkflowRuns, queueProjectWorkflowSteps, sixFigureAutomationSteps } from "./project-workflow-automation";
import { createProjectQuestionnaireResponseDraft, createQuestionnaireLinkFromAgent, formatQuestionnaireAnswerValue, getQuestionnaireResponseDetail, listStudioQuestionnaires, questionnaireResponseStatus, updateQuestionnaireResponseAnswers, type AgentQuestionnaireLinkInput, type QuestionnaireAnswerInput } from "./questionnaires";
import { createPortalLinkFromAgent } from "./portal";
import { createInvoiceFromAgent, createProposalFromAgent, createProposalLinkFromAgent, logInvoiceReminderFromAgent, recordInvoicePaymentFromAgent, updateInvoiceFromAgent, updateInvoicePaymentFromAgent, updateProposalFromAgent, type AgentInvoiceInput, type AgentInvoicePaymentInput, type AgentInvoiceReminderInput, type AgentInvoiceUpdateInput, type AgentProposalInput, type AgentProposalLinkInput, type AgentProposalUpdateInput } from "./sales";
import { listStudioSchedulerMeetingTypes, parseInviteeQuestions, recordSchedulerBookingPaymentFromAgent, updateSchedulerBookingPaymentFromAgent, type SchedulerBookingPaymentInput } from "./scheduler";
import { enabledPaymentMethods, getAppSettings } from "./settings";
import { createInvoicePaymentCheckoutSession } from "./stripe-checkout";
import { buildTimelineDraftFromProjectContext } from "./timeline-draft";
import { dateKeyInTimeZone } from "./timezone";

export const STUDIO_MCP_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type ToolCallParams = {
  name?: string;
  arguments?: Record<string, unknown>;
};

const studioTools = [
  {
    name: "studio_search_projects",
    title: "Search Projects",
    description: "Find canonical Studio projects by project name, client name, client email, venue, or location before calling project-specific tools.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text such as a client name, project name, venue, city, or email." },
        page: { type: "number", description: "One-based result page. Defaults to 1." },
        limit: { type: "number", description: "Maximum projects to return. Defaults to 10 and caps at 25." },
        sort: { type: "string", enum: ["eventDate", "createdAt", "name"], description: "Sort order. Defaults to eventDate." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "studio_get_project_context",
    title: "Get Project Context",
    description: "Read canonical Studio project context for an agent before creating timelines, proposals, or other project work.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_get_client_context",
    title: "Get Client Context",
    description: "Read one canonical Studio client/contact profile with linked projects, bookings, proposals, invoices, questionnaires, and recent activity before updating client facts or drafting follow-up.",
    inputSchema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "Canonical Studio client id." },
      },
      required: ["clientId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_get_agenda",
    title: "Get Agenda",
    description: "Read the canonical Studio agenda for weddings, sessions, and scheduler calls before planning timelines or client follow-up.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string", description: "Optional YYYY-MM-DD start date. Defaults to today in the requested time zone." },
        toDate: { type: "string", description: "Optional YYYY-MM-DD end date." },
        types: {
          type: "array",
          items: { type: "string", enum: ["wedding", "engagement", "other", "call"] },
          description: "Optional agenda categories to include.",
        },
        limit: { type: "number", description: "Maximum items to return. Caps at 100." },
        timeZone: { type: "string", description: "IANA time zone used for scheduler call dates and times. Defaults to America/New_York." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "studio_list_activity",
    title: "List Activity",
    description: "Read recent canonical Studio activity before deciding whether an agent action is new work, follow-up, or a duplicate.",
    inputSchema: {
      type: "object",
      properties: {
        actorType: {
          type: "string",
          enum: ["all", "admin", "agent", "client", "system"],
          description: "Optional actor filter. Defaults to all.",
        },
        projectId: { type: "string", description: "Optional canonical Studio project id filter." },
        limit: { type: "number", description: "Maximum activity rows to return. Defaults to 100 and caps at 250." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "studio_get_data_health",
    title: "Get Data Health",
    description: "Read canonical Studio data-health checks before creating records or reconciling client/project drift.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "studio_get_finance_report",
    title: "Get Finance Report",
    description: "Read the canonical Studio payment ledger and expense ledger for trusted agent bookkeeping or executive-assistant reporting.",
    inputSchema: {
      type: "object",
      properties: {
        paymentStatus: { type: "string", description: "Optional payment status filter. Defaults to all." },
        expenseStatus: { type: "string", description: "Optional expense status filter. Defaults to paid." },
        fromDate: { type: "string", description: "Optional YYYY-MM-DD start date for paid revenue and expense reporting." },
        toDate: { type: "string", description: "Optional YYYY-MM-DD end date for paid revenue and expense reporting." },
        asOfDate: { type: "string", description: "Optional YYYY-MM-DD date for accounts-receivable aging. Defaults to today." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "studio_get_business_review",
    title: "Get Business Review",
    description: "Read the derived Studio intelligence review (revenue forecast, booking conversion, lead-source performance, package-value trend, seasonal capacity, plus headlines) for a requested period. READ-ONLY — the agent composes the prose narrative from this JSON; the tool never sends or writes anything.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string", description: "Optional YYYY-MM-DD start of the review window. Defaults to the trailing 30 days." },
        toDate: { type: "string", description: "Optional YYYY-MM-DD end of the review window. Defaults to today." },
        asOfDate: { type: "string", description: "Optional YYYY-MM-DD as-of date for forecasting and aging. Defaults to today." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "studio_get_settings",
    title: "Get Settings",
    description: "Read sanitized Studio business and payment settings before drafting proposals, invoices, or client-facing payment copy.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "studio_list_templates",
    title: "List Templates",
    description: "Read canonical Studio templates for contracts, proposal packages, reminders, emails, questionnaires, and workflow prompts before drafting client-facing or operational copy.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["email", "questionnaire", "contract", "proposal_package", "workflow", "reminder"],
          description: "Optional template type filter.",
        },
        includeArchived: { type: "boolean", description: "Include archived templates. Defaults to false." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "studio_list_questionnaires",
    title: "List Questionnaires",
    description: "Read canonical Studio questionnaires and question ids before creating questionnaire links or filling questionnaire responses.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["active", "draft", "archived"],
          description: "Optional status filter. Defaults to active questionnaires.",
        },
        includeArchived: { type: "boolean", description: "Include archived questionnaires when no explicit status is provided. Defaults to false." },
        includeQuestions: { type: "boolean", description: "Include question ids, titles, types, options, and required flags. Defaults to true." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "studio_list_scheduler_meeting_types",
    title: "List Scheduler Meeting Types",
    description: "Read canonical scheduler meeting types and booking URLs before handing off discovery, planning, or paid-consult links.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Optional canonical Studio project id for signed project-scoped booking links." },
        clientId: { type: "string", description: "Optional linked client id for project-scoped booking links." },
        includeInactive: { type: "boolean", description: "Include inactive meeting types. Defaults to false." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_project",
    title: "Create Project",
    description: "Create a canonical Studio project and primary client from trusted agent inquiry or discovery-call intake.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name." },
        type: { type: "string", description: "Project type. Defaults to wedding." },
        stage: { type: "string", description: "Project stage. Defaults to inquiry." },
        status: { type: "string", description: "Project status. Defaults to active." },
        eventDate: { type: "string", description: "Optional YYYY-MM-DD event date." },
        venueName: { type: "string", description: "Optional venue name." },
        venueAddress: { type: "string", description: "Optional venue address." },
        city: { type: "string", description: "Optional city." },
        state: { type: "string", description: "Optional state." },
        budgetCents: { type: "number", description: "Optional budget in cents." },
        notes: { type: "string", description: "Optional project notes." },
        primaryClient: {
          type: "object",
          properties: {
            clientId: { type: "string", description: "Existing canonical client id. Use this when data health shows an orphan client that should become the primary project contact." },
            firstName: { type: "string" },
            lastName: { type: "string" },
            preferredName: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" },
            instagramHandle: { type: "string", description: "Optional Instagram handle. A leading @ is added when omitted." },
            communicationPreference: { type: "string", description: "Optional client communication preference." },
            referralSource: { type: "string", description: "Optional lead or referral source." },
            role: { type: "string" },
          },
          additionalProperties: false,
        },
        intakeSource: {
          type: "object",
          properties: {
            kind: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
            summary: { type: "string" },
            occurredAt: { type: "string" },
            externalUrl: { type: "string" },
            capturedBy: { type: "string" },
            sourceType: { type: "string" },
            sourceId: { type: "string" },
            metadata: { type: "object" },
          },
          required: ["body"],
          additionalProperties: false,
        },
      },
      required: ["name", "primaryClient"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_update_project",
    title: "Update Project",
    description: "Update canonical Studio project details from trusted agent intake, such as discovery-call or questionnaire source material.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        name: { type: "string", description: "Optional project name." },
        type: { type: "string", description: "Optional project type." },
        stage: { type: "string", description: "Optional project stage." },
        status: { type: "string", description: "Optional project status." },
        primaryClientId: { type: "string", description: "Optional linked client id to promote as the project's primary contact." },
        eventDate: { type: "string", description: "Optional YYYY-MM-DD event date." },
        venueName: { type: "string", description: "Optional venue name." },
        venueAddress: { type: "string", description: "Optional venue address." },
        city: { type: "string", description: "Optional city." },
        state: { type: "string", description: "Optional state." },
        budgetCents: { type: "number", description: "Optional budget in cents." },
        notes: { type: "string", description: "Optional project notes." },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_link_client_to_project",
    title: "Link Client To Project",
    description: "Link an existing canonical Studio client to an existing canonical Studio project without duplicating either record.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        clientId: { type: "string", description: "Canonical Studio client id." },
        role: { type: "string", description: "Client role on the project. Defaults to other." },
        customRole: { type: "string", description: "Custom role when role is other." },
      },
      required: ["projectId", "clientId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_update_client",
    title: "Update Client",
    description: "Update one canonical Studio client/contact row from trusted agent intake so project context, search, and client pages stay in sync.",
    inputSchema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "Canonical Studio client id." },
        firstName: { type: "string", description: "Optional updated first name." },
        lastName: { type: "string", description: "Optional updated last name." },
        preferredName: { type: "string", description: "Optional updated preferred name." },
        email: { type: "string", description: "Optional updated email. Must be unique after normalization." },
        phone: { type: "string", description: "Optional updated phone number." },
        instagramHandle: { type: "string", description: "Optional canonical Instagram handle. A leading @ is added when omitted." },
        communicationPreference: { type: "string", description: "Optional client communication preference, such as email for contracts and text for logistics." },
        referralSource: { type: "string", description: "Optional lead source or referral source." },
        notes: { type: "string", description: "Optional internal client notes." },
      },
      required: ["clientId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_merge_clients",
    title: "Merge Clients",
    description: "Merge a duplicate canonical Studio client into the chosen surviving client, moving linked project/client records instead of creating drift.",
    inputSchema: {
      type: "object",
      properties: {
        survivorClientId: { type: "string", description: "Canonical Studio client id that should remain after the merge." },
        duplicateClientId: { type: "string", description: "Canonical Studio client id that should be merged and removed." },
        actorName: { type: "string", description: "Optional agent name for the activity log. Defaults to The Reeses Studio Agent." },
      },
      required: ["survivorClientId", "duplicateClientId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_list_project_workflow_automations",
    title: "List Project Workflow Automations",
    description: "List available Studio workflow automation steps and any workflow runs already configured for a project. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_setup_project_workflow_automation",
    title: "Set Up Project Workflow Automation",
    description: "Opt a project into selected Studio workflow steps without queuing tasks or sending client messages.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        stepKeys: {
          type: "array",
          items: { type: "string" },
          description: "Optional selected workflow step keys. Omit to configure all available steps.",
        },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_queue_project_workflow_steps",
    title: "Queue Project Workflow Steps",
    description: "Queue selected configured workflow steps into the Studio Inbox as agent tasks. Does not send client messages and does not duplicate already queued steps.",
    inputSchema: {
      type: "object",
      properties: {
        workflowRunId: { type: "string", description: "Canonical project workflow run id." },
        stepKeys: {
          type: "array",
          items: { type: "string" },
          description: "Optional selected configured step keys. Omit to queue all configured, unqueued steps.",
        },
      },
      required: ["workflowRunId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_agent_task",
    title: "Create Agent Task",
    description: "Create a durable Studio task assignment for the trusted agent.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Optional canonical Studio project id." },
        title: { type: "string", description: "Task title." },
        instructions: { type: "string", description: "Task instructions or acceptance criteria." },
        priority: { type: "string", description: "Optional priority label." },
        requestedBy: { type: "string", description: "Who requested the task." },
        assignedAgent: { type: "string", description: "Optional agent name." },
        sourceType: { type: "string", description: "Optional source label." },
        sourceId: { type: "string", description: "Optional source record id." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_project_event",
    title: "Create Project Event",
    description: "Create a canonical project event/session row used by the Studio agenda, project page, and executive-assistant schedule context.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        type: { type: "string", description: "Event type such as wedding, engagement, rehearsal, brunch, portrait, or other." },
        title: { type: "string", description: "Event title." },
        eventDate: { type: "string", description: "Optional YYYY-MM-DD event date." },
        venueName: { type: "string", description: "Optional venue or location name." },
        venueAddress: { type: "string", description: "Optional venue address." },
        city: { type: "string", description: "Optional city." },
        state: { type: "string", description: "Optional state." },
        notes: { type: "string", description: "Optional event notes." },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_update_project_event",
    title: "Update Project Event",
    description: "Update a canonical project event/session row in place so agent schedule edits persist in the Studio agenda and project page.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        eventId: { type: "string", description: "Canonical project event id." },
        type: { type: "string", description: "Optional updated event type." },
        title: { type: "string", description: "Optional updated event title." },
        eventDate: { type: "string", description: "Optional YYYY-MM-DD event date." },
        venueName: { type: "string", description: "Optional venue or location name." },
        venueAddress: { type: "string", description: "Optional venue address." },
        city: { type: "string", description: "Optional city." },
        state: { type: "string", description: "Optional state." },
        notes: { type: "string", description: "Optional event notes." },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId", "eventId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_project_location",
    title: "Create Project Location",
    description: "Create a canonical project logistics location used by the Studio project page and agent project context.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        type: { type: "string", description: "Location type such as getting_ready, ceremony, reception, portrait, after_party, or other." },
        name: { type: "string", description: "Location name." },
        address: { type: "string", description: "Optional street address or map-friendly location." },
        city: { type: "string", description: "Optional city." },
        state: { type: "string", description: "Optional state." },
        notes: { type: "string", description: "Optional logistics notes, access, permits, light, parking, or rain plan." },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_update_project_location",
    title: "Update Project Location",
    description: "Update a canonical project logistics location in place so agent and Studio edits share one location record.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        locationId: { type: "string", description: "Canonical project location id." },
        type: { type: "string", description: "Optional updated location type." },
        name: { type: "string", description: "Optional updated location name." },
        address: { type: "string", description: "Optional updated street address or map-friendly location." },
        city: { type: "string", description: "Optional updated city." },
        state: { type: "string", description: "Optional updated state." },
        notes: { type: "string", description: "Optional updated logistics notes." },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId", "locationId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_attach_gallery_link",
    title: "Attach Gallery Link",
    description: "Stage a provider gallery delivery link (Pixieset, Pic-Time, Cloudinary, or other) against a project for Tyler to review. Draft/attach-only: this ALWAYS creates a draft, agent-authored gallery row — it can never publish a client-visible gallery or send anything to the client, regardless of any status field supplied.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        title: { type: "string", description: "Gallery title, e.g. \"Engagement gallery\" or \"Wedding gallery\"." },
        url: { type: "string", description: "https:// provider delivery URL. Only https URLs are ever stored." },
        provider: { type: "string", description: "Optional provider label such as Pixieset, Pic-Time, or Cloudinary." },
        passcode: { type: "string", description: "Optional provider-side gallery passcode, display-only." },
        expiresAt: { type: "string", description: "Optional provider expiry date/time (display only, \"available until\")." },
      },
      required: ["projectId", "title", "url"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_project_source",
    title: "Create Project Source",
    description: "Store canonical project source material, such as discovery-call notes or transcripts, for agents to reference before creating outputs.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        kind: { type: "string", description: "Source kind such as discovery_call, questionnaire_notes, receipt_upload, or note." },
        title: { type: "string", description: "Human-readable source title." },
        body: { type: "string", description: "Canonical source body, notes, transcript, or extracted text." },
        summary: { type: "string", description: "Optional concise source summary." },
        occurredAt: { type: "string", description: "Optional ISO timestamp for when the source happened." },
        externalUrl: { type: "string", description: "Optional source URL or artifact link." },
        capturedBy: { type: "string", description: "Optional agent/person who captured the source." },
        sourceType: { type: "string", description: "Optional upstream source label such as call_transcript." },
        sourceId: { type: "string", description: "Optional upstream source id." },
        metadata: { type: "object", description: "Optional structured source metadata." },
      },
      required: ["projectId", "kind", "title", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_update_project_source",
    title: "Update Project Source",
    description: "Revise canonical project source material, such as corrected discovery-call notes, transcripts, OCR, or receipts.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        projectSourceId: { type: "string", description: "Canonical project source id to update." },
        kind: { type: "string", description: "Optional source kind such as discovery_call, questionnaire_notes, receipt_upload, or note." },
        title: { type: "string", description: "Optional updated source title." },
        body: { type: "string", description: "Optional updated canonical source body, notes, transcript, or extracted text." },
        summary: { type: "string", description: "Optional updated concise source summary." },
        occurredAt: { type: "string", description: "Optional ISO timestamp for when the source happened." },
        externalUrl: { type: "string", description: "Optional source URL or artifact link." },
        capturedBy: { type: "string", description: "Optional agent/person who captured the source." },
        sourceType: { type: "string", description: "Optional upstream source label such as call_transcript." },
        sourceId: { type: "string", description: "Optional upstream source id." },
        metadata: { type: "object", description: "Optional replacement structured source metadata." },
      },
      required: ["projectId", "projectSourceId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_claim_agent_task",
    title: "Claim Agent Task",
    description: "Claim the next queued Studio agent task and mark it in progress for the assigned agent.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Optional canonical task id to claim exactly instead of claiming the next eligible task." },
        projectId: { type: "string", description: "Optional canonical Studio project id to claim within." },
        assignedAgent: { type: "string", description: "Optional agent name taking ownership." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "studio_start_agent_task_run",
    title: "Start Agent Task Run",
    description: "Claim or resume a Studio agent task and return the task, canonical project context, workflow context, safety rules, and completion contract in one execution packet.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Optional canonical task id to claim or resume exactly." },
        projectId: { type: "string", description: "Optional canonical Studio project id to claim within." },
        assignedAgent: { type: "string", description: "Optional agent name taking ownership." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "studio_list_agent_tasks",
    title: "List Agent Tasks",
    description: "List durable Studio agent tasks, optionally filtered by project or status.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Optional canonical Studio project id." },
        status: { type: "string", description: "Optional task status." },
        assignedAgent: { type: "string", description: "Optional agent name; includes tasks assigned to that agent plus generic Studio Agent tasks." },
        limit: { type: "number", description: "Maximum tasks to return. Defaults to 20 and caps at 50." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "studio_update_agent_task",
    title: "Update Agent Task",
    description: "Update durable Studio agent task status, source link, and output.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Canonical Studio agent task id." },
        status: { type: "string", enum: ["queued", "in_progress", "completed", "failed", "cancelled"] },
        assignedAgent: { type: "string", description: "Optional agent name making the update; when provided, Studio verifies this task belongs to that specialist or the generic Studio Agent queue." },
        resultSummary: { type: "string", description: "Optional result summary." },
        outputJson: { type: "object", description: "Optional structured output references." },
        errorMessage: { type: "string", description: "Optional failure reason." },
        sourceType: { type: "string", description: "Optional corrected source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional corrected source record id for traceability." },
      },
      required: ["taskId", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_submit_workflow_task_result",
    title: "Submit Workflow Task Result",
    description: "Submit the drafted result for a project workflow agent task. Studio stores the result as canonical project source material and completes the linked task and workflow step.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Canonical Studio agent task id linked to a project workflow step." },
        assignedAgent: { type: "string", description: "Agent name submitting the result. Required for specialist-owned tasks." },
        outputTitle: { type: "string", description: "Optional project-source title for the generated draft or work product." },
        outputBody: { type: "string", description: "Draft body, checklist, timeline notes, proposal notes, or other work product to store canonically." },
        outputSummary: { type: "string", description: "Optional concise result summary." },
        outputKind: { type: "string", description: "Optional project source kind. Defaults to workflow_result." },
        metadata: { type: "object", description: "Optional structured metadata to attach to the project source." },
      },
      required: ["taskId", "outputBody"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_run_workflow_draft_task",
    title: "Run Workflow Draft Task",
    description: "Claim or resume a workflow-created task, generate a conservative Studio draft/brief from canonical project context, and optionally save it as project source material while completing the task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Canonical Studio agent task id linked to a project workflow step." },
        projectId: { type: "string", description: "Optional canonical Studio project id guard." },
        assignedAgent: { type: "string", description: "Agent name running the draft task. Required for specialist-owned tasks." },
        previewOnly: { type: "boolean", description: "When true, returns the generated draft without completing the task or storing a project source." },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_questionnaire_link",
    title: "Create Questionnaire Link",
    description: "Create a signed project-scoped questionnaire URL and matching timeline-call URL for a linked project client.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        questionnaireId: { type: "string", description: "Canonical active questionnaire id." },
        clientId: { type: "string", description: "Optional linked client id to scope the questionnaire response." },
      },
      required: ["projectId", "questionnaireId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_upsert_questionnaire_response",
    title: "Upsert Questionnaire Response",
    description: "Create or update a canonical project questionnaire response from trusted agent intake, optionally marking it submitted.",
    inputSchema: {
      type: "object",
      properties: {
        responseId: { type: "string", description: "Optional existing questionnaire response id. If omitted, Studio creates or reuses an open project/client draft." },
        projectId: { type: "string", description: "Canonical Studio project id." },
        questionnaireId: { type: "string", description: "Canonical questionnaire id." },
        clientId: { type: "string", description: "Optional project client id." },
        answers: { type: "object", description: "Question answers keyed by questionnaire question id." },
        submit: { type: "boolean", description: "Whether to mark the response submitted after saving answers." },
      },
      required: ["projectId", "questionnaireId", "answers"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_timeline_item",
    title: "Create Project Timeline Item",
    description: "Create one canonical timeline item on a Studio project from agent-prepared planning notes.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        title: { type: "string", description: "Timeline item title." },
        description: { type: "string", description: "Optional planning notes for this item." },
        startAt: { type: "string", description: "Optional ISO-8601 start date/time." },
        endAt: { type: "string", description: "Optional ISO-8601 end date/time." },
        sourceType: { type: "string", description: "Optional source label, such as discovery_call or agent." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_timeline_items",
    title: "Create Project Timeline Items",
    description: "Create an ordered batch of canonical timeline items on a Studio project from one source, such as discovery-call notes.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
        replaceExistingForSource: { type: "boolean", description: "When true, removes existing timeline rows for the same sourceType/sourceId before inserting the regenerated batch." },
        timelineItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              startAt: { type: "string" },
              endAt: { type: "string" },
              sourceType: { type: "string" },
              sourceId: { type: "string" },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["projectId", "timelineItems"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_update_timeline_item",
    title: "Update Project Timeline Item",
    description: "Update one canonical Studio timeline item in place so agent and Studio edits share the same project timeline row.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        timelineItemId: { type: "string", description: "Canonical timeline item id." },
        title: { type: "string", description: "Optional updated timeline item title." },
        description: { type: "string", description: "Optional updated planning notes for this item." },
        startAt: { type: "string", description: "Optional ISO-8601 start date/time." },
        endAt: { type: "string", description: "Optional ISO-8601 end date/time." },
        sortOrder: { type: "number", description: "Optional display order." },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId", "timelineItemId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_proposal",
    title: "Create Project Proposal",
    description: "Create a canonical draft proposal and package line items on a Studio project from agent-prepared discovery call notes.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        title: { type: "string", description: "Proposal title." },
        packageName: { type: "string", description: "Optional package name." },
        proposalPackageTemplateId: { type: "string", description: "Optional active proposal_package template id. When packageName or scopeSummary is omitted, Studio applies the template into the canonical proposal." },
        validUntil: { type: "string", description: "Optional YYYY-MM-DD valid-until date." },
        scopeSummary: { type: "string", description: "Optional scope summary generated from discovery notes." },
        contractTemplateId: { type: "string", description: "Optional active contract template id. When contractTitle or contractBody is omitted, Studio applies the template into the canonical proposal." },
        contractTitle: { type: "string", description: "Optional contract title." },
        contractBody: { type: "string", description: "Optional contract body or draft terms." },
        sourceType: { type: "string", description: "Optional source label, such as discovery_call or agent." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
        lineItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              quantity: { type: "number" },
              unitPriceCents: { type: "number" },
              isOptional: { type: "boolean" },
            },
            required: ["name", "unitPriceCents"],
            additionalProperties: false,
          },
        },
      },
      required: ["projectId", "title", "lineItems"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_update_proposal",
    title: "Update Project Proposal",
    description: "Revise an existing unaccepted canonical Studio proposal in place from trusted agent discovery or follow-up notes.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        proposalId: { type: "string", description: "Canonical proposal id to update." },
        title: { type: "string", description: "Optional updated proposal title." },
        packageName: { type: "string", description: "Optional updated package name." },
        proposalPackageTemplateId: { type: "string", description: "Optional active proposal_package template id. When packageName or scopeSummary is omitted, Studio applies the template into the canonical proposal." },
        validUntil: { type: "string", description: "Optional YYYY-MM-DD valid-until date." },
        scopeSummary: { type: "string", description: "Optional updated scope summary generated from discovery notes." },
        contractTemplateId: { type: "string", description: "Optional active contract template id. When contractTitle or contractBody is omitted, Studio applies the template into the canonical proposal." },
        contractTitle: { type: "string", description: "Optional updated contract title." },
        contractBody: { type: "string", description: "Optional updated contract body or draft terms." },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
        lineItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              quantity: { type: "number" },
              unitPriceCents: { type: "number" },
              isOptional: { type: "boolean" },
            },
            required: ["name", "unitPriceCents"],
            additionalProperties: false,
          },
          description: "Optional replacement package line items. Omit to preserve existing line items.",
        },
      },
      required: ["projectId", "proposalId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_proposal_link",
    title: "Create Proposal Link",
    description: "Create a secure client proposal URL for an existing Studio proposal using the same hashed-token access flow as the Studio admin UI.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        proposalId: { type: "string", description: "Canonical proposal id to share." },
        clientId: { type: "string", description: "Optional linked client id to scope the proposal link." },
        label: { type: "string", description: "Optional internal label for the access token." },
      },
      required: ["projectId", "proposalId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_portal_link",
    title: "Create Portal Link",
    description: "Create a secure client portal URL for a canonical Studio project. Client-scoped links require the client to already be linked to the project.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        clientId: { type: "string", description: "Optional linked client id to scope the portal link." },
        label: { type: "string", description: "Optional internal label for the access token." },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_invoice",
    title: "Create Project Invoice",
    description: "Blocked pending Tyler approval. Agents may draft invoice recommendations as tasks, but cannot create invoices or payment schedules directly.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        proposalId: { type: "string", description: "Optional proposal id to invoice." },
        invoiceNumber: { type: "string", description: "Optional invoice number. Studio auto-generates one if omitted." },
        status: { type: "string", description: "Invoice status. Defaults to draft." },
        totalCents: { type: "number", description: "Optional total in cents. Defaults to proposal total when proposalId is provided." },
        retainerAmountCents: { type: "number", description: "Optional retainer amount in cents." },
        retainerPercent: { type: "number", description: "Retainer percent fallback. Defaults to 30." },
        installmentCount: { type: "number", description: "Number of remaining installments after retainer. Defaults to 1." },
        dueDate: { type: "string", description: "Optional YYYY-MM-DD first due date." },
        paymentNotes: { type: "string", description: "Optional payment notes override." },
        stripePaymentLink: { type: "string", description: "Optional Stripe checkout/payment link shown to the client." },
        acceptedPaymentMethods: {
          type: "array",
          items: { type: "string", enum: ["stripe", "zelle", "venmo", "cashCheck"] },
          description: "Optional enabled payment methods to accept on this invoice.",
        },
        sourceType: { type: "string", description: "Optional source label, such as discovery_call or agent." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_update_invoice",
    title: "Update Project Invoice",
    description: "Blocked pending Tyler approval. Agents may draft invoice revision recommendations as tasks, but cannot update invoices or payment schedules directly.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        invoiceId: { type: "string", description: "Canonical invoice id to update." },
        status: { type: "string", description: "Optional invoice status. Use payment tools for paid states." },
        totalCents: { type: "number", description: "Optional updated invoice total in cents." },
        retainerAmountCents: { type: "number", description: "Optional updated retainer amount in cents." },
        retainerPercent: { type: "number", description: "Optional retainer percent fallback." },
        installmentCount: { type: "number", description: "Optional number of remaining installments after retainer." },
        dueDate: { type: "string", description: "Optional YYYY-MM-DD first due date." },
        paymentNotes: { type: "string", description: "Optional updated payment notes." },
        stripePaymentLink: { type: "string", description: "Optional updated Stripe checkout/payment link shown to the client." },
        acceptedPaymentMethods: {
          type: "array",
          items: { type: "string", enum: ["stripe", "zelle", "venmo", "cashCheck"] },
          description: "Optional enabled payment methods to accept on this invoice.",
        },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId", "invoiceId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_record_invoice_payment",
    title: "Record Invoice Payment",
    description: "Blocked pending Tyler approval. Agents may draft payment reconciliation recommendations as tasks, but cannot record invoice payments directly.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string", description: "Canonical Studio invoice id." },
        paymentId: { type: "string", description: "Canonical Studio invoice payment schedule id." },
        status: { type: "string", enum: ["pending", "paid", "waived"] },
        paymentMethod: { type: "string", description: "Payment method such as stripe, zelle, venmo, check, or cash." },
        paidAmountCents: { type: "number", description: "Paid service amount in cents. Defaults to the scheduled payment amount." },
        paidAt: { type: "string", description: "Optional ISO paid timestamp from the receipt or processor." },
        externalPaymentId: { type: "string", description: "Optional Stripe payment intent, bank reference, check number, or processor id." },
        stripeCheckoutUrl: { type: "string", description: "Optional per-installment Stripe Checkout URL shown to the client." },
        stripeCheckoutSessionId: { type: "string", description: "Optional Stripe Checkout session id for reconciliation." },
        stripeCheckoutStatus: { type: "string", enum: ["not_created", "link_ready", "paid", "expired", "void"] },
        notes: { type: "string", description: "Optional reconciliation notes." },
        sourceType: { type: "string", description: "Optional source label, such as stripe_receipt or bank_export." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["invoiceId", "paymentId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_invoice_payment_checkout",
    title: "Create Invoice Payment Checkout",
    description: "Create a Stripe-hosted Checkout Session for an open invoice installment and save the URL/session id to the canonical payment row.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string", description: "Canonical Studio invoice id." },
        paymentId: { type: "string", description: "Canonical Studio invoice payment schedule id." },
      },
      required: ["invoiceId", "paymentId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_update_invoice_payment",
    title: "Update Invoice Payment",
    description: "Blocked pending Tyler approval. Agents may draft payment correction recommendations as tasks, but cannot update invoice payments directly.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string", description: "Canonical Studio invoice id." },
        paymentId: { type: "string", description: "Canonical Studio invoice payment schedule id." },
        status: { type: "string", enum: ["pending", "paid", "waived"] },
        paymentMethod: { type: "string", description: "Corrected payment method such as stripe, zelle, venmo, check, or cash." },
        paidAmountCents: { type: "number", description: "Corrected paid service amount in cents." },
        paidAt: { type: "string", description: "Corrected ISO paid timestamp from the receipt or processor." },
        externalPaymentId: { type: "string", description: "Corrected Stripe payment intent, bank reference, check number, or processor id." },
        stripeCheckoutUrl: { type: "string", description: "Corrected per-installment Stripe Checkout URL shown to the client." },
        stripeCheckoutSessionId: { type: "string", description: "Corrected Stripe Checkout session id for reconciliation." },
        stripeCheckoutStatus: { type: "string", enum: ["not_created", "link_ready", "paid", "expired", "void"] },
        notes: { type: "string", description: "Optional reconciliation notes." },
        sourceType: { type: "string", description: "Optional corrected source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional corrected source record id for traceability." },
      },
      required: ["invoiceId", "paymentId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_log_invoice_reminder",
    title: "Log Invoice Reminder",
    description: "Record that an agent prepared or performed a manual invoice follow-up. This creates canonical audit history only; it does not send email, SMS, or payment reminders.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string", description: "Canonical Studio invoice id." },
        paymentId: { type: "string", description: "Optional canonical invoice payment schedule id being followed up on." },
        channel: { type: "string", description: "Follow-up channel such as email, text, call, or agent." },
        note: { type: "string", description: "Short note describing the drafted or completed manual follow-up." },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["invoiceId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_record_scheduler_booking_payment",
    title: "Record Scheduler Booking Payment",
    description: "Blocked pending Tyler approval. Agents may draft scheduler payment reconciliation recommendations as tasks, but cannot record booking payments directly.",
    inputSchema: {
      type: "object",
      properties: {
        bookingId: { type: "string", description: "Canonical Studio scheduler booking id." },
        status: { type: "string", enum: ["unpaid", "pending", "paid", "refunded", "waived"] },
        paymentMethod: { type: "string", description: "Payment method such as stripe, credit_card, zelle, venmo, check, or cash." },
        paidAmountCents: { type: "number", description: "Paid service amount in cents. Defaults to 0 unless provided." },
        paidAt: { type: "string", description: "Optional ISO paid timestamp from the receipt or processor." },
        clientFeeCents: { type: "number", description: "Optional fee amount passed to the client in cents." },
        processingFeeCents: { type: "number", description: "Optional processor fee amount in cents." },
        grossCollectedCents: { type: "number", description: "Optional gross collected amount in cents." },
        netDepositCents: { type: "number", description: "Optional net deposit amount in cents." },
        externalPaymentId: { type: "string", description: "Optional Stripe payment intent, bank reference, check number, or processor id." },
        notes: { type: "string", description: "Optional reconciliation notes." },
        sourceType: { type: "string", description: "Optional source label, such as stripe_payment_link or bank_export." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["bookingId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_update_scheduler_booking_payment",
    title: "Update Scheduler Booking Payment",
    description: "Blocked pending Tyler approval. Agents may draft scheduler payment correction recommendations as tasks, but cannot update booking payments directly.",
    inputSchema: {
      type: "object",
      properties: {
        bookingId: { type: "string", description: "Canonical Studio scheduler booking id." },
        status: { type: "string", enum: ["unpaid", "pending", "paid", "refunded", "waived"] },
        paymentMethod: { type: "string", description: "Corrected payment method such as stripe, credit_card, zelle, venmo, check, or cash." },
        paidAmountCents: { type: "number", description: "Corrected paid service amount in cents." },
        paidAt: { type: "string", description: "Corrected ISO paid timestamp from the receipt or processor." },
        clientFeeCents: { type: "number", description: "Optional corrected fee amount passed to the client in cents." },
        processingFeeCents: { type: "number", description: "Optional corrected processor fee amount in cents." },
        grossCollectedCents: { type: "number", description: "Optional corrected gross collected amount in cents." },
        netDepositCents: { type: "number", description: "Optional corrected net deposit amount in cents." },
        externalPaymentId: { type: "string", description: "Corrected Stripe payment intent, bank reference, check number, or processor id." },
        notes: { type: "string", description: "Optional reconciliation notes." },
        sourceType: { type: "string", description: "Optional corrected source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional corrected source record id for traceability." },
      },
      required: ["bookingId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_expense",
    title: "Create Project Expense",
    description: "Create a canonical project-linked expense and vendor record from trusted agent receipt or bookkeeping intake.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        vendorName: { type: "string", description: "Vendor or payee name." },
        category: { type: "string", description: "Bookkeeping category such as equipment, software, contractor, travel, or marketing." },
        description: { type: "string", description: "Expense description." },
        amountCents: { type: "number", description: "Expense amount in cents." },
        status: { type: "string", description: "Expense status. Defaults to paid." },
        paidAt: { type: "string", description: "Optional YYYY-MM-DD paid date." },
        paymentMethod: { type: "string", description: "Optional payment method or account nickname." },
        externalPaymentId: { type: "string", description: "Optional card charge, bank, or processor reference." },
        receiptUrl: { type: "string", description: "Optional receipt object URL or durable reference." },
        taxDeductible: { type: "boolean", description: "Whether the expense is tax deductible. Defaults true." },
        notes: { type: "string", description: "Optional reconciliation notes." },
        sourceType: { type: "string", description: "Optional source label, such as receipt_upload or agent." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId", "vendorName", "category", "amountCents"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_update_expense",
    title: "Update Project Expense",
    description: "Revise an existing canonical project expense and vendor link from trusted agent receipt or bookkeeping corrections.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        expenseId: { type: "string", description: "Canonical expense id to update." },
        vendorName: { type: "string", description: "Optional corrected vendor or payee name." },
        category: { type: "string", description: "Optional bookkeeping category such as equipment, software, contractor, travel, or marketing." },
        description: { type: "string", description: "Optional expense description." },
        amountCents: { type: "number", description: "Optional corrected expense amount in cents." },
        status: { type: "string", description: "Optional expense status." },
        paidAt: { type: "string", description: "Optional YYYY-MM-DD paid date." },
        paymentMethod: { type: "string", description: "Optional payment method or account nickname." },
        externalPaymentId: { type: "string", description: "Optional card charge, bank, or processor reference." },
        receiptUrl: { type: "string", description: "Optional receipt object URL or durable reference." },
        taxDeductible: { type: "boolean", description: "Whether the expense is tax deductible." },
        notes: { type: "string", description: "Optional reconciliation notes." },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId", "expenseId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_create_communication",
    title: "Create Project Communication",
    description: "Create a canonical project communication draft or logged message from trusted agent follow-up work.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        clientId: { type: "string", description: "Optional project client id. Defaults to the primary project client." },
        direction: { type: "string", enum: ["outbound", "inbound", "internal"] },
        channel: { type: "string", enum: ["email", "sms", "call", "note"] },
        status: { type: "string", enum: ["draft", "queued", "sent", "archived"] },
        subject: { type: "string", description: "Optional email/message subject." },
        body: { type: "string", description: "Communication body or draft text." },
        recipientName: { type: "string", description: "Optional recipient name override." },
        recipientEmail: { type: "string", description: "Optional recipient email override." },
        scheduledFor: { type: "string", description: "Optional ISO timestamp for scheduled send/follow-up." },
        sentAt: { type: "string", description: "Optional ISO timestamp if already sent." },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_update_communication",
    title: "Update Project Communication",
    description: "Update a canonical project communication draft/log, such as marking an agent-drafted follow-up sent.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        communicationId: { type: "string", description: "Canonical Studio communication id." },
        direction: { type: "string", enum: ["outbound", "inbound", "internal"] },
        channel: { type: "string", enum: ["email", "sms", "call", "note"] },
        status: { type: "string", enum: ["draft", "queued", "sent", "archived"] },
        subject: { type: "string", description: "Optional email/message subject." },
        body: { type: "string", description: "Communication body or draft text." },
        recipientName: { type: "string", description: "Optional recipient name override." },
        recipientEmail: { type: "string", description: "Optional recipient email override." },
        scheduledFor: { type: "string", description: "Optional ISO timestamp for scheduled send/follow-up." },
        sentAt: { type: "string", description: "Optional ISO timestamp if already sent." },
        sourceType: { type: "string", description: "Optional corrected source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional corrected source record id for traceability." },
      },
      required: ["projectId", "communicationId"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_draft_sms",
    title: "Draft SMS",
    description: "Drafts an SMS for Tyler to review and send. Never sends. This ALWAYS creates a draft, agent-authored SMS communication row (channel:sms, status:draft, createdBy:agent) regardless of any status/channel/createdBy supplied — it has zero send authority and can never trigger a Twilio message.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        clientId: { type: "string", description: "Optional project client id. Defaults to the primary project client." },
        body: { type: "string", description: "SMS draft text for Tyler to review. Keep it short; opt-out language is appended at send time." },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "studio_draft_email",
    title: "Draft Email",
    description: "Drafts an email for Tyler to review and send. Never sends. This ALWAYS creates a draft, agent-authored EMAIL communication row (channel:email, status:draft, direction:outbound, createdBy:agent) regardless of any status/channel/createdBy supplied — it has zero send authority and can never trigger a Resend delivery. Only Tyler's admin-only send action can mark an email sent.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Canonical Studio project id." },
        clientId: { type: "string", description: "Optional project client id. Defaults to the primary project client." },
        subject: { type: "string", description: "Optional email subject for Tyler to review." },
        body: { type: "string", description: "Email draft text for Tyler to review." },
        recipientName: { type: "string", description: "Optional recipient name override." },
        recipientEmail: { type: "string", description: "Optional recipient email override." },
        sourceType: { type: "string", description: "Optional source label. Use project_source when sourceId points at project_sources.id." },
        sourceId: { type: "string", description: "Optional source record id for traceability." },
      },
      required: ["projectId", "body"],
      additionalProperties: false,
    },
  },
] as const;

function success(id: JsonRpcId, result: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function paramsRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringArg(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function optionalStringArg(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number) {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function hasArg(args: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function booleanArg(args: Record<string, unknown>, key: string, fallback = false) {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

function stringArrayArg(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  return strings.length ? strings : undefined;
}

const agendaCategorySet = new Set<AgendaCategory>(["wedding", "engagement", "other", "call"]);
const studioTemplateTypes = new Set(["email", "questionnaire", "contract", "proposal_package", "workflow", "reminder"]);

function agendaTypesArg(args: Record<string, unknown>) {
  const value = args.types;
  if (!Array.isArray(value)) return undefined;
  const types = value.filter((item): item is AgendaCategory => (
    typeof item === "string" && agendaCategorySet.has(item as AgendaCategory)
  ));
  return types.length ? types : undefined;
}

function timelineItemsArg(args: Record<string, unknown>) {
  const value = args.timelineItems;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      title: stringArg(item, "title"),
      description: optionalStringArg(item, "description"),
      startAt: optionalStringArg(item, "startAt"),
      endAt: optionalStringArg(item, "endAt"),
      sourceType: optionalStringArg(item, "sourceType"),
      sourceId: optionalStringArg(item, "sourceId"),
    }));
}

function questionnaireAnswersArg(args: Record<string, unknown>) {
  const value = args.answers;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const answers: QuestionnaireAnswerInput = {};
  for (const [key, answer] of Object.entries(value)) {
    if (typeof answer === "string" || answer === null || answer === undefined) {
      answers[key] = answer;
    } else if (Array.isArray(answer)) {
      answers[key] = answer.filter((item): item is string => typeof item === "string");
    }
  }
  return answers;
}

function joinedName(firstName: string, lastName: string | null) {
  return [firstName, lastName].filter(Boolean).join(" ");
}

function joinedLocation(city: string | null, state: string | null) {
  return [city, state].filter(Boolean).join(", ") || null;
}

function textToolResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

export async function searchStudioProjectIndex(input: { query?: string | null; page?: number | null; limit?: number | null; sort?: ProjectIndexSort | null } = {}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), 25);
  const index = await listProjectIndex({
    q: input.query,
    page: input.page,
    pageSize: limit,
    sort: input.sort,
  });
  const projectIds = index.rows.map((row) => row.project.id);

  const projectMap = new Map<string, {
    project: typeof projects.$inferSelect;
    clients: Array<typeof clients.$inferSelect>;
    primaryClient: typeof clients.$inferSelect | null;
  }>();

  for (const row of index.rows) {
    projectMap.set(row.project.id, {
      project: row.project,
      clients: [],
      primaryClient: row.client,
    });
  }

  if (projectIds.length) {
    const participantRows = await db
      .select({
        projectId: projectParticipants.projectId,
        client: clients,
        participant: projectParticipants,
      })
      .from(projectParticipants)
      .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
      .where(inArray(projectParticipants.projectId, projectIds))
      .orderBy(desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt));

    for (const row of participantRows) {
      const existing = projectMap.get(row.projectId);
      if (!existing) continue;
      existing.clients.push(row.client);
      if (row.participant.isPrimaryContact || !existing.primaryClient) {
        existing.primaryClient = row.client;
      }
    }
  }

  const [proposalRows, invoiceRows] = projectIds.length
    ? await Promise.all([
        db.query.proposals.findMany({ where: (proposal, { inArray }) => inArray(proposal.projectId, projectIds) }),
        db.query.invoices.findMany({
          where: (invoice, { and, eq, inArray, or }) => and(
            inArray(invoice.projectId, projectIds),
            or(eq(invoice.status, "draft"), eq(invoice.status, "sent"), eq(invoice.status, "partially_paid"), eq(invoice.status, "overdue")),
          ),
        }),
      ])
    : [[], []] as const;
  const proposalsByProjectId = new Map<string, Array<typeof proposals.$inferSelect>>();
  for (const proposal of proposalRows) {
    proposalsByProjectId.set(proposal.projectId, [...(proposalsByProjectId.get(proposal.projectId) ?? []), proposal]);
  }
  const invoicesByProjectId = new Map<string, Array<typeof invoices.$inferSelect>>();
  for (const invoice of invoiceRows) {
    invoicesByProjectId.set(invoice.projectId, [...(invoicesByProjectId.get(invoice.projectId) ?? []), invoice]);
  }
  const invoiceIds = invoiceRows.map((invoice) => invoice.id);
  const projectInvoicePayments = invoiceIds.length
    ? await db.query.invoicePayments.findMany({
        where: (payment, { inArray }) => inArray(payment.invoiceId, invoiceIds),
      })
    : [];
  const paymentsByInvoiceId = new Map<string, Array<typeof invoicePayments.$inferSelect>>();
  for (const payment of projectInvoicePayments) {
    paymentsByInvoiceId.set(payment.invoiceId, [...(paymentsByInvoiceId.get(payment.invoiceId) ?? []), payment]);
  }

  const summaries = [];
  for (const entry of projectMap.values()) {
    const projectProposals = proposalsByProjectId.get(entry.project.id) ?? [];
    const projectInvoices = invoicesByProjectId.get(entry.project.id) ?? [];

    summaries.push({
      id: entry.project.id,
      name: entry.project.name,
      type: entry.project.type,
      stage: entry.project.stage,
      status: entry.project.status,
      eventDate: entry.project.eventDate,
      venueName: entry.project.venueName,
      location: joinedLocation(entry.project.city, entry.project.state),
      budgetCents: entry.project.budgetCents,
      primaryClient: entry.primaryClient
        ? {
          id: entry.primaryClient.id,
          name: joinedName(entry.primaryClient.firstName, entry.primaryClient.lastName),
          email: entry.primaryClient.email,
          instagramHandle: entry.primaryClient.instagramHandle,
          communicationPreference: entry.primaryClient.communicationPreference,
          referralSource: entry.primaryClient.referralSource,
        }
        : null,
      clientCount: entry.clients.length,
      proposalCount: projectProposals.length,
      invoiceCount: projectInvoices.length,
      openBalanceCents: projectInvoices.reduce(
        (sum, invoice) => sum + invoiceClientPayableBalanceCents(invoice, paymentsByInvoiceId.get(invoice.id) ?? []),
        0,
      ),
    });
  }

  return {
    projects: summaries,
    pagination: {
      totalCount: index.totalCount,
      filteredCount: index.filteredCount,
      currentPage: index.currentPage,
      totalPages: index.totalPages,
      pageSize: index.pageSize,
      rangeStart: index.rangeStart,
      rangeEnd: index.rangeEnd,
    },
  };
}

export async function searchStudioProjects(input: { query?: string | null; page?: number | null; limit?: number | null; sort?: ProjectIndexSort | null } = {}) {
  return (await searchStudioProjectIndex(input)).projects;
}

type ProjectContextRecord = Awaited<ReturnType<typeof getProject>>;

function paymentOpenCents(payment: typeof invoicePayments.$inferSelect) {
  // Phase 9a: "refunded" reads as settled (0 open) on the agent MCP surface too —
  // else the agent reports refunded money as still open. See invoice-balances.ts.
  if (isSettledInvoicePaymentStatus(payment.status)) return 0;
  return Math.max(payment.amountCents - payment.paidAmountCents, 0);
}

function paymentSummary(payments: Array<typeof invoicePayments.$inferSelect>) {
  return payments.reduce((sum, payment) => ({
    scheduledCents: sum.scheduledCents + payment.amountCents,
    paidCents: sum.paidCents + payment.paidAmountCents,
    grossCollectedCents: sum.grossCollectedCents + payment.grossCollectedCents,
    clientFeeCents: sum.clientFeeCents + payment.clientFeeCents,
    processingFeeCents: sum.processingFeeCents + payment.processingFeeCents,
    netDepositCents: sum.netDepositCents + payment.netDepositCents,
    openCents: sum.openCents + paymentOpenCents(payment),
  }), {
    scheduledCents: 0,
    paidCents: 0,
    grossCollectedCents: 0,
    clientFeeCents: 0,
    processingFeeCents: 0,
    netDepositCents: 0,
    openCents: 0,
  });
}

function parseJsonStringArray(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function proposalLineItemContext(item: typeof proposalLineItems.$inferSelect) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    quantity: item.quantity,
    unitPriceCents: item.unitPriceCents,
    totalCents: item.quantity * item.unitPriceCents,
    isOptional: item.isOptional,
    sortOrder: item.sortOrder,
  };
}

function parseJsonArray(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseQuestionnaireContextAnswers(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((answer): answer is {
        questionId?: unknown;
        title?: unknown;
        type?: unknown;
        required?: unknown;
        value?: unknown;
      } => typeof answer === "object" && answer !== null)
      .map((answer) => ({
        questionId: typeof answer.questionId === "string" ? answer.questionId : null,
        title: typeof answer.title === "string" ? answer.title : "Untitled question",
        type: typeof answer.type === "string" ? answer.type : null,
        required: Boolean(answer.required),
        value: answer.value,
        formattedValue: formatQuestionnaireAnswerValue(answer.value),
      }));
  } catch {
    return [];
  }
}

function parseSchedulerInviteeAnswers(answersJson: string | null, questionsJson: string | null) {
  if (!answersJson) return [];
  let answers: Record<string, unknown>;
  try {
    const parsed = JSON.parse(answersJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    answers = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  const questions = parseInviteeQuestions(questionsJson);
  const seenQuestionIds = new Set<string>();
  const labeledAnswers = questions
    .filter((question) => Object.prototype.hasOwnProperty.call(answers, question.id))
    .map((question) => {
      seenQuestionIds.add(question.id);
      const value = answers[question.id];
      return {
        questionId: question.id,
        label: question.label,
        type: question.type,
        value,
        formattedValue: formatQuestionnaireAnswerValue(value),
      };
    });

  const unknownAnswers = Object.entries(answers)
    .filter(([questionId]) => !seenQuestionIds.has(questionId))
    .map(([questionId, value]) => ({
      questionId,
      label: questionId.replaceAll("_", " "),
      type: null,
      value,
      formattedValue: formatQuestionnaireAnswerValue(value),
    }));

  return [...labeledAnswers, ...unknownAnswers];
}

async function questionnaireResponseResult(responseId: string) {
  const detail = await getQuestionnaireResponseDetail(responseId);
  if (!detail) throw new Error("Questionnaire response not found.");

  return {
    id: detail.response.id,
    questionnaireId: detail.response.questionnaireId,
    projectId: detail.response.projectId,
    clientId: detail.response.clientId,
    respondentName: detail.response.respondentName,
    respondentEmail: detail.response.respondentEmail,
    status: questionnaireResponseStatus(detail.response),
    submittedAt: detail.response.submittedAt,
    updatedAt: detail.response.updatedAt,
    sourceType: "questionnaire_response",
    sourceId: detail.response.id,
    answers: detail.answers.map((answer) => ({
      questionId: answer.questionId,
      title: answer.title,
      type: answer.type,
      required: answer.required,
      value: answer.value,
      formattedValue: answer.formattedValue,
    })),
  };
}

async function projectContextResult(projectRecord: ProjectContextRecord) {
  if (!projectRecord) {
    throw new Error("Project not found.");
  }

  const { project } = projectRecord;
  const invoiceIds = projectRecord.invoices.map((invoice) => invoice.id);
  const proposalIds = projectRecord.proposals.map((proposal) => proposal.id);
  const payments = invoiceIds.length
    ? await db.query.invoicePayments.findMany({
        where: inArray(invoicePayments.invoiceId, invoiceIds),
        orderBy: asc(invoicePayments.dueDate),
      })
    : [];
  const paymentsByInvoiceId = new Map<string, Array<typeof invoicePayments.$inferSelect>>();
  for (const payment of payments) {
    paymentsByInvoiceId.set(payment.invoiceId, [...(paymentsByInvoiceId.get(payment.invoiceId) ?? []), payment]);
  }
  const proposalLineItemRows = proposalIds.length
    ? await db.query.proposalLineItems.findMany({
        where: inArray(proposalLineItems.proposalId, proposalIds),
        orderBy: asc(proposalLineItems.sortOrder),
      })
    : [];
  const lineItemsByProposalId = new Map<string, Array<typeof proposalLineItems.$inferSelect>>();
  for (const item of proposalLineItemRows) {
    lineItemsByProposalId.set(item.proposalId, [...(lineItemsByProposalId.get(item.proposalId) ?? []), item]);
  }
  const expenseRows = await db
    .select({
      expense: expenses,
      vendor: vendors,
    })
    .from(expenses)
    .innerJoin(vendors, eq(expenses.vendorId, vendors.id))
    .where(eq(expenses.projectId, project.id))
    .orderBy(asc(expenses.paidAt), asc(expenses.createdAt)) as Array<{
      expense: typeof expenses.$inferSelect;
      vendor: typeof vendors.$inferSelect;
    }>;
  const schedulerBookingRows = await db
    .select({
      booking: schedulerBookings,
      meetingType: schedulerMeetingTypes,
    })
    .from(schedulerBookings)
    .innerJoin(schedulerMeetingTypes, eq(schedulerBookings.meetingTypeId, schedulerMeetingTypes.id))
    .where(eq(schedulerBookings.projectId, project.id))
    .orderBy(asc(schedulerBookings.startAt)) as Array<{
      booking: typeof schedulerBookings.$inferSelect;
      meetingType: typeof schedulerMeetingTypes.$inferSelect;
    }>;
  const questionnaireResponseRows = await db
    .select({
      response: questionnaireResponses,
      questionnaire: questionnaires,
    })
    .from(questionnaireResponses)
    .innerJoin(questionnaires, eq(questionnaireResponses.questionnaireId, questionnaires.id))
    .where(eq(questionnaireResponses.projectId, project.id))
    .orderBy(desc(questionnaireResponses.updatedAt)) as Array<{
      response: typeof questionnaireResponses.$inferSelect;
      questionnaire: typeof questionnaires.$inferSelect;
    }>;
  const financialSummary = summarizeProjectFinancials({
    invoiceCount: projectRecord.invoices.length,
    invoices: projectRecord.invoices,
    invoicePayments: payments,
    schedulerBookings: schedulerBookingRows,
    expenses: expenseRows.map((row) => row.expense),
  });

  return {
    project: {
      id: project.id,
      name: project.name,
      type: project.type,
      stage: project.stage,
      status: project.status,
      eventDate: project.eventDate,
      venueName: project.venueName,
      venueAddress: project.venueAddress,
      city: project.city,
      state: project.state,
      budgetCents: project.budgetCents,
      notes: project.notes,
    },
    clients: projectRecord.participants.map((participant) => ({
      id: participant.client.id,
      firstName: participant.client.firstName,
      lastName: participant.client.lastName,
      email: participant.client.email,
      phone: participant.client.phone,
      preferredName: participant.client.preferredName,
      instagramHandle: participant.client.instagramHandle,
      communicationPreference: participant.client.communicationPreference,
      referralSource: participant.client.referralSource,
      role: participant.role,
      isPrimaryContact: participant.isPrimaryContact,
    })),
    events: projectRecord.events.map((event) => ({
      id: event.id,
      type: event.type,
      title: event.title,
      eventDate: event.eventDate,
      venueName: event.venueName,
      venueAddress: event.venueAddress,
      city: event.city,
      state: event.state,
      notes: event.notes,
      sourceType: event.sourceType,
      sourceId: event.sourceId,
    })),
    questionnaireResponses: questionnaireResponseRows.map((row) => ({
      id: row.response.id,
      questionnaireId: row.response.questionnaireId,
      questionnaireTitle: row.questionnaire.title,
      clientId: row.response.clientId,
      respondentName: row.response.respondentName,
      respondentEmail: row.response.respondentEmail,
      status: questionnaireResponseStatus(row.response),
      submittedAt: row.response.submittedAt,
      updatedAt: row.response.updatedAt,
      sourceType: "questionnaire_response",
      sourceId: row.response.id,
      answers: parseQuestionnaireContextAnswers(row.response.answersJson),
    })),
    schedulerBookings: schedulerBookingRows.map((row) => ({
      id: row.booking.id,
      meetingTypeId: row.booking.meetingTypeId,
      meetingTypeName: row.meetingType.name,
      attendeeName: row.booking.attendeeName,
      attendeeEmail: row.booking.attendeeEmail,
      startAt: row.booking.startAt,
      endAt: row.booking.endAt,
      status: row.booking.status,
      paymentStatus: row.booking.paymentStatus,
      paidAmountCents: row.booking.paidAmountCents,
      clientFeeCents: row.booking.clientFeeCents,
      processingFeeCents: row.booking.processingFeeCents,
      grossCollectedCents: row.booking.grossCollectedCents,
      netDepositCents: row.booking.netDepositCents,
      paymentMethod: row.booking.paymentMethod,
      paidAt: row.booking.paidAt,
      externalPaymentId: row.booking.externalPaymentId,
      paymentLink: row.booking.paymentLink,
      paymentNotes: row.booking.paymentNotes,
      paymentSourceType: row.booking.paymentSourceType,
      paymentSourceId: row.booking.paymentSourceId,
      inviteeAnswers: parseSchedulerInviteeAnswers(row.booking.inviteeAnswersJson, row.meetingType.inviteeQuestionsJson),
    })),
    financialSummary,
    locations: projectRecord.locations.map((location) => ({
      id: location.id,
      type: location.type,
      name: location.name,
      address: location.address,
      city: location.city,
      state: location.state,
      notes: location.notes,
      sourceType: location.sourceType,
      sourceId: location.sourceId,
    })),
    timelineItems: projectRecord.timelineItems.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      startAt: item.startAt,
      endAt: item.endAt,
      sortOrder: item.sortOrder,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
    })),
    sources: projectRecord.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      title: source.title,
      body: source.body,
      summary: source.summary,
      occurredAt: source.occurredAt,
      externalUrl: source.externalUrl,
      capturedBy: source.capturedBy,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      metadata: source.metadataJson ? JSON.parse(source.metadataJson) : null,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    })),
    communications: projectRecord.communications.map((communication) => ({
      id: communication.id,
      projectId: communication.projectId,
      clientId: communication.clientId,
      direction: communication.direction,
      channel: communication.channel,
      status: communication.status,
      subject: communication.subject,
      body: communication.body,
      recipientName: communication.recipientName,
      recipientEmail: communication.recipientEmail,
      scheduledFor: communication.scheduledFor,
      sentAt: communication.sentAt,
      sourceType: communication.sourceType,
      sourceId: communication.sourceId,
      createdBy: communication.createdBy,
      createdAt: communication.createdAt,
      updatedAt: communication.updatedAt,
    })),
    proposals: projectRecord.proposals.map((proposal) => {
      const lineItems = lineItemsByProposalId.get(proposal.id) ?? [];
      const selectedOptionalLineItemIds = parseJsonStringArray(proposal.selectedOptionalLineItemIdsJson);
      const selectedOptionalLineItemIdSet = new Set(selectedOptionalLineItemIds);

      return {
        id: proposal.id,
        title: proposal.title,
        status: proposal.status,
        packageName: proposal.packageName,
        totalCents: proposal.totalCents,
        validUntil: proposal.validUntil,
        scopeSummary: proposal.scopeSummary,
        contractStatus: proposal.contractStatus,
        invoiceStatus: proposal.invoiceStatus,
        sentAt: proposal.sentAt,
        acceptedAt: proposal.acceptedAt,
        signedAt: proposal.signedAt,
        sourceType: proposal.sourceType,
        sourceId: proposal.sourceId,
        lineItems: lineItems.map(proposalLineItemContext),
        selectedOptionalLineItems: lineItems
          .filter((item) => selectedOptionalLineItemIdSet.has(item.id))
          .map(proposalLineItemContext),
        signatureEvidence: proposal.signedAt
          ? {
              signedAt: proposal.signedAt,
              signerName: proposal.signerName,
              signerEmail: proposal.signerEmail,
              signatureIp: proposal.signatureIp,
              signatureUserAgent: proposal.signatureUserAgent,
              signatureConsentVersion: proposal.signatureConsentVersion,
              selectedOptionalLineItemIds,
            }
          : null,
      };
    }),
    invoices: projectRecord.invoices.map((invoice) => {
      const invoicePaymentRows = paymentsByInvoiceId.get(invoice.id) ?? [];
      const clientPayableCents = invoiceClientPayableCents(invoice);
      const clientPayableBalanceCents = invoiceClientPayableBalanceCents(invoice, invoicePaymentRows);
      return {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        proposalId: invoice.proposalId,
        status: invoice.status,
        totalCents: invoice.totalCents,
        amountPaidCents: invoice.amountPaidCents,
        balanceCents: clientPayableBalanceCents,
        dueDate: invoice.dueDate,
        paymentNotes: invoice.paymentNotes,
        acceptedPaymentMethods: parseJsonArray(invoice.acceptedPaymentMethodsJson),
        stripePaymentLink: invoice.stripePaymentLink,
        zelleInfo: invoice.zelleInfo,
        venmoInfo: invoice.venmoInfo,
        sourceType: invoice.sourceType,
        sourceId: invoice.sourceId,
        cardFeePolicy: invoice.cardFeePolicy,
        cardFeeAmountCents: invoice.cardFeeAmountCents,
        clientPayableCents,
        clientPayableBalanceCents,
        paymentSummary: paymentSummary(invoicePaymentRows),
        payments: invoicePaymentRows.map((payment) => ({
          id: payment.id,
          label: payment.label,
          amountCents: payment.amountCents,
          dueDate: payment.dueDate,
          status: payment.status,
          paidAt: payment.paidAt,
          paymentMethod: payment.paymentMethod,
          paidAmountCents: payment.paidAmountCents,
          clientFeeCents: payment.clientFeeCents,
          processingFeeCents: payment.processingFeeCents,
          grossCollectedCents: payment.grossCollectedCents,
          netDepositCents: payment.netDepositCents,
          openCents: paymentOpenCents(payment),
          externalPaymentId: payment.externalPaymentId,
          stripeCheckoutUrl: payment.stripeCheckoutUrl,
          stripeCheckoutSessionId: payment.stripeCheckoutSessionId,
          stripeCheckoutStatus: payment.stripeCheckoutStatus,
          notes: payment.notes,
          sourceType: payment.sourceType,
          sourceId: payment.sourceId,
        })),
      };
    }),
    // Phase 7a: always-on agent read of gallery delivery links. Sourced from
    // `projectRecord.galleries`, which `getProject()` (src/lib/crm.ts) already
    // fetches behind its own try/catch — a missing project_galleries table
    // (pre-0086 deploy) degrades to `[]` there instead of throwing, so this
    // "working production tool today" cannot 500 on a deploy-ordering race.
    // All statuses are included (not just "delivered") because this is a
    // trusted backoffice reader, unlike the flag-gated, delivered-only portal
    // reader. Do not re-sort by `status` — lexicographic order
    // (archived < delivered < draft) would surface drafts oddly; the
    // deliveredAt/createdAt recency order from getProject() is preserved.
    galleries: projectRecord.galleries.map((gallery) => ({
      id: gallery.id,
      title: gallery.title,
      provider: gallery.provider,
      url: gallery.url,
      status: gallery.status,
      passcode: gallery.passcode,
      deliveredAt: gallery.deliveredAt,
      expiresAt: gallery.expiresAt,
      createdBy: gallery.createdBy,
    })),
    expenses: expenseRows.map((row) => ({
      id: row.expense.id,
      vendorId: row.vendor.id,
      vendorName: row.vendor.name,
      projectId: row.expense.projectId,
      category: row.expense.category,
      description: row.expense.description,
      amountCents: row.expense.amountCents,
      status: row.expense.status,
      paidAt: row.expense.paidAt,
      paymentMethod: row.expense.paymentMethod,
      externalPaymentId: row.expense.externalPaymentId,
      receiptUrl: row.expense.receiptUrl,
      taxDeductible: row.expense.taxDeductible,
      notes: row.expense.notes,
      sourceType: row.expense.sourceType,
      sourceId: row.expense.sourceId,
    })),
  };
}

export async function getStudioProjectContext(projectId: string) {
  return projectContextResult(await getProject(projectId));
}

function cleanTaskRunText(value: string | null | undefined) {
  return value?.trim() || null;
}

function taskRunSpecialistMatches(task: typeof agentTasks.$inferSelect, assignedAgent: string) {
  return !task.assignedAgent
    || task.assignedAgent === assignedAgent
    || task.assignedAgent === "The Reeses Studio Agent";
}

export async function startStudioAgentTaskRun(input: {
  taskId?: string | null;
  projectId?: string | null;
  assignedAgent?: string | null;
}) {
  const taskId = cleanTaskRunText(input.taskId);
  const projectId = cleanTaskRunText(input.projectId);
  const assignedAgent = cleanTaskRunText(input.assignedAgent) ?? "The Reeses Studio Agent";
  let task: typeof agentTasks.$inferSelect | null = null;

  if (taskId) {
    const existingTask = await db.query.agentTasks.findFirst({
      where: projectId
        ? and(eq(agentTasks.id, taskId), eq(agentTasks.projectId, projectId))
        : eq(agentTasks.id, taskId),
    });
    if (!existingTask) return null;
    if (["completed", "failed", "cancelled"].includes(existingTask.status)) {
      throw new Error("Terminal agent tasks cannot be started.");
    }
    if (!taskRunSpecialistMatches(existingTask, assignedAgent)) {
      throw new Error("Agent task is assigned to a different agent.");
    }
    task = existingTask.status === "queued"
      ? await claimNextAgentTask({ taskId, projectId, assignedAgent })
      : existingTask;
  } else {
    task = await claimNextAgentTask({ projectId, assignedAgent });
  }

  if (!task) return null;

  const hydratedTask = await hydrateAgentTaskLinkedSource(task);
  const projectContext = task.projectId ? await getStudioProjectContext(task.projectId) : null;
  const workflowStep = task.sourceType === "project_workflow_step" && task.sourceId
    ? await db.query.projectWorkflowSteps.findFirst({
      where: task.projectId
        ? and(eq(projectWorkflowSteps.id, task.sourceId), eq(projectWorkflowSteps.projectId, task.projectId))
        : eq(projectWorkflowSteps.id, task.sourceId),
    })
    : null;
  const workflowRun = workflowStep
    ? await db.query.projectWorkflowRuns.findFirst({ where: eq(projectWorkflowRuns.id, workflowStep.workflowRunId) })
    : null;
  const isWorkflowTask = Boolean(workflowStep && workflowRun);

  return {
    agentTask: hydratedTask,
    projectContext,
    workflow: isWorkflowTask
      ? {
        run: workflowRun,
        step: workflowStep,
      }
      : null,
    executionContract: {
      assignedAgent,
      safetyRules: [
        "Use only canonical ids returned by Studio context.",
        "Do not send client-facing emails or texts unless a separate Studio send/approval tool explicitly permits it.",
        "Store durable outputs back into Studio instead of leaving them only in chat.",
        "Cite project_source records on generated proposals, invoices, timelines, events, locations, communications, and expenses when the task is source-linked.",
      ],
      recommendedReadTools: [
        "studio_get_project_context",
        "studio_list_templates",
        "studio_list_activity",
      ],
      completion: isWorkflowTask
        ? {
          mcpTool: "studio_submit_workflow_task_result",
          restEndpoint: `/api/agent/tasks/${task.id}/workflow-result`,
          requiredFields: ["taskId", "outputBody"],
          optionalFields: ["assignedAgent", "outputTitle", "outputSummary", "outputKind", "metadata"],
        }
        : {
          mcpTool: "studio_update_agent_task",
          restEndpoint: `/api/agent/tasks/${task.id}`,
          requiredFields: ["taskId", "status"],
          optionalFields: ["assignedAgent", "resultSummary", "outputJson", "errorMessage", "sourceType", "sourceId"],
        },
    },
  };
}

function projectContextClientName(projectContext: Awaited<ReturnType<typeof getStudioProjectContext>> | null) {
  const primaryClient = projectContext?.clients.find((client) => client.isPrimaryContact) ?? projectContext?.clients[0];
  if (!primaryClient) return "there";
  return primaryClient.preferredName || joinedName(primaryClient.firstName, primaryClient.lastName) || primaryClient.firstName;
}

function projectContextLabel(projectContext: Awaited<ReturnType<typeof getStudioProjectContext>> | null) {
  if (!projectContext) return "this project";
  const project = projectContext.project;
  return [
    project.name,
    project.eventDate ? `on ${project.eventDate}` : null,
    project.venueName ? `at ${project.venueName}` : null,
  ].filter(Boolean).join(" ");
}

function recentSourceSummary(projectContext: Awaited<ReturnType<typeof getStudioProjectContext>> | null) {
  const sources = projectContext?.sources.slice(0, 3) ?? [];
  if (!sources.length) return "No project sources are attached yet; ask Tyler to add discovery notes before finalizing.";
  return sources.map((source) => `- ${source.title}: ${source.summary || source.body.slice(0, 180)}`).join("\n");
}

function workflowDraftForStep(input: {
  stepKey: string;
  title: string;
  triggerLabel: string | null;
  assignedAgent: string;
  projectContext: Awaited<ReturnType<typeof getStudioProjectContext>> | null;
}) {
  const clientName = projectContextClientName(input.projectContext);
  const projectLabel = projectContextLabel(input.projectContext);
  const sources = recentSourceSummary(input.projectContext);

  if (input.stepKey === "lead-introduction-text") {
    return {
      outputTitle: `${input.title} - draft`,
      outputSummary: "Prepared a first-touch introduction text for Tyler to review.",
      outputKind: "workflow_draft",
      outputBody: [
        `Draft SMS for ${clientName}:`,
        "",
        `Hi ${clientName}, thank you so much for reaching out to The Reeses. I would love to hear more about what you are dreaming up for ${projectLabel}. Are you open to a quick call so I can learn what matters most and point you toward the right next step?`,
        "",
        "Review notes:",
        "- Confirm the client's preferred name before sending.",
        "- Keep this as a Tyler-approved draft; do not send automatically.",
      ].join("\n"),
    };
  }

  if (input.stepKey === "day-1-call") {
    return {
      outputTitle: `${input.title} - brief`,
      outputSummary: "Prepared Day 1 call talking points and logging checklist.",
      outputKind: "workflow_brief",
      outputBody: [
        `Call brief for ${projectLabel}:`,
        "",
        "Open with:",
        `- Thank ${clientName} for reaching out and ask what prompted them to connect now.`,
        "- Ask what they most want the photography experience to feel like.",
        "- Confirm date, location, decision makers, planning stage, and budget comfort.",
        "",
        "Before package discussion:",
        "- Listen for emotional priorities and logistical constraints.",
        "- Ask what would make the process feel easy.",
        "- Log exact phrases as a project source after the call.",
        "",
        "Current source context:",
        sources,
      ].join("\n"),
    };
  }

  if (input.stepKey === "proposal-retainer-package") {
    return {
      outputTitle: `${input.title} - handoff brief`,
      outputSummary: "Prepared proposal, contract-note, and retainer invoice handoff for Tyler approval.",
      outputKind: "workflow_brief",
      outputBody: [
        `Proposal handoff for ${projectLabel}:`,
        "",
        "Draft package direction:",
        "- Build the proposal around the client's stated priorities, not a generic package list.",
        "- Cite the discovery/planning source on proposal, invoice, and contract-ready notes.",
        "- Include retainer invoice planning, payment schedule assumptions, and client-paid card-fee policy review.",
        "",
        "Open items Tyler should confirm:",
        "- Final package price and any optional add-ons.",
        "- Retainer amount and due date.",
        "- Whether contract language needs a custom clause for location, travel, or delivery.",
        "",
        "Source context:",
        sources,
      ].join("\n"),
    };
  }

  if (input.stepKey === "timeline-questionnaire" || input.stepKey === "one-month-prior") {
    return {
      outputTitle: `${input.title} - planning brief`,
      outputSummary: "Prepared planning/timeline review notes for Tyler approval.",
      outputKind: "workflow_brief",
      outputBody: [
        `Planning brief for ${projectLabel}:`,
        "",
        "Review these areas:",
        "- Timeline anchors, locations, travel buffers, and photo priorities.",
        "- Family/wedding party combinations and any sensitive dynamics.",
        "- Vendor contacts, planner handoff, rain plan, and parking/load-in notes.",
        "- Missing questionnaire answers or project fields that need confirmation.",
        "",
        "Source context:",
        sources,
      ].join("\n"),
    };
  }

  if (input.stepKey === "day-after-touchpoint") {
    return {
      outputTitle: `${input.title} - draft`,
      outputSummary: "Prepared a day-after celebration message for Tyler approval.",
      outputKind: "workflow_draft",
      outputBody: [
        `Draft day-after message for ${clientName}:`,
        "",
        `Hi ${clientName}, we are still thinking about your day and loved being part of ${projectLabel}. Thank you again for trusting us with it.`,
        "",
        "Review notes:",
        "- Mention sneak peek timing if known; otherwise set a simple expectation.",
        "- Keep this celebratory and brief.",
        "- Do not send automatically.",
      ].join("\n"),
    };
  }

  if (input.stepKey === "sneak-peek-delivery" || input.stepKey === "gallery-delivery") {
    const deliveryLabel = input.stepKey === "sneak-peek-delivery" ? "sneak peek" : "full gallery";
    return {
      outputTitle: `${input.title} - draft`,
      outputSummary: `Prepared a ${deliveryLabel} delivery message for Tyler approval.`,
      outputKind: "workflow_draft",
      outputBody: [
        `Draft ${deliveryLabel} delivery for ${clientName}:`,
        "",
        `Hi ${clientName}, your ${deliveryLabel} for ${projectLabel} is ready.`,
        "",
        "Include for Tyler review:",
        "- Gallery link placeholder or confirmed URL.",
        "- Download, sharing, or print guidance as appropriate.",
        input.stepKey === "sneak-peek-delivery"
          ? "- Brief note on when the full gallery is expected."
          : "- Warm close to the project experience and any album/print next steps.",
        "- Do not send automatically.",
        "",
        "Source context:",
        sources,
      ].join("\n"),
    };
  }

  if (input.stepKey === "review-request" || input.stepKey === "referral-follow-up") {
    const askLabel = input.stepKey === "review-request" ? "review" : "referral";
    return {
      outputTitle: `${input.title} - draft`,
      outputSummary: `Prepared a ${askLabel} follow-up message for Tyler approval.`,
      outputKind: "workflow_draft",
      outputBody: [
        `Draft ${askLabel} follow-up for ${clientName}:`,
        "",
        input.stepKey === "review-request"
          ? `Hi ${clientName}, it meant so much to serve you on ${projectLabel}. If you have a moment, a short review helps future couples know what working with The Reeses feels like.`
          : `Hi ${clientName}, thank you again for the kind words about ${projectLabel}. If you know anyone currently planning a wedding or session, we would be grateful for a personal introduction.`,
        "",
        "Review notes:",
        input.stepKey === "review-request"
          ? "- Include the review link before sending."
          : "- Keep the referral ask personal and low-pressure.",
        "- Do not send automatically.",
      ].join("\n"),
    };
  }

  return {
    outputTitle: `${input.title} - workflow brief`,
    outputSummary: `Prepared a ${input.assignedAgent} workflow brief for Tyler approval.`,
    outputKind: "workflow_brief",
    outputBody: [
      `${input.title} for ${projectLabel}`,
      "",
      `Trigger: ${input.triggerLabel ?? "Workflow step"}`,
      `Assigned agent: ${input.assignedAgent}`,
      "",
      "Recommended next action:",
      "- Review canonical project context below.",
      "- Draft the client-facing or operational output for Tyler approval.",
      "- Do not send client-facing communication automatically.",
      "",
      "Source context:",
      sources,
    ].join("\n"),
  };
}

export async function runStudioWorkflowDraftTask(input: {
  taskId?: string | null;
  projectId?: string | null;
  assignedAgent?: string | null;
  previewOnly?: boolean | null;
}) {
  const agentTaskRun = await startStudioAgentTaskRun(input);
  if (!agentTaskRun) return null;
  if (!agentTaskRun.workflow?.step) {
    throw new Error("Agent task is not linked to a project workflow step.");
  }
  if (!agentTaskRun.agentTask) {
    throw new Error("Agent task run did not return a task.");
  }

  const assignedAgent = cleanTaskRunText(input.assignedAgent)
    ?? agentTaskRun.agentTask.assignedAgent
    ?? agentTaskRun.workflow.step.assignedAgent;
  const draft = workflowDraftForStep({
    stepKey: agentTaskRun.workflow.step.stepKey,
    title: agentTaskRun.workflow.step.title,
    triggerLabel: agentTaskRun.workflow.step.triggerLabel,
    assignedAgent,
    projectContext: agentTaskRun.projectContext,
  });

  if (input.previewOnly) {
    return {
      agentTaskRun,
      draft,
      completed: false,
    };
  }

  const completion = await completeProjectWorkflowAgentTask(agentTaskRun.agentTask.id, {
    assignedAgent,
    ...draft,
    metadata: {
      generatedBy: "studio_rule_based_workflow_runner",
      previewOnly: false,
    },
  });

  return {
    agentTaskRun,
    draft,
    completion,
    completed: true,
  };
}

export async function runStudioTimelineDraftTask(input: {
  taskId?: string | null;
  projectId?: string | null;
  assignedAgent?: string | null;
  previewOnly?: boolean | null;
}) {
  const agentTaskRun = await startStudioAgentTaskRun({
    taskId: input.taskId,
    projectId: input.projectId,
    assignedAgent: input.assignedAgent ?? "Timeline Agent",
  });
  if (!agentTaskRun) return null;
  if (!agentTaskRun.agentTask?.projectId || !agentTaskRun.projectContext) {
    throw new Error("Timeline draft tasks require linked project context.");
  }
  const assignedAgent = cleanTaskRunText(input.assignedAgent)
    ?? agentTaskRun.agentTask.assignedAgent
    ?? "Timeline Agent";
  if (assignedAgent !== "Timeline Agent") {
    throw new Error("Timeline draft runner only handles Timeline Agent tasks.");
  }

  const sourceId = agentTaskRun.agentTask.sourceType === "project_source"
    ? agentTaskRun.agentTask.sourceId
    : null;
  const draft = buildTimelineDraftFromProjectContext(agentTaskRun.projectContext, { sourceId });
  const resultSummary = [
    `Prepared timeline draft with ${draft.timelineItems.length} timeline items.`,
    `${draft.familyFormals.length} family formal groups.`,
    `${draft.openQuestions.length} review questions.`,
  ].join(" ");

  if (input.previewOnly) {
    return {
      agentTaskRun,
      draft,
      completed: false,
    };
  }

  const completion = await updateAgentTaskStatus(agentTaskRun.agentTask.id, {
    status: "completed",
    assignedAgent,
    resultSummary,
    outputJson: {
      projectId: agentTaskRun.agentTask.projectId,
      projectSourceId: sourceId ?? undefined,
      timelineDraft: draft,
      generatedBy: "studio_rule_based_timeline_draft_runner",
    },
  });

  return {
    agentTaskRun,
    draft,
    completion,
    completed: true,
  };
}

export async function getStudioSettingsContext() {
  const settings = await getAppSettings();
  return {
    business: {
      businessName: settings.businessName,
      publicBrandName: settings.publicBrandName,
      contactEmail: settings.contactEmail,
      websiteUrl: settings.websiteUrl,
      instagramUrl: settings.instagramUrl,
      timezone: settings.timezone,
    },
    paymentMethods: enabledPaymentMethods(settings.paymentMethods).map((method) => ({
      key: method.key,
      displayName: method.displayName,
      instructions: method.instructions,
      passFees: method.passFees,
    })),
  };
}

export async function listStudioTemplates(input: { type?: string | null; includeArchived?: boolean | null } = {}) {
  const requestedType = input.type?.trim() || undefined;
  const type = requestedType && studioTemplateTypes.has(requestedType) ? requestedType : undefined;
  const rows = await db.query.templates.findMany({
    where: type ? eq(templates.type, type) : undefined,
    orderBy: desc(templates.updatedAt),
  });

  return rows
    .filter((template) => input.includeArchived || template.status !== "archived")
    .map((template) => ({
      id: template.id,
      type: template.type,
      name: template.name,
      trigger: template.trigger,
      subject: template.subject,
      body: template.body,
      status: template.status,
      updatedAt: template.updatedAt,
    }));
}

async function callTool(params: unknown) {
  const { name, arguments: rawArguments } = paramsRecord(params) as ToolCallParams;
  const args = paramsRecord(rawArguments);

  if (name === "studio_search_projects") {
    const projectSearch = await searchStudioProjectIndex({
      query: optionalStringArg(args, "query"),
      page: numberArg(args, "page", 1),
      limit: numberArg(args, "limit", 10),
      sort: optionalStringArg(args, "sort") as ProjectIndexSort | null,
    });
    return textToolResult(projectSearch);
  }

  if (name === "studio_get_project_context") {
    const projectId = stringArg(args, "projectId");
    const projectContext = await getStudioProjectContext(projectId);
    return textToolResult({ projectContext });
  }

  if (name === "studio_get_client_context") {
    const clientId = stringArg(args, "clientId");
    const clientContext = await getClientWithProjects(clientId);
    if (!clientContext) throw new Error("Client not found.");
    return textToolResult({ clientContext });
  }

  if (name === "studio_get_agenda") {
    const timeZone = optionalStringArg(args, "timeZone") ?? "America/New_York";
    const agenda = await getAgenda({
      fromDate: optionalStringArg(args, "fromDate") ?? dateKeyInTimeZone(new Date(), timeZone),
      toDate: optionalStringArg(args, "toDate"),
      types: agendaTypesArg(args),
      limit: hasArg(args, "limit") ? Math.min(Math.max(Math.trunc(numberArg(args, "limit", 50)), 1), 100) : undefined,
      timeZone,
    });
    return textToolResult({ agenda });
  }

  if (name === "studio_list_activity") {
    const activity = await listStudioActivityLog({
      actorType: optionalStringArg(args, "actorType") as "all" | "admin" | "agent" | "client" | "system" | undefined,
      projectId: optionalStringArg(args, "projectId"),
      limit: hasArg(args, "limit") ? numberArg(args, "limit", 100) : undefined,
    });
    return textToolResult({ activity });
  }

  if (name === "studio_get_data_health") {
    const dataHealth = await listStudioDataHealth();
    return textToolResult({ dataHealth });
  }

  if (name === "studio_get_finance_report") {
    const financeReport = await getAgentFinanceReport({
      paymentStatus: optionalStringArg(args, "paymentStatus"),
      expenseStatus: optionalStringArg(args, "expenseStatus"),
      fromDate: optionalStringArg(args, "fromDate"),
      toDate: optionalStringArg(args, "toDate"),
      asOfDate: optionalStringArg(args, "asOfDate"),
    });
    return textToolResult({ financeReport });
  }

  if (name === "studio_get_business_review") {
    // READ-ONLY derived analytics (§4). No canonical write; the agent drafts prose
    // from this JSON and never auto-sends. Optional dates are the only inputs read.
    const review = await getBusinessReview({
      fromDate: optionalStringArg(args, "fromDate"),
      toDate: optionalStringArg(args, "toDate"),
      asOfDate: optionalStringArg(args, "asOfDate"),
    });
    return textToolResult({ review });
  }

  if (name === "studio_get_settings") {
    const settings = await getStudioSettingsContext();
    return textToolResult({ settings });
  }

  if (name === "studio_list_templates") {
    const templates = await listStudioTemplates({
      type: optionalStringArg(args, "type"),
      includeArchived: booleanArg(args, "includeArchived", false),
    });
    return textToolResult({ templates });
  }

  if (name === "studio_list_questionnaires") {
    const questionnaires = await listStudioQuestionnaires({
      status: optionalStringArg(args, "status"),
      includeArchived: booleanArg(args, "includeArchived", false),
      includeQuestions: hasArg(args, "includeQuestions") ? booleanArg(args, "includeQuestions", true) : true,
    });
    return textToolResult({ questionnaires });
  }

  if (name === "studio_list_scheduler_meeting_types") {
    const meetingTypes = await listStudioSchedulerMeetingTypes({
      projectId: optionalStringArg(args, "projectId"),
      clientId: optionalStringArg(args, "clientId"),
      includeInactive: booleanArg(args, "includeInactive", false),
    });
    return textToolResult({ meetingTypes });
  }

  if (name === "studio_create_project") {
    const project = await createProjectFromAgent(args as AgentProjectCreateInput);
    return textToolResult({ project });
  }

  if (name === "studio_update_project") {
    const projectId = stringArg(args, "projectId");
    const project = await updateProjectFromAgent(projectId, args as AgentProjectUpdateInput);
    return textToolResult({ project });
  }

  if (name === "studio_link_client_to_project") {
    const role = optionalStringArg(args, "role") === "other" && optionalStringArg(args, "customRole")
      ? optionalStringArg(args, "customRole")
      : optionalStringArg(args, "role");
    const link = await linkClientToProject({
      projectId: stringArg(args, "projectId"),
      clientId: stringArg(args, "clientId"),
      role,
      actorType: "agent",
      actorName: "The Reeses Studio Agent",
    });
    return textToolResult({ link });
  }

  if (name === "studio_update_client") {
    const clientId = stringArg(args, "clientId");
    const { client, linkedProjectIds } = await updateClientFromAgent(clientId, args as AgentClientUpdateInput);
    return textToolResult({ client, linkedProjectIds });
  }

  if (name === "studio_merge_clients") {
    const merge = await mergeClients({
      survivorClientId: stringArg(args, "survivorClientId"),
      duplicateClientId: stringArg(args, "duplicateClientId"),
      actorType: "agent",
      actorName: optionalStringArg(args, "actorName") ?? "The Reeses Studio Agent",
    });
    return textToolResult({ merge });
  }

  if (name === "studio_list_project_workflow_automations") {
    const projectId = stringArg(args, "projectId");
    const workflowRuns = await listProjectWorkflowRuns(projectId);
    return textToolResult({ availableSteps: sixFigureAutomationSteps, workflowRuns });
  }

  if (name === "studio_setup_project_workflow_automation") {
    const setup = await enableSixFigureWorkflowForProject({
      projectId: stringArg(args, "projectId"),
      stepKeys: stringArrayArg(args, "stepKeys"),
      createdBy: optionalStringArg(args, "createdBy") ?? "The Reeses Studio Agent",
    });
    return textToolResult({ workflowRun: setup.run, workflowSteps: setup.steps });
  }

  if (name === "studio_queue_project_workflow_steps") {
    const queued = await queueProjectWorkflowSteps(stringArg(args, "workflowRunId"), {
      stepKeys: stringArrayArg(args, "stepKeys"),
    });
    return textToolResult({ workflowRun: queued.run, workflowSteps: queued.steps, queuedTasks: queued.queuedTasks });
  }

  if (name === "studio_create_project_event") {
    const projectId = stringArg(args, "projectId");
    const event = await createProjectEventFromAgent(projectId, args as AgentProjectEventInput);
    return textToolResult({ event });
  }

  if (name === "studio_update_project_event") {
    const projectId = stringArg(args, "projectId");
    const event = await updateProjectEventFromAgent(projectId, stringArg(args, "eventId"), args as AgentProjectEventInput);
    return textToolResult({ event });
  }

  if (name === "studio_create_project_location") {
    const projectId = stringArg(args, "projectId");
    const location = await createProjectLocationFromAgent(projectId, args as AgentProjectLocationInput);
    return textToolResult({ location });
  }

  if (name === "studio_attach_gallery_link") {
    const projectId = stringArg(args, "projectId");
    const gallery = await attachProjectGalleryFromAgent(projectId, args as AgentGalleryAttachInput);
    return textToolResult({ gallery });
  }

  if (name === "studio_update_project_location") {
    const projectId = stringArg(args, "projectId");
    const location = await updateProjectLocationFromAgent(projectId, stringArg(args, "locationId"), args as AgentProjectLocationInput);
    return textToolResult({ location });
  }

  if (name === "studio_create_project_source") {
    const projectId = stringArg(args, "projectId");
    const projectSource = await createProjectSourceFromAgent(projectId, {
      kind: stringArg(args, "kind"),
      title: stringArg(args, "title"),
      body: stringArg(args, "body"),
      summary: optionalStringArg(args, "summary"),
      occurredAt: optionalStringArg(args, "occurredAt"),
      externalUrl: optionalStringArg(args, "externalUrl"),
      capturedBy: optionalStringArg(args, "capturedBy"),
      sourceType: optionalStringArg(args, "sourceType"),
      sourceId: optionalStringArg(args, "sourceId"),
      metadata: args.metadata,
    });
    return textToolResult({ projectSource });
  }

  if (name === "studio_update_project_source") {
    const patch: Record<string, unknown> = {};
    for (const key of ["kind", "title", "body", "summary", "occurredAt", "externalUrl", "capturedBy", "sourceType", "sourceId", "metadata"]) {
      if (hasArg(args, key)) patch[key] = key === "metadata" ? args.metadata : optionalStringArg(args, key);
    }
    const projectSource = await updateProjectSourceFromAgent(
      stringArg(args, "projectId"),
      stringArg(args, "projectSourceId"),
      patch,
    );
    return textToolResult({ projectSource });
  }

  if (name === "studio_create_agent_task") {
    const agentTask = await createAgentTask({
      projectId: optionalStringArg(args, "projectId"),
      title: stringArg(args, "title"),
      instructions: optionalStringArg(args, "instructions"),
      priority: optionalStringArg(args, "priority"),
      requestedBy: optionalStringArg(args, "requestedBy"),
      assignedAgent: optionalStringArg(args, "assignedAgent"),
      sourceType: optionalStringArg(args, "sourceType"),
      sourceId: optionalStringArg(args, "sourceId"),
    });
    return textToolResult({ agentTask: await hydrateAgentTaskLinkedSource(agentTask) });
  }

  if (name === "studio_list_agent_tasks") {
    const agentTasks = await listAgentTasks({
      projectId: optionalStringArg(args, "projectId"),
      status: optionalStringArg(args, "status"),
      assignedAgent: optionalStringArg(args, "assignedAgent"),
      limit: numberArg(args, "limit", 20),
    });
    return textToolResult({ agentTasks: await hydrateAgentTaskLinkedSources(agentTasks) });
  }

  if (name === "studio_claim_agent_task") {
    const agentTask = await claimNextAgentTask({
      taskId: optionalStringArg(args, "taskId"),
      projectId: optionalStringArg(args, "projectId"),
      assignedAgent: optionalStringArg(args, "assignedAgent"),
    });
    return textToolResult({ agentTask: await hydrateAgentTaskLinkedSource(agentTask) });
  }

  if (name === "studio_start_agent_task_run") {
    const agentTaskRun = await startStudioAgentTaskRun({
      taskId: optionalStringArg(args, "taskId"),
      projectId: optionalStringArg(args, "projectId"),
      assignedAgent: optionalStringArg(args, "assignedAgent"),
    });
    return textToolResult({ agentTaskRun });
  }

  if (name === "studio_update_agent_task") {
    const updateInput = {
      status: stringArg(args, "status"),
      assignedAgent: optionalStringArg(args, "assignedAgent"),
      resultSummary: optionalStringArg(args, "resultSummary"),
      outputJson: args.outputJson,
      errorMessage: optionalStringArg(args, "errorMessage"),
    } as {
      status: string;
      assignedAgent?: string | null;
      resultSummary?: string | null;
      outputJson?: unknown;
      errorMessage?: string | null;
      sourceType?: string | null;
      sourceId?: string | null;
    };
    if (Object.prototype.hasOwnProperty.call(args, "sourceType")) updateInput.sourceType = optionalStringArg(args, "sourceType");
    if (Object.prototype.hasOwnProperty.call(args, "sourceId")) updateInput.sourceId = optionalStringArg(args, "sourceId");

    const agentTask = await updateAgentTaskStatus(stringArg(args, "taskId"), updateInput);
    return textToolResult({ agentTask: await hydrateAgentTaskLinkedSource(agentTask) });
  }

  if (name === "studio_submit_workflow_task_result") {
    const result = await completeProjectWorkflowAgentTask(stringArg(args, "taskId"), {
      assignedAgent: optionalStringArg(args, "assignedAgent"),
      outputTitle: optionalStringArg(args, "outputTitle"),
      outputBody: stringArg(args, "outputBody"),
      outputSummary: optionalStringArg(args, "outputSummary"),
      outputKind: optionalStringArg(args, "outputKind"),
      metadata: args.metadata,
    });
    return textToolResult(result);
  }

  if (name === "studio_run_workflow_draft_task") {
    const workflowDraftRun = await runStudioWorkflowDraftTask({
      taskId: stringArg(args, "taskId"),
      projectId: optionalStringArg(args, "projectId"),
      assignedAgent: optionalStringArg(args, "assignedAgent"),
      previewOnly: booleanArg(args, "previewOnly"),
    });
    return textToolResult({ workflowDraftRun });
  }

  if (name === "studio_create_questionnaire_link") {
    const link = await createQuestionnaireLinkFromAgent(
      stringArg(args, "projectId"),
      args as AgentQuestionnaireLinkInput,
    );
    return textToolResult({ link });
  }

  if (name === "studio_upsert_questionnaire_response") {
    const responseId = optionalStringArg(args, "responseId") ?? await createProjectQuestionnaireResponseDraft({
      questionnaireId: stringArg(args, "questionnaireId"),
      projectId: stringArg(args, "projectId"),
      clientId: optionalStringArg(args, "clientId"),
    });
    await updateQuestionnaireResponseAnswers({
      responseId,
      answers: questionnaireAnswersArg(args),
      submit: booleanArg(args, "submit"),
    });
    return textToolResult({ questionnaireResponse: await questionnaireResponseResult(responseId) });
  }

  if (name === "studio_create_timeline_item") {
    const projectId = stringArg(args, "projectId");
    const timelineItem = await createProjectTimelineItem(projectId, {
      title: stringArg(args, "title"),
      description: optionalStringArg(args, "description"),
      startAt: optionalStringArg(args, "startAt"),
      endAt: optionalStringArg(args, "endAt"),
      sourceType: optionalStringArg(args, "sourceType") ?? "agent",
      sourceId: optionalStringArg(args, "sourceId"),
    });
    return textToolResult({ timelineItem });
  }

  if (name === "studio_create_timeline_items") {
    const projectId = stringArg(args, "projectId");
    const timelineItems = await createProjectTimelineItemsFromAgent(projectId, {
      sourceType: optionalStringArg(args, "sourceType") ?? "agent",
      sourceId: optionalStringArg(args, "sourceId"),
      replaceExistingForSource: booleanArg(args, "replaceExistingForSource"),
      timelineItems: timelineItemsArg(args),
    });
    return textToolResult({ timelineItems });
  }

  if (name === "studio_update_timeline_item") {
    const timelineItem = await updateProjectTimelineItem(stringArg(args, "projectId"), stringArg(args, "timelineItemId"), {
      title: optionalStringArg(args, "title"),
      description: optionalStringArg(args, "description"),
      startAt: optionalStringArg(args, "startAt"),
      endAt: optionalStringArg(args, "endAt"),
      sortOrder: hasArg(args, "sortOrder") ? numberArg(args, "sortOrder", 0) : undefined,
      sourceType: optionalStringArg(args, "sourceType"),
      sourceId: optionalStringArg(args, "sourceId"),
    }, "agent");
    return textToolResult({ timelineItem });
  }

  if (name === "studio_create_proposal") {
    const projectId = stringArg(args, "projectId");
    const proposal = await createProposalFromAgent(projectId, args as AgentProposalInput);
    return textToolResult({ proposal });
  }

  if (name === "studio_update_proposal") {
    const proposal = await updateProposalFromAgent(
      stringArg(args, "projectId"),
      stringArg(args, "proposalId"),
      args as AgentProposalUpdateInput,
    );
    return textToolResult({ proposal });
  }

  if (name === "studio_create_proposal_link") {
    const link = await createProposalLinkFromAgent(
      stringArg(args, "projectId"),
      stringArg(args, "proposalId"),
      args as AgentProposalLinkInput,
    );
    return textToolResult({ link });
  }

  if (name === "studio_create_portal_link") {
    const link = await createPortalLinkFromAgent(
      stringArg(args, "projectId"),
      {
        clientId: optionalStringArg(args, "clientId"),
        label: optionalStringArg(args, "label"),
      },
    );
    return textToolResult({ link });
  }

  if (name === "studio_create_invoice") {
    const projectId = stringArg(args, "projectId");
    const invoice = await createInvoiceFromAgent(projectId, args as AgentInvoiceInput);
    return textToolResult({ invoice });
  }

  if (name === "studio_update_invoice") {
    const invoice = await updateInvoiceFromAgent(
      stringArg(args, "projectId"),
      stringArg(args, "invoiceId"),
      args as AgentInvoiceUpdateInput,
    );
    return textToolResult({ invoice });
  }

  if (name === "studio_record_invoice_payment") {
    const invoiceId = stringArg(args, "invoiceId");
    const payment = await recordInvoicePaymentFromAgent(invoiceId, args as AgentInvoicePaymentInput);
    return textToolResult({ payment });
  }

  if (name === "studio_create_invoice_payment_checkout") {
    const checkout = await createInvoicePaymentCheckoutSession(
      stringArg(args, "invoiceId"),
      stringArg(args, "paymentId"),
      {
        actorType: "agent",
        actorName: "The Reeses Studio Agent",
      },
    );
    return textToolResult({ checkout });
  }

  if (name === "studio_update_invoice_payment") {
    const invoiceId = stringArg(args, "invoiceId");
    const payment = await updateInvoicePaymentFromAgent(invoiceId, args as AgentInvoicePaymentInput);
    return textToolResult({ payment });
  }

  if (name === "studio_log_invoice_reminder") {
    const invoiceId = stringArg(args, "invoiceId");
    const reminder = await logInvoiceReminderFromAgent(invoiceId, args as AgentInvoiceReminderInput);
    return textToolResult({ reminder });
  }

  if (name === "studio_record_scheduler_booking_payment") {
    const bookingId = stringArg(args, "bookingId");
    const payment = await recordSchedulerBookingPaymentFromAgent(bookingId, args as SchedulerBookingPaymentInput);
    return textToolResult({ payment });
  }

  if (name === "studio_update_scheduler_booking_payment") {
    const bookingId = stringArg(args, "bookingId");
    const payment = await updateSchedulerBookingPaymentFromAgent(bookingId, args as SchedulerBookingPaymentInput);
    return textToolResult({ payment });
  }

  if (name === "studio_create_expense") {
    const projectId = stringArg(args, "projectId");
    const expense = await createExpenseFromAgent(projectId, args as AgentExpenseInput);
    return textToolResult({ expense });
  }

  if (name === "studio_update_expense") {
    const expense = await updateExpenseFromAgent(
      stringArg(args, "projectId"),
      stringArg(args, "expenseId"),
      args as AgentExpenseUpdateInput,
    );
    return textToolResult({ expense });
  }

  if (name === "studio_create_communication") {
    const projectId = stringArg(args, "projectId");
    const communication = await createProjectCommunicationFromAgent(projectId, {
      clientId: optionalStringArg(args, "clientId"),
      direction: optionalStringArg(args, "direction"),
      channel: optionalStringArg(args, "channel"),
      status: optionalStringArg(args, "status"),
      subject: optionalStringArg(args, "subject"),
      body: stringArg(args, "body"),
      recipientName: optionalStringArg(args, "recipientName"),
      recipientEmail: optionalStringArg(args, "recipientEmail"),
      scheduledFor: optionalStringArg(args, "scheduledFor"),
      sentAt: optionalStringArg(args, "sentAt"),
      sourceType: optionalStringArg(args, "sourceType"),
      sourceId: optionalStringArg(args, "sourceId"),
    });
    return textToolResult({ communication });
  }

  if (name === "studio_update_communication") {
    const projectId = stringArg(args, "projectId");
    const patch: Record<string, string | undefined> = {};
    for (const key of ["direction", "channel", "status", "subject", "body", "recipientName", "recipientEmail", "scheduledFor", "sentAt", "sourceType", "sourceId"]) {
      if (hasArg(args, key)) patch[key] = optionalStringArg(args, key);
    }
    const communication = await updateProjectCommunicationFromAgent(projectId, stringArg(args, "communicationId"), patch);
    return textToolResult({ communication });
  }

  if (name === "studio_draft_sms") {
    const projectId = stringArg(args, "projectId");
    // HARD-FORCE channel:"sms", status:"draft", direction:"outbound". The hostile
    // fields (status/channel/createdBy) are never read from args — an agent can
    // never mint a sent/queued SMS or trigger a send. The real enforcement is the
    // §3.0(b) boundary in createProjectCommunicationFromAgent (agent+sms ⇒ draft),
    // so even the generic studio_create_communication cannot bypass it.
    const communication = await createProjectCommunicationFromAgent(projectId, {
      clientId: optionalStringArg(args, "clientId"),
      direction: "outbound",
      channel: "sms",
      status: "draft",
      body: stringArg(args, "body"),
      sourceType: optionalStringArg(args, "sourceType"),
      sourceId: optionalStringArg(args, "sourceId"),
    });
    return textToolResult({ communication });
  }

  if (name === "studio_draft_email") {
    const projectId = stringArg(args, "projectId");
    // HARD-FORCE channel:"email", status:"draft", direction:"outbound". The
    // hostile fields (status/channel/createdBy) are never read from args — an
    // agent can never mint a sent/queued email or trigger a send. The real
    // enforcement is the §8 clamp in createProjectCommunicationFromAgent
    // (agent + email ⇒ draft), so even the generic studio_create_communication
    // cannot bypass it.
    const communication = await createProjectCommunicationFromAgent(projectId, {
      clientId: optionalStringArg(args, "clientId"),
      direction: "outbound",
      channel: "email",
      status: "draft",
      subject: optionalStringArg(args, "subject"),
      body: stringArg(args, "body"),
      recipientName: optionalStringArg(args, "recipientName"),
      recipientEmail: optionalStringArg(args, "recipientEmail"),
      sourceType: optionalStringArg(args, "sourceType"),
      sourceId: optionalStringArg(args, "sourceId"),
    });
    return textToolResult({ communication });
  }

  throw Object.assign(new Error(`Unknown Studio MCP tool: ${name ?? "missing name"}`), { code: -32601 });
}

export async function handleStudioMcpMessage(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;

  if (message.jsonrpc !== "2.0") {
    return failure(id, -32600, "Invalid JSON-RPC message.");
  }

  if (message.method === "notifications/initialized") {
    return null;
  }

  if (message.method === "initialize") {
    return success(id, {
      protocolVersion: STUDIO_MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "the-reeses-studio",
        title: "The Reeses Studio MCP",
        version: "0.1.0",
      },
      instructions: "Use these tools to create canonical Studio records. Never invent project ids; call tools only with ids from Studio context.",
    });
  }

  if (message.method === "tools/list") {
    return success(id, { tools: studioTools });
  }

  if (message.method === "tools/call") {
    try {
      return success(id, await callTool(message.params));
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -32603;
      return failure(id, code, error instanceof Error ? error.message : "Studio MCP tool failed.");
    }
  }

  return failure(id, -32601, `Unknown MCP method: ${message.method ?? "missing method"}`);
}
