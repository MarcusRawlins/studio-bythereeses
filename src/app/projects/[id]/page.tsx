import { AppShell } from "@/components/AppShell";
import { LinkActions } from "@/components/LinkActions";
import { ProjectGalleryDeleteForm, ProjectGalleryForm } from "@/components/ProjectGalleryForm";
import { ProjectMilestoneStrip } from "@/components/ProjectMilestoneStrip";
import { ProjectSectionNav } from "@/components/ProjectSectionNav";
import { listAgentTasks } from "@/lib/agent-tasks";
import { getProject } from "@/lib/crm";
import { formatActivityAction, formatDate, formatMoney } from "@/lib/format";
import { isGalleryUrlSafe } from "@/lib/gallery";
import { computeProjectMilestones, type MilestoneInput } from "@/lib/project-milestones";
import { timelineDraftVersion } from "@/lib/project-timeline";
import { projectWorkingNotes } from "@/lib/project-notes";
import {
  emailApprovalHash,
  emailSendingEnabled,
  MEETING_NOTE_TEMPLATE,
  resolveEmailRecipientForCommunication,
  sha256Hex,
} from "@/lib/project-communications";
import { isEmailSuppressed } from "@/lib/email";
import { getProjectFinancialSummary } from "@/lib/project-finance";
import { listProjectWorkflowRuns, sixFigureAutomationSteps } from "@/lib/project-workflow-automation";
import {
  listProjectQuestionnaireResponses,
  listQuestionnaires,
  questionnaireAutofillReviewEnabled,
  questionnaireResponseStatus,
} from "@/lib/questionnaires";
import { listProjectBookingLinks } from "@/lib/scheduler";
import { listProjectSequenceEnrollments } from "@/lib/sequences";
import { isNumberSuppressed, smsEnabled, toE164 } from "@/lib/sms";
import { ArrowDownLeft, ArrowUpRight, Bot, CalendarCheck, CalendarPlus, CheckCircle2, ClipboardEdit, ClipboardList, Copy, ExternalLink, Eye, FileQuestion, FileSignature, Images, Landmark, Mail, MapPin, MessageSquare, NotebookPen, Pencil, ReceiptText, Send, Sparkles, UsersRound } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const projectStages = [
  "inquiry",
  "proposal_sent",
  "retainer_paid",
  "planning",
  "editing",
  "delivered",
  "completed",
];

const projectTypes = ["wedding", "engagement", "family", "branding", "portrait", "event", "other"];
const projectEventTypes = ["engagement", "wedding", "rehearsal", "portrait"];
const projectLocationTypes = ["getting_ready", "ceremony", "reception", "portrait", "after_party"];

const inputClass =
  "w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition placeholder:text-[#aaa197] focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(47,93,80,0.14)]";

const agentTaskStatusLabels: Record<string, string> = {
  queued: "Queued",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const communicationStatusLabels: Record<string, string> = {
  draft: "Draft",
  queued: "Queued",
  sent: "Sent",
  archived: "Archived",
};

// Phase 8b follow-up (task #27): reasons the admin "Send SMS" action surfaces
// back to Tyler, mirroring the typed refusal reasons `sendApprovedProjectSms`
// returns (src/lib/project-communications.ts) — no silent drops (spec §2.3).
const smsSendErrorMessages: Record<string, string> = {
  no_consent: "That client has not opted in to SMS. Nothing was sent.",
  bad_number: "The client's phone number is not a valid SMS destination. Nothing was sent.",
  suppressed: "That number has texted STOP and is suppressed. Nothing was sent.",
  flag_off: "SMS sending is currently disabled. The draft is saved but nothing was sent.",
  hash_mismatch: "This SMS draft changed after it was reviewed. Re-review the message and try again.",
  not_draft: "This SMS was already sent, or is not a sendable outbound draft.",
  not_found: "That SMS draft could not be found.",
  not_sms: "That communication is not an SMS.",
  too_long: "This SMS draft is over the character limit. Shorten it and try again.",
  send_failed: "The SMS could not be sent due to a delivery error. Nothing was sent; please try again.",
};

// Phase 14: reasons the admin "Send email" action surfaces back to Tyler,
// mirroring the typed refusal reasons `sendApprovedProjectEmail` returns
// (src/lib/project-communications.ts) — no silent drops.
const emailSendErrorMessages: Record<string, string> = {
  no_recipient: "This email draft has no resolvable recipient. Add a recipient email and try again.",
  suppressed: "That email address is suppressed. Nothing was sent.",
  flag_off: "Email sending is currently disabled. The draft is saved but nothing was sent.",
  hash_mismatch: "This email draft (or its recipient) changed after it was reviewed. Re-review and try again.",
  not_draft: "This email was already sent, or is not a sendable outbound draft.",
  not_found: "That email draft could not be found.",
  not_email: "That communication is not an email.",
  too_long: "This email draft is over the character limit. Shorten it and try again.",
  not_configured: "Email is not configured yet. Nothing was sent.",
  send_failed: "The email could not be sent due to a delivery error. Nothing was sent; please try again.",
};

// Read-only email-send precheck shown next to a draft email so Tyler doesn't
// attempt a send the server-side gate will refuse. The server gate stays
// authoritative; this is a display convenience mirroring the SMS consent labels.
type EmailSendCheck = { recipient: string | null; suppressed: boolean; approvedBodyHash: string | null };

// Read-only reasons the UI shows next to a draft SMS so Tyler doesn't attempt a
// send that the server-side gate (src/lib/sms.ts) will refuse anyway. The
// server-side gate remains authoritative; this is a display convenience.
const smsConsentReasonLabels: Record<string, string> = {
  ok: "Consented — ready to send",
  no_client: "No linked client on this draft",
  no_consent: "Client has not opted in to SMS",
  bad_number: "Client phone is not a valid SMS number",
  suppressed: "Number replied STOP — suppressed",
};

type SmsConsentCheck = { ok: boolean; reason: keyof typeof smsConsentReasonLabels };

async function checkSmsDraftConsent(
  communication: { clientId: string | null },
  clientsById: Map<string, { smsOptIn: boolean; phone: string | null }>,
): Promise<SmsConsentCheck> {
  const client = communication.clientId ? clientsById.get(communication.clientId) : undefined;
  if (!client) return { ok: false, reason: "no_client" };
  if (client.smsOptIn !== true) return { ok: false, reason: "no_consent" };
  const normalized = toE164(client.phone);
  if (!normalized) return { ok: false, reason: "bad_number" };
  if (await isNumberSuppressed(normalized)) return { ok: false, reason: "suppressed" };
  return { ok: true, reason: "ok" };
}

function mapsUrl(...parts: Array<string | null | undefined>) {
  const query = parts.filter(Boolean).join(", ");
  return query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : null;
}

function formatTimestamp(value: string | null) {
  if (!value) return "Not submitted";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function responsePerson(response: {
  respondentName: string | null;
  respondentEmail: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  clientPreferredName: string | null;
  clientEmail: string | null;
}) {
  const clientName = [response.clientFirstName, response.clientLastName].filter(Boolean).join(" ");
  return response.respondentName || response.clientPreferredName || clientName || response.respondentEmail || response.clientEmail || "Unknown respondent";
}

function projectEventTypeValue(type: string) {
  return projectEventTypes.includes(type) ? type : "other";
}

function customProjectEventTypeValue(type: string) {
  return projectEventTypes.includes(type) ? "" : type;
}

function projectLocationTypeValue(type: string) {
  return projectLocationTypes.includes(type) ? type : "other";
}

function customProjectLocationTypeValue(type: string) {
  return projectLocationTypes.includes(type) ? "" : type;
}

function titleize(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ") : "";
}

function taskSourceLabel(sourceType: string | null, sourceId: string | null, sources: Array<{ id: string; title: string }>) {
  if (sourceType === "project_source" && sourceId) {
    return sources.find((source) => source.id === sourceId)?.title ?? `Project source ${sourceId}`;
  }
  if (sourceType) return titleize(sourceType);
  return null;
}

function taskTimelineDraft(outputJson: string | null) {
  if (!outputJson) return null;
  try {
    const parsed = JSON.parse(outputJson) as {
      timelineDraft?: {
        openQuestions?: string[];
        timelineItems?: Array<{ title?: string; startAt?: string; confidence?: string }>;
        familyFormals?: Array<{ groupName?: string; people?: string[] }>;
      };
    };
    return parsed.timelineDraft ?? null;
  } catch {
    return null;
  }
}

function datetimeLocalValue(value: string | null) {
  if (!value) return "";
  return value.slice(0, 16);
}

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    portalLink?: string;
    saved?: string;
    error?: string;
    smsError?: string;
    emailError?: string;
    applyError?: string;
    applyConfirm?: string;
    applyConfirmCount?: string;
  }>;
}) {
  const { id } = await params;
  const { portalLink, saved, error, smsError, emailError, applyError, applyConfirm, applyConfirmCount } = await searchParams;
  const autofillReviewOn = questionnaireAutofillReviewEnabled();
  if (id.startsWith("seed-project-")) {
    redirect("/projects?pageSize=200");
  }

  const data = await getProject(id);
  if (!data) notFound();
  const workingNotes = projectWorkingNotes(data.project.notes);
  const clientsById = new Map(data.clients.map((client) => [client.id, client]));
  const smsSendingEnabled = smsEnabled();
  const emailSendEnabled = emailSendingEnabled();
  const smsConsentByCommunicationId = new Map<string, SmsConsentCheck>();
  const emailSendByCommunicationId = new Map<string, EmailSendCheck>();
  for (const communication of data.communications) {
    if (communication.channel === "sms" && communication.status === "draft" && communication.direction === "outbound") {
      smsConsentByCommunicationId.set(communication.id, await checkSmsDraftConsent(communication, clientsById));
    }
    if (communication.channel === "email" && communication.status === "draft" && communication.direction === "outbound") {
      // Resolve the recipient server-side (the SAME resolution the send path uses)
      // and bind the DISPLAYED recipient into the approval hash — this is what
      // makes the send path's re-resolution + hash check reject a post-review
      // recipientEmail swap (spec §1.2, Finding MEDIUM 1).
      const recipient = await resolveEmailRecipientForCommunication(data.project.id, communication);
      const suppressed = recipient ? await isEmailSuppressed(recipient) : false;
      const approvedBodyHash = recipient
        ? emailApprovalHash(communication.subject, communication.body, recipient)
        : null;
      emailSendByCommunicationId.set(communication.id, { recipient, suppressed, approvedBodyHash });
    }
  }

  const primaryClient = data.clients[0];
  const hasEngagementSession = data.events.some((event) => event.type === "engagement");
  const [bookingLinks, questionnaireResponses, questionnaireTemplates, agentTasks, financialSummary] = await Promise.all([
    listProjectBookingLinks(data.project.id, primaryClient?.id),
    listProjectQuestionnaireResponses(data.project.id),
    listQuestionnaires(),
    listAgentTasks({ projectId: data.project.id, limit: 5 }),
    getProjectFinancialSummary(data.project.id),
  ]);
  const workflowRuns = await listProjectWorkflowRuns(data.project.id);
  const sixFigureRun = workflowRuns.find((workflow) => workflow.run.workflowKey === "six-figure-maximized-workflow");
  const selectedWorkflowStepKeys = new Set(sixFigureRun?.steps.map(({ step }) => step.stepKey) ?? []);
  const sequenceEnrollments = await listProjectSequenceEnrollments(data.project.id);

  // Phase 22 (project progress / milestone timeline). Strict `=== "1"` read, dark by default —
  // mirrors the PORTAL_MAGIC_LINK_ENABLED pattern in src/app/portal/page.tsx. `getProject`'s two
  // additive fields (`payments`, `bookings`) are always loaded (purely additive, cheap, indexed
  // queries), but the compute + render only run when the flag is on, so the flag-off page is
  // byte-identical to today.
  const projectProgressTimelineEnabled = process.env.PROJECT_PROGRESS_TIMELINE === "1";
  const projectMilestones = projectProgressTimelineEnabled
    ? computeProjectMilestones(
        {
          stage: data.project.stage,
          type: data.project.type,
          createdAt: data.project.createdAt,
          eventDate: data.project.eventDate,
          events: data.events.map((event) => ({ type: event.type, title: event.title, eventDate: event.eventDate })),
          bookings: data.bookings.map((booking) => ({
            startAt: booking.startAt,
            status: booking.status,
            meetingName: booking.meetingName,
            title: null,
          })),
          proposals: data.proposals.map((proposal) => ({
            status: proposal.status,
            sentAt: proposal.sentAt,
            acceptedAt: proposal.acceptedAt,
            signedAt: proposal.signedAt,
            contractStatus: proposal.contractStatus,
          })),
          invoices: data.invoices.map((invoice) => ({ id: invoice.id, status: invoice.status, dueDate: invoice.dueDate })),
          payments: data.payments.map((payment) => ({
            invoiceId: payment.invoiceId,
            status: payment.status,
            dueDate: payment.dueDate,
            label: payment.label,
          })),
          galleries: data.galleries.map((gallery) => ({
            status: gallery.status,
            title: gallery.title,
            deliveredAt: gallery.deliveredAt,
            createdAt: gallery.createdAt,
          })),
        } satisfies MilestoneInput,
        new Date(),
      )
    : [];

  // Phase 20 (meeting/consult notes, dark behind MEETING_NOTES_ENABLED, D6/D9). `data.bookings` is
  // reused, unchanged, both to build the "which meeting" picker options (cancelled excluded, B-4)
  // and to label a booking-linked communication row in the feed below (cancelled INCLUDED, so a
  // note linked to a since-cancelled booking still renders its badge, B-4/test 18) — no extra query
  // for either.
  const meetingNotesEnabled = process.env.MEETING_NOTES_ENABLED === "1";
  const bookingsById = new Map(data.bookings.map((booking) => [booking.id, booking]));
  const linkableBookings = data.bookings.filter((booking) => booking.status !== "cancelled");

  const sectionNavItems = [
    { id: "overview", label: "Overview", icon: UsersRound },
    ...(financialSummary ? [{ id: "finances", label: "Finances", icon: Landmark }] : []),
    { id: "sales", label: "Sales", icon: FileSignature },
    { id: "questionnaires", label: "Questionnaires", icon: ClipboardList },
    { id: "timeline", label: "Timeline", icon: CalendarCheck },
    { id: "agent-tasks", label: "Agent", icon: Bot },
    { id: "details", label: "Details", icon: MapPin },
  ];

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="studio-project-hero flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <span className={`studio-chip studio-stage-${data.project.stage}`}>{data.project.stage.replaceAll("_", " ")}</span>
              <span className="studio-caps text-[0.56rem] text-[var(--ink-3)]">{data.project.type}</span>
            </div>
            <h1 className="brand-page-title mt-3 text-4xl md:text-5xl">{data.project.name}</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">
              {data.project.venueName ?? "Venue TBD"} · {formatDate(data.project.eventDate)}
              {primaryClient ? ` · ${[primaryClient.firstName, primaryClient.lastName].filter(Boolean).join(" ")}` : ""}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Link href={`/projects/${data.project.id}/edit`} className="studio-secondary-button inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold">
              <Pencil className="h-4 w-4" />
              Edit project
            </Link>
            <form action={`/api/projects/${data.project.id}/portal`} method="post">
              <input type="hidden" name="projectId" value={data.project.id} />
              <input type="hidden" name="clientId" value={primaryClient?.id ?? ""} />
              <button className="brand-primary-button px-4 py-2.5 transition">
                Generate portal link
              </button>
            </form>
          </div>
        </header>

        <ProjectSectionNav items={sectionNavItems} />

        {projectProgressTimelineEnabled && <ProjectMilestoneStrip milestones={projectMilestones} />}

        {portalLink && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--accent-strong)]">
                  <Copy className="h-4 w-4" />
                  Portal link generated
                </div>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  Copy this now. For security, the full token is only shown immediately after creation.
                </p>
              </div>
            </div>
            <LinkActions url={portalLink} copyLabel="Copy portal link" openLabel="Open portal" className="mt-3" />
          </div>
        )}

        {saved === "details" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Project details saved.
          </div>
        )}

        {(saved === "calendar" || saved === "calendar-event") && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            {saved === "calendar" ? "Project date synced to Google Calendar." : "Project event synced to Google Calendar."}
          </div>
        )}

        {saved === "event" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Project event saved.
          </div>
        )}

        {saved === "location" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Project location saved. Studio and agent tools now share this same record.
          </div>
        )}

        {saved === "agent-task" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Agent task assigned. It is now in the Inbox and linked to this project.
          </div>
        )}

        {saved === "timeline-draft" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Timeline draft created. Review it in Agent tasks before applying anything to the canonical timeline.
          </div>
        )}

        {saved === "workflow" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Studio workflow set up for this project. No agent tasks were queued yet.
          </div>
        )}

        {saved === "workflow-queued" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Selected workflow steps were queued as agent tasks in the Inbox.
          </div>
        )}

        {saved === "source" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Project source saved. It is now available to Studio, the portal context, and trusted agent tools.
          </div>
        )}

        {saved === "communication" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Project communication saved. Studio and agent tools now share this same record.
          </div>
        )}

        {saved === "sms_sent" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            SMS sent to the client.
          </div>
        )}

        {smsError && (
          <div className="rounded-md border border-[var(--danger)] bg-[#fff5f2] p-4 text-sm font-semibold text-[var(--danger)]">
            {smsSendErrorMessages[smsError] ?? "The SMS could not be sent."}
          </div>
        )}

        {saved === "email_sent" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Email sent to the client.
          </div>
        )}

        {emailError && (
          <div className="rounded-md border border-[var(--danger)] bg-[#fff5f2] p-4 text-sm font-semibold text-[var(--danger)]">
            {emailSendErrorMessages[emailError] ?? "The email could not be sent."}
          </div>
        )}

        {saved === "timeline_draft_applied" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Timeline draft applied.
          </div>
        )}

        {applyError && (
          <div className="rounded-md border border-[var(--danger)] bg-[#fff5f2] p-4 text-sm font-semibold text-[var(--danger)]">
            {applyError}
          </div>
        )}

        {saved === "timeline" && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            Timeline item saved. Studio and agent tools now share this same record.
          </div>
        )}

        {(error === "calendar-date" || error === "calendar-sync") && (
          <div className="rounded-md border border-[var(--danger)] bg-[#fff5f2] p-4 text-sm font-semibold text-[var(--danger)]">
            {error === "calendar-date"
              ? "Add an event date before syncing Google Calendar."
              : "Google Calendar sync failed. Check Scheduler calendar settings and try again."}
          </div>
        )}

        <section id="overview" className="studio-section-card grid gap-4 md:grid-cols-3">
          <div className="studio-kpi-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Project value</div>
            <div className="studio-serif mt-2 text-3xl tabular-nums">{formatMoney(data.project.budgetCents)}</div>
          </div>
          <div className="studio-kpi-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Client</div>
            {primaryClient ? (
              <Link href={`/clients/${primaryClient.id}`} className="studio-serif mt-2 block text-3xl transition hover:text-[var(--accent-strong)]">
                {[primaryClient.firstName, primaryClient.lastName].filter(Boolean).join(" ")}
              </Link>
            ) : (
              <div className="studio-serif mt-2 text-3xl">Unassigned</div>
            )}
          </div>
          <div className="studio-kpi-card">
            <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">Portal tokens</div>
            <div className="studio-serif mt-2 text-3xl tabular-nums">{data.tokens.length}</div>
          </div>

          <div className="md:col-span-3 grid gap-4 md:grid-cols-2">
            <form action={`/api/projects/${data.project.id}/stage`} method="post" className="studio-card-muted flex flex-col gap-3 p-4 sm:flex-row sm:items-end sm:justify-between">
              <input type="hidden" name="projectId" value={data.project.id} />
              <label className="space-y-1.5 text-sm font-medium sm:min-w-72">
                Stage
                <select
                  name="stage"
                  defaultValue={data.project.stage}
                  className="studio-input"
                >
                  {projectStages.map((stage) => (
                    <option key={stage} value={stage}>
                      {stage.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </label>
              <button className="brand-primary-button px-4 py-2.5 transition">
                Update stage
              </button>
            </form>

            <form action={`/api/projects/${data.project.id}/primary-client`} method="post" className="studio-card-muted flex flex-col gap-3 p-4 sm:flex-row sm:items-end sm:justify-between">
              <input type="hidden" name="projectId" value={data.project.id} />
              <label className="space-y-1.5 text-sm font-medium sm:min-w-96">
                Primary client
                <select name="clientId" defaultValue={primaryClient?.id ?? ""} className="studio-input">
                  {data.participants.map(({ client, role, isPrimaryContact }) => (
                    <option key={client.id} value={client.id}>
                      {[client.firstName, client.lastName].filter(Boolean).join(" ") || client.email || client.id} · {role}{isPrimaryContact ? " · primary" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button className="brand-primary-button px-4 py-2.5 transition">
                Set primary
              </button>
            </form>
          </div>
        </section>

        {financialSummary && (
          <section id="finances" className="studio-section-card">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <h2 className="text-lg font-semibold">Project finances</h2>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">Canonical revenue, receivables, fees, and project costs.</p>
              </div>
              <Link href={`/finance?status=all`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                <ReceiptText className="h-4 w-4" />
                Finance
              </Link>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-md border border-[var(--line)] bg-[#fbf9f5] p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Scheduled</div>
                <div className="mt-2 text-2xl font-semibold">{formatMoney(financialSummary.scheduledCents)}</div>
                <div className="mt-1 text-xs text-[var(--ink-muted)]">{financialSummary.invoicePaymentCount + financialSummary.schedulerPaymentCount} payment record{financialSummary.invoicePaymentCount + financialSummary.schedulerPaymentCount === 1 ? "" : "s"}</div>
              </div>
              <div className="rounded-md border border-[var(--line)] bg-[#fbf9f5] p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Paid</div>
                <div className="mt-2 text-2xl font-semibold">{formatMoney(financialSummary.paidCents)}</div>
                <div className="mt-1 text-xs text-[var(--ink-muted)]">{formatMoney(financialSummary.netDepositCents)} expected deposit</div>
              </div>
              <div className="rounded-md border border-[var(--line)] bg-[#fbf9f5] p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Open</div>
                <div className="mt-2 text-2xl font-semibold">{formatMoney(financialSummary.openCents)}</div>
                <div className="mt-1 text-xs text-[var(--ink-muted)]">Remaining receivable</div>
              </div>
              <div className="rounded-md border border-[var(--line)] bg-[#fbf9f5] p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Projected profit</div>
                <div className="mt-2 text-2xl font-semibold">{formatMoney(financialSummary.projectedProfitCents)}</div>
                <div className="mt-1 text-xs text-[var(--ink-muted)]">{formatMoney(financialSummary.collectedProfitCents)} collected profit</div>
              </div>
            </div>
            <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] pb-3 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-3">
                <span className="text-[var(--ink-muted)]">Client card fees</span>
                <span className="font-semibold">{formatMoney(financialSummary.clientFeeCents)}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] pb-3 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-3">
                <span className="text-[var(--ink-muted)]">Processor fees</span>
                <span className="font-semibold">{formatMoney(financialSummary.processingFeeCents)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[var(--ink-muted)]">Expenses</span>
                <span className="font-semibold">{formatMoney(financialSummary.expenseCents)}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-[var(--line)] pt-3 sm:col-span-3">
                <span className="text-[var(--ink-muted)]">Accounts payable</span>
                <span className="font-semibold">{formatMoney(financialSummary.openPayableCents)}</span>
              </div>
            </div>
          </section>
        )}

        <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
          <section id="sales" className="studio-section-card xl:col-span-2">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-lg font-semibold">Sales package</h2>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">Proposals and invoices connected to this project.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={`/proposals/new?projectId=${data.project.id}`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                  <FileSignature className="h-4 w-4" />
                  New proposal
                </Link>
                <Link href={`/invoices/new?projectId=${data.project.id}`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                  <ReceiptText className="h-4 w-4" />
                  New invoice
                </Link>
              </div>
            </div>
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <div className="rounded-md border border-[var(--line)] p-4">
                <h3 className="font-semibold">Proposals</h3>
                <div className="mt-3 divide-y divide-[var(--line)]">
                  {data.proposals.map((proposal) => (
                    <Link key={proposal.id} href={`/proposals/${proposal.id}`} className="block py-3 transition hover:text-[var(--brand-brown)]">
                      <div className="font-semibold">{proposal.title}</div>
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">{formatMoney(proposal.totalCents)} · {proposal.status.replaceAll("_", " ")}</div>
                    </Link>
                  ))}
                  {!data.proposals.length && <p className="py-3 text-sm text-[var(--ink-muted)]">No proposals yet.</p>}
                </div>
              </div>
              <div className="rounded-md border border-[var(--line)] p-4">
                <h3 className="font-semibold">Invoices</h3>
                <div className="mt-3 divide-y divide-[var(--line)]">
                  {data.invoices.map((invoice) => (
                    <Link key={invoice.id} href={`/invoices/${invoice.id}`} className="block py-3 transition hover:text-[var(--brand-brown)]">
                      <div className="font-semibold">{invoice.invoiceNumber}</div>
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">{formatMoney(invoice.clientPayableBalanceCents)} balance · {invoice.status.replaceAll("_", " ")}</div>
                    </Link>
                  ))}
                  {!data.invoices.length && <p className="py-3 text-sm text-[var(--ink-muted)]">No invoices yet.</p>}
                </div>
              </div>
            </div>
          </section>

          <section id="questionnaires" className="studio-section-card xl:col-span-2">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <div className="flex items-center gap-2">
                  <ClipboardList className="h-4 w-4 text-[var(--ink-muted)]" />
                  <h2 className="text-lg font-semibold">Questionnaires</h2>
                </div>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">Create, send, and directly edit saved client responses for this project.</p>
              </div>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(360px,1.1fr)]">
              <form action={`/api/projects/${data.project.id}/questionnaires`} method="post" className="grid gap-3 rounded-md border border-[var(--line)] bg-[#fbf9f5] p-4">
                <input type="hidden" name="status" value="active" />
                <div>
                  <h3 className="font-semibold">New questionnaire</h3>
                  <p className="mt-1 text-sm leading-6 text-[var(--ink-muted)]">Start a saved form, then edit and send it from this project.</p>
                </div>
                <label className="grid gap-1.5 text-sm font-semibold">
                  Title
                  <input name="title" placeholder="Wedding weekend details" className={inputClass} required />
                </label>
                <label className="grid gap-1.5 text-sm font-semibold">
                  Description
                  <textarea name="description" rows={3} placeholder="What this questionnaire collects." className={inputClass} />
                </label>
                <button className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 text-sm transition">
                  <FileQuestion className="h-4 w-4" />
                  Create and edit
                </button>
              </form>

              <div className="rounded-md border border-[var(--line)]">
                <div className="border-b border-[var(--line)] p-4">
                  <h3 className="font-semibold">Available templates</h3>
                  <p className="mt-1 text-sm text-[var(--ink-muted)]">Use any saved questionnaire with this project.</p>
                </div>
                <div className="divide-y divide-[var(--line)]">
                  {questionnaireTemplates.map((questionnaire) => (
                    <div key={questionnaire.id} className="grid gap-3 p-4 lg:grid-cols-[1fr_auto] lg:items-center">
                      <div>
                        <div className="font-semibold">{questionnaire.title}</div>
                        <div className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">{questionnaire.status}</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Link href={`/questionnaires/${questionnaire.id}?projectId=${data.project.id}`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                          <Pencil className="h-4 w-4" />
                          Edit
                        </Link>
                        <Link href={`/questionnaires/${questionnaire.id}/preview`} target="_blank" className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                          <Eye className="h-4 w-4" />
                          Preview
                        </Link>
                        <form action={`/api/projects/${data.project.id}/questionnaire-responses`} method="post">
                          <input type="hidden" name="questionnaireId" value={questionnaire.id} />
                          <input type="hidden" name="clientId" value={primaryClient?.id ?? ""} />
                          <button className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                            <ClipboardEdit className="h-4 w-4" />
                            Fill responses
                          </button>
                        </form>
                        <Link href={`/questionnaires/${questionnaire.id}/send?projectId=${data.project.id}`} className="brand-primary-button inline-flex items-center gap-2 rounded-sm px-3 py-2 text-sm">
                          <Send className="h-4 w-4" />
                          Send
                        </Link>
                      </div>
                    </div>
                  ))}
                  {!questionnaireTemplates.length && <p className="p-4 text-sm text-[var(--ink-muted)]">No questionnaires have been created yet.</p>}
                </div>
              </div>
            </div>

            <div className="mt-5">
              <h3 className="font-semibold">Responses for this project</h3>
              <div className="mt-3 divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
              {questionnaireResponses.map((response) => {
                const status = questionnaireResponseStatus(response);
                return (
                  <div
                    key={response.id}
                    className="grid gap-3 p-4 transition hover:bg-[#fbf9f5] md:grid-cols-[1fr_220px_auto] md:items-center"
                  >
                    <div>
                      <Link href={`/questionnaires/${response.questionnaireId}/responses/${response.id}`} className="font-semibold transition hover:text-[var(--accent-strong)]">
                        {response.questionnaireTitle}
                      </Link>
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">{responsePerson(response)}</div>
                    </div>
                    <div className="text-sm text-[var(--ink-muted)]">
                      {status === "submitted" ? "Submitted" : "Draft saved"} {formatTimestamp(response.submittedAt ?? response.updatedAt)}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-fit rounded-full border border-[var(--line)] px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                        {status}
                      </span>
                      <Link href={`/questionnaires/${response.questionnaireId}/responses/${response.id}`} className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--line)] px-2.5 py-1.5 text-xs font-semibold transition hover:border-[var(--foreground)]">
                        <Eye className="h-3.5 w-3.5" />
                        View responses
                      </Link>
                    </div>
                  </div>
                );
              })}
              {!questionnaireResponses.length && <p className="p-4 text-sm text-[var(--ink-muted)]">No questionnaire responses are linked to this project yet.</p>}
              </div>
            </div>
          </section>

          <section id="details" className="studio-section-card">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <h2 className="text-lg font-semibold">Project details</h2>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">Venue, location, type, and working notes for this project.</p>
              </div>
              <div className="text-right text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                Calendar sync
                <div className="mt-1 text-sm font-medium normal-case tracking-normal text-[var(--foreground)]">
                  {data.project.calendarSyncStatus.replaceAll("_", " ")}
                </div>
                {data.project.googleCalendarEventId && data.project.calendarSyncStatus === "synced" ? (
                  <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-[var(--line)] px-2.5 py-1 text-xs normal-case tracking-normal text-[var(--accent-strong)]">
                    <CalendarCheck className="h-3.5 w-3.5" />
                    Synced
                  </div>
                ) : data.project.eventDate ? (
                  <form action={`/api/projects/${data.project.id}/calendar`} method="post" className="mt-2">
                    <button className="inline-flex items-center gap-1 rounded-sm border border-[var(--line)] px-2.5 py-1 text-xs font-semibold normal-case tracking-normal transition hover:border-[var(--foreground)]">
                      <CalendarPlus className="h-3.5 w-3.5" />
                      Sync calendar
                    </button>
                  </form>
                ) : (
                  <div className="mt-2 text-xs font-medium normal-case tracking-normal text-[var(--ink-muted)]">Add event date first.</div>
                )}
              </div>
            </div>

            <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Type</dt>
                <dd className="mt-1 font-medium capitalize">{titleize(data.project.type) || "Not set"}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Venue</dt>
                <dd className="mt-1 font-medium">{data.project.venueName || "Venue TBD"}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Venue address</dt>
                <dd className="mt-1 flex gap-1.5 font-medium">
                  {data.project.venueAddress ? <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" /> : null}
                  <span>{data.project.venueAddress || "Address TBD"}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Location</dt>
                <dd className="mt-1 font-medium">{[data.project.city, data.project.state].filter(Boolean).join(", ") || "Location TBD"}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Notes</dt>
                <dd className="mt-1 whitespace-pre-line leading-relaxed text-[var(--foreground)]">
                  {workingNotes || "No working notes yet."}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Day-of locations</dt>
                <dd className="mt-2 grid gap-2 sm:grid-cols-2">
                  {data.locations.slice(0, 6).map((location) => (
                    <div key={location.id} className="rounded-md border border-[var(--line)] bg-white px-3 py-2">
                      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                        {location.type.replaceAll("_", " ")}
                      </div>
                      <div className="mt-1 font-medium">{location.name}</div>
                      <div className="mt-1 text-xs text-[var(--ink-muted)]">
                        {[location.address, location.city, location.state].filter(Boolean).join(", ") || location.notes || "Details not set"}
                      </div>
                    </div>
                  ))}
                  {!data.locations.length && <span className="text-sm text-[var(--ink-muted)]">No day-of locations yet.</span>}
                </dd>
              </div>
            </dl>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              {mapsUrl(data.project.venueAddress, data.project.venueName, data.project.city, data.project.state) ? (
                <a
                  href={mapsUrl(data.project.venueAddress, data.project.venueName, data.project.city, data.project.state) ?? undefined}
                  target="_blank"
                  className="inline-flex items-center gap-2 text-sm font-semibold underline"
                >
                  <MapPin className="h-3.5 w-3.5" />
                  Open current map
                </a>
              ) : null}
            </div>

            <details className="group mt-5 rounded-md border border-[var(--line)]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold transition hover:bg-[#fbf9f5]">
                <span className="inline-flex items-center gap-2">
                  <Pencil className="h-4 w-4" />
                  Edit details
                </span>
                <span className="text-xs uppercase tracking-[0.12em] text-[var(--ink-muted)] group-open:hidden">Open</span>
                <span className="hidden text-xs uppercase tracking-[0.12em] text-[var(--ink-muted)] group-open:inline">Close</span>
              </summary>
              <form action={`/api/projects/${data.project.id}`} method="post" className="grid gap-3 border-t border-[var(--line)] p-4">
                <label className="space-y-1.5 text-sm font-medium">
                  Type
                  <select name="type" defaultValue={data.project.type} className={inputClass}>
                    {projectTypes.map((type) => (
                      <option key={type} value={type}>
                        {type.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Event date
                  <input name="eventDate" type="date" defaultValue={data.project.eventDate ?? ""} className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Venue
                  <input name="venueName" defaultValue={data.project.venueName ?? ""} placeholder="Venue name" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Venue address
                  <input name="venueAddress" defaultValue={data.project.venueAddress ?? ""} placeholder="Full address for Google Maps" className={inputClass} />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 text-sm font-medium">
                    City
                    <input name="city" defaultValue={data.project.city ?? ""} placeholder="Chatham" className={inputClass} />
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    State
                    <input name="state" defaultValue={data.project.state ?? ""} placeholder="MA" className={inputClass} />
                  </label>
                </div>
                <label className="space-y-1.5 text-sm font-medium">
                  Notes
                  <textarea name="notes" rows={6} defaultValue={workingNotes ?? ""} placeholder="Client preferences, planning decisions, logistics, or context worth remembering." className={inputClass} />
                </label>
                <label className="flex items-start gap-3 rounded-md border border-[var(--line)] bg-white p-3 text-sm font-medium">
                  <input name="engagementSessionIncluded" type="checkbox" defaultChecked={hasEngagementSession} className="mt-1 h-4 w-4 rounded border-[var(--line)] accent-[var(--accent)]" />
                  <span>
                    Engagement session included
                    <span className="mt-1 block text-xs font-normal text-[var(--ink-muted)]">
                      Checked keeps an engagement reminder on the dashboard until a session date is set. Unchecked removes only unscheduled placeholders.
                    </span>
                  </span>
                </label>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  {mapsUrl(data.project.venueAddress, data.project.venueName, data.project.city, data.project.state) ? (
                    <a
                      href={mapsUrl(data.project.venueAddress, data.project.venueName, data.project.city, data.project.state) ?? undefined}
                      target="_blank"
                      className="inline-flex items-center gap-2 text-sm font-semibold underline"
                    >
                      <MapPin className="h-3.5 w-3.5" />
                      Open current map
                    </a>
                  ) : (
                    <span className="text-sm text-[var(--ink-muted)]">Add a venue address to enable map lookup.</span>
                  )}
                  <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">
                    Save details
                  </button>
                </div>
              </form>
            </details>
          </section>

          <section id="events" className="studio-section-card">
            <h2 className="text-lg font-semibold">Project booking links</h2>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">Signed scheduler links that save bookings back to this project.</p>
            <div className="mt-4 space-y-3">
              {bookingLinks.map(({ meetingType, url }) => (
                <div key={meetingType.id} className="rounded-md border border-[var(--line)] p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-semibold">{meetingType.name}</div>
                    </div>
                    <LinkActions url={url} copyLabel="Copy link" openLabel="Open" />
                  </div>
                </div>
              ))}
              {!bookingLinks.length && <p className="text-sm text-[var(--ink-muted)]">No active scheduler links yet.</p>}
            </div>
          </section>

          <section id="timeline" className="studio-section-card">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <h2 className="studio-serif text-3xl">Timeline</h2>
                <p className="mt-1 text-sm text-[var(--ink-3)]">Canonical timeline items created by Studio or the agent API.</p>
              </div>
              <span className="studio-chip">Agent ready</span>
            </div>
            <div className="mt-5 space-y-3">
              {data.timelineItems.map((item) => (
                <div key={item.id} className="border-l border-[var(--accent)] bg-[var(--paper-2)] px-4 py-3">
                  <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
                    <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">
                      {item.startAt ? formatDate(item.startAt) : "Unscheduled"}
                    </div>
                    <div>
                      <div className="font-semibold">{item.title}</div>
                      {item.description && <p className="mt-1 text-sm text-[var(--ink-3)]">{item.description}</p>}
                      {item.sourceType && (
                        <div className="studio-caps mt-2 text-[0.52rem] text-[var(--ink-3)]">
                          Source: {item.sourceType}{item.sourceId ? ` · ${item.sourceId}` : ""}
                        </div>
                      )}
                    </div>
                  </div>
                  <details className="group mt-3 rounded-md border border-[var(--line)] bg-white">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-semibold transition hover:bg-[var(--paper-2)]">
                      <span className="inline-flex items-center gap-2">
                        <Pencil className="h-3.5 w-3.5" />
                        Edit timeline item
                      </span>
                      <span className="studio-caps text-[0.52rem] text-[var(--ink-3)]">Same canonical row</span>
                    </summary>
                    <form action={`/api/projects/${data.project.id}/timeline`} method="post" className="grid gap-3 border-t border-[var(--line)] p-3 md:grid-cols-2">
                      <input type="hidden" name="timelineItemId" value={item.id} />
                      <label className="grid gap-1 text-xs font-semibold text-[var(--ink-3)]">
                        Title
                        <input name="title" required defaultValue={item.title} className={inputClass} />
                      </label>
                      <label className="grid gap-1 text-xs font-semibold text-[var(--ink-3)]">
                        Sort order
                        <input name="sortOrder" type="number" defaultValue={item.sortOrder} className={inputClass} />
                      </label>
                      <label className="grid gap-1 text-xs font-semibold text-[var(--ink-3)]">
                        Start
                        <input name="startAt" type="datetime-local" defaultValue={datetimeLocalValue(item.startAt)} className={inputClass} />
                      </label>
                      <label className="grid gap-1 text-xs font-semibold text-[var(--ink-3)]">
                        End
                        <input name="endAt" type="datetime-local" defaultValue={datetimeLocalValue(item.endAt)} className={inputClass} />
                      </label>
                      <label className="grid gap-1 text-xs font-semibold text-[var(--ink-3)] md:col-span-2">
                        Description
                        <textarea name="description" rows={3} defaultValue={item.description ?? ""} className={inputClass} />
                      </label>
                      <div className="flex justify-end md:col-span-2">
                        <button className="brand-primary-button inline-flex items-center justify-center gap-2 px-4 py-2 text-sm" type="submit">
                          <CheckCircle2 className="h-4 w-4" />
                          Save timeline item
                        </button>
                      </div>
                    </form>
                  </details>
                </div>
              ))}
              {!data.timelineItems.length && (
                <p className="border border-dashed border-[var(--line)] px-4 py-6 text-sm text-[var(--ink-3)]">
                  No timeline items yet. Agent-created timelines will appear here and persist as project records.
                </p>
              )}
            </div>
          </section>

          <section id="workflow" className="studio-section-card">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <div className="flex items-center gap-2">
                  <ClipboardList className="h-4 w-4 text-[var(--ink-3)]" />
                  <h2 className="studio-serif text-2xl">Studio workflow</h2>
                </div>
                <p className="mt-1 text-sm text-[var(--ink-3)]">Choose the Studio steps this project needs — including post-wedding delivery, review, and referral follow-up — then queue agent drafts when you are ready.</p>
              </div>
              <span className="studio-chip">{sixFigureRun ? "Enabled" : "Not set up"}</span>
            </div>

            <details className="mt-4 rounded-[var(--radius-panel)] border border-[var(--line)] bg-white">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-sm font-semibold">
                <span>{sixFigureRun ? `${selectedWorkflowStepKeys.size} steps configured` : "Configure project workflow"}</span>
                <span className="studio-caps text-[0.55rem] text-[var(--ink-3)]">Setup</span>
              </summary>
              <form action={`/api/projects/${data.project.id}/workflows`} method="post" className="border-t border-[var(--line-soft)] p-3">
                <input type="hidden" name="_action" value="setup" />
                <div className="mb-3 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <p className="text-sm text-[var(--ink-3)]">Stores selected steps only. No tasks are queued and no client messages are sent.</p>
                  <button className="brand-primary-button inline-flex min-h-10 items-center justify-center gap-2 px-3 py-2 text-xs transition">
                    <CheckCircle2 className="h-4 w-4" />
                    Save steps
                  </button>
                </div>
                <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                  {sixFigureAutomationSteps.map((step) => (
                    <label key={step.key} className="grid grid-cols-[18px_1fr] gap-2 rounded-md border border-transparent px-2 py-2 text-sm transition hover:border-[var(--line-soft)] hover:bg-[var(--paper-2)]">
                      <input
                        type="checkbox"
                        name="stepKey"
                        value={step.key}
                        defaultChecked={!sixFigureRun || selectedWorkflowStepKeys.has(step.key)}
                        className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{step.title}</span>
                        <span className="mt-0.5 block truncate text-xs text-[var(--ink-3)]">{step.triggerLabel} · {step.assignedAgent}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </form>
            </details>

            {sixFigureRun && (
              <details className="mt-3 rounded-[var(--radius-panel)] border border-[var(--line)] bg-[var(--paper-2)]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-sm font-semibold">
                  <span>Queue agent tasks</span>
                  <span className="studio-caps text-[0.55rem] text-[var(--ink-3)]">Drafts only</span>
                </summary>
                <form action={`/api/projects/${data.project.id}/workflows`} method="post" className="border-t border-[var(--line-soft)] p-3">
                  <input type="hidden" name="_action" value="queue" />
                  <input type="hidden" name="workflowRunId" value={sixFigureRun.run.id} />
                  <div className="mb-3 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                    <p className="text-sm text-[var(--ink-3)]">Creates Inbox tasks only. Already queued steps will not duplicate.</p>
                    <button className="studio-secondary-button inline-flex min-h-10 items-center justify-center gap-2 px-3 py-2 text-xs font-semibold">
                      <Bot className="h-4 w-4" />
                      Queue selected
                    </button>
                  </div>
                  <div className="max-h-56 divide-y divide-[var(--line-soft)] overflow-y-auto rounded-md border border-[var(--line-soft)] bg-white">
                    {sixFigureRun.steps.map(({ step, definition }) => (
                      <label key={step.id} className="grid grid-cols-[18px_1fr] gap-2 px-2 py-2 text-sm">
                        <input
                          type="checkbox"
                          name="stepKey"
                          value={step.stepKey}
                          disabled={Boolean(step.agentTaskId)}
                          defaultChecked={!step.agentTaskId && step.status === "configured"}
                          className="mt-0.5 h-4 w-4 accent-[var(--accent)] disabled:opacity-40"
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{definition.title}</span>
                          <span className="mt-0.5 block truncate text-xs text-[var(--ink-3)]">
                            {definition.triggerLabel} · {step.assignedAgent} · {step.status.replaceAll("_", " ")}
                            {step.agentTaskId ? " · task queued" : ""}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </form>
              </details>
            )}
          </section>

          <section id="sequences" className="studio-section-card">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <div className="flex items-center gap-2">
                  <Send className="h-4 w-4 text-[var(--ink-3)]" />
                  <h2 className="studio-serif text-2xl">Automated sequences</h2>
                </div>
                <p className="mt-1 text-sm text-[var(--ink-3)]">
                  Dunning, pre-event nudges, and review requests. Drafts appear in Communications for approval unless auto-send is enabled.
                </p>
              </div>
              <span className="studio-chip">{sequenceEnrollments.filter(({ enrollment }) => enrollment.status === "active").length} active</span>
            </div>
            {sequenceEnrollments.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--ink-3)]">No sequence enrollments for this project.</p>
            ) : (
              <ul className="mt-4 divide-y divide-[var(--line)] rounded-md border border-[var(--line)] bg-white">
                {sequenceEnrollments.map(({ enrollment, lastStep }) => (
                  <li key={enrollment.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <span className="text-sm font-semibold">{enrollment.sequenceKey}</span>
                      <span className="ml-2 text-xs uppercase tracking-[0.12em] text-[var(--ink-3)]">{enrollment.status}</span>
                      {lastStep && <span className="ml-2 text-xs text-[var(--ink-3)]">last: {lastStep}</span>}
                    </div>
                    <form action={`/api/projects/${data.project.id}/sequences`} method="post" className="flex items-center gap-2">
                      <input type="hidden" name="sequenceKey" value={enrollment.sequenceKey} />
                      <input type="hidden" name="_action" value={enrollment.status === "active" ? "stop" : "activate"} />
                      <button type="submit" className="studio-button-ghost text-xs">
                        {enrollment.status === "active" ? "Unenroll" : "Reactivate"}
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section id="communications" className="studio-section-card">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-[var(--ink-3)]" />
                  <h2 className="studio-serif text-3xl">Communications</h2>
                </div>
                <p className="mt-1 text-sm text-[var(--ink-3)]">Shared follow-up drafts and logs created by Studio or the agent API.</p>
              </div>
              <span className="studio-chip">{data.communications.length} records</span>
            </div>

            <details className="group mt-5 rounded-md border border-[var(--line)] bg-[var(--paper-2)]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold transition hover:bg-white">
                <span className="inline-flex items-center gap-2">
                  <Send className="h-4 w-4" />
                  Draft communication
                </span>
                <span className="text-xs uppercase tracking-[0.12em] text-[var(--ink-3)] group-open:hidden">Open</span>
                <span className="hidden text-xs uppercase tracking-[0.12em] text-[var(--ink-3)] group-open:inline">Close</span>
              </summary>
              <form action={`/api/projects/${data.project.id}/communications`} method="post" className="grid gap-3 border-t border-[var(--line)] bg-white p-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="space-y-1.5 text-sm font-medium">
                    Client
                    <select name="clientId" defaultValue={primaryClient?.id ?? ""} className={inputClass}>
                      <option value="">Primary project client</option>
                      {data.participants.map(({ client, role }) => (
                        <option key={client.id} value={client.id}>
                          {[client.firstName, client.lastName].filter(Boolean).join(" ") || client.email || client.id} · {role}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    Channel
                    <select name="channel" defaultValue="email" className={inputClass}>
                      <option value="email">Email</option>
                      <option value="sms">SMS</option>
                      <option value="call">Call</option>
                      <option value="note">Note</option>
                    </select>
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    Status
                    <select name="status" defaultValue="draft" className={inputClass}>
                      <option value="draft">Draft</option>
                      <option value="queued">Queued</option>
                      <option value="sent">Sent</option>
                      <option value="archived">Archived</option>
                    </select>
                  </label>
                </div>
                <input type="hidden" name="direction" value="outbound" />
                <label className="space-y-1.5 text-sm font-medium">
                  Subject
                  <input name="subject" placeholder="Next steps from your discovery call" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Message
                  <textarea name="body" required rows={6} maxLength={1600} placeholder="Write the follow-up, call recap, or internal note." className={inputClass} />
                </label>
                <p className="-mt-2 text-xs text-[var(--ink-3)]">
                  SMS: save as Draft here, then use Send SMS below once it clears the consent check. Opt-out language
                  and Twilio&apos;s character limit are applied automatically at send time.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 text-sm font-medium">
                    Recipient name
                    <input name="recipientName" placeholder={primaryClient ? [primaryClient.firstName, primaryClient.lastName].filter(Boolean).join(" ") : "Client name"} className={inputClass} />
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    Recipient email
                    <input name="recipientEmail" type="email" placeholder={primaryClient?.email ?? "client@example.com"} className={inputClass} />
                  </label>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 text-sm font-medium">
                    Source
                    <select name="sourceId" defaultValue="" className={inputClass}>
                      <option value="">General project context</option>
                      {data.sources.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    Scheduled for
                    <input name="scheduledFor" type="datetime-local" className={inputClass} />
                  </label>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-[var(--ink-3)]">Saved drafts are visible to Studio, project context, REST endpoints, and MCP tools.</p>
                  <button className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 text-sm transition">
                    <Send className="h-4 w-4" />
                    Save communication
                  </button>
                </div>
              </form>
            </details>

            {meetingNotesEnabled && linkableBookings.length > 0 && (
              <details className="group mt-3 rounded-md border border-[var(--line)] bg-[var(--paper-2)]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold transition hover:bg-white">
                  <span className="inline-flex items-center gap-2">
                    <NotebookPen className="h-4 w-4" />
                    Meeting note
                  </span>
                  <span className="text-xs uppercase tracking-[0.12em] text-[var(--ink-3)] group-open:hidden">Open</span>
                  <span className="hidden text-xs uppercase tracking-[0.12em] text-[var(--ink-3)] group-open:inline">Close</span>
                </summary>
                <form action={`/api/projects/${data.project.id}/communications`} method="post" className="grid gap-3 border-t border-[var(--line)] bg-white p-4">
                  <input type="hidden" name="channel" value="note" />
                  <input type="hidden" name="direction" value="internal" />
                  <label className="space-y-1.5 text-sm font-medium">
                    Meeting
                    <select name="bookingId" required defaultValue="" className={inputClass}>
                      <option value="" disabled>Select a meeting</option>
                      {linkableBookings.map((booking) => (
                        <option key={booking.id} value={booking.id}>
                          {booking.meetingName} · {formatDate(booking.startAt)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    Notes
                    <textarea name="body" required rows={8} defaultValue={MEETING_NOTE_TEMPLATE} className={inputClass} />
                  </label>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-[var(--ink-3)]">Saved as an internal record of this meeting — not sent to the client.</p>
                    <button className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 text-sm transition">
                      <NotebookPen className="h-4 w-4" />
                      Save meeting note
                    </button>
                  </div>
                </form>
              </details>
            )}

            <div className="mt-5 divide-y divide-[var(--line-soft)] rounded-md border border-[var(--line)]">
              {data.communications.map((communication) => (
                <div key={communication.id} className="p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        {communication.direction === "inbound" ? (
                          <span className="inline-flex items-center gap-1 rounded-sm bg-[var(--paper-2)] px-1.5 py-0.5 text-[0.62rem] font-semibold text-[var(--ink-2)]">
                            <ArrowDownLeft className="h-3 w-3" /> Received
                          </span>
                        ) : communication.direction === "outbound" ? (
                          <span className="inline-flex items-center gap-1 rounded-sm bg-[var(--paper-2)] px-1.5 py-0.5 text-[0.62rem] font-semibold text-[var(--ink-2)]">
                            <ArrowUpRight className="h-3 w-3" /> Outbound
                          </span>
                        ) : null}
                        <span className="inline-flex items-center gap-1 text-xs capitalize text-[var(--ink-3)]">
                          {communication.channel === "email" ? (
                            <Mail className="h-3.5 w-3.5" />
                          ) : communication.channel === "sms" ? (
                            <MessageSquare className="h-3.5 w-3.5" />
                          ) : null}
                          {communication.channel}
                        </span>
                        <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">{communicationStatusLabels[communication.status] ?? communication.status}</span>
                        <span className="text-xs text-[var(--ink-3)]">Created by {communication.createdBy ?? "Studio"}</span>
                      </div>
                      <div className="mt-2 font-semibold">{communication.subject || "Untitled communication"}</div>
                      <p className="mt-1 text-sm text-[var(--ink-3)]">
                        {[communication.recipientName, communication.recipientEmail].filter(Boolean).join(" · ") || "No recipient saved"}
                      </p>
                      <p className="mt-3 line-clamp-4 whitespace-pre-line text-sm leading-6 text-[var(--ink-2)]">{communication.body}</p>
                      <div className="mt-3 flex flex-wrap gap-3 text-xs text-[var(--ink-3)]">
                        {communication.sentAt && <span>Sent {new Date(communication.sentAt).toLocaleString()}</span>}
                        {communication.scheduledFor && <span>Scheduled {new Date(communication.scheduledFor).toLocaleString()}</span>}
                        {communication.channel === "sms" && communication.deliveryStatus && (
                          <span>Twilio status: {communication.deliveryStatus}</span>
                        )}
                        {communication.channel === "email" && communication.deliveryStatus && (
                          <span>Delivery: {communication.deliveryStatus}</span>
                        )}
                        {communication.channel === "email" && communication.providerMessageId && (
                          <span>Resend id: {communication.providerMessageId}</span>
                        )}
                        {taskSourceLabel(communication.sourceType, communication.sourceId, data.sources) && (
                          <span>Source: {taskSourceLabel(communication.sourceType, communication.sourceId, data.sources)}</span>
                        )}
                        {meetingNotesEnabled && communication.bookingId && bookingsById.get(communication.bookingId) && (
                          <span>
                            Meeting:{" "}
                            <Link href={`/scheduler/bookings/${communication.bookingId}`} className="underline">
                              {bookingsById.get(communication.bookingId)!.meetingName} · {formatDate(bookingsById.get(communication.bookingId)!.startAt)}
                            </Link>
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Neither SMS nor email is "mark sent" — both must go through
                        their real, gated send action (Twilio / Resend) below.
                        "Log as sent (no send)" stays available ONLY for call/note
                        rows, where "sent" only ever meant "logged as sent", not
                        "we contacted them" (a false-success write for a real
                        channel). An email genuinely sent elsewhere can still be
                        logged via the edit form's status field. */}
                    {communication.status !== "sent" &&
                      (communication.channel === "call" || communication.channel === "note") && (
                      <form action={`/api/projects/${data.project.id}/communications`} method="post">
                        <input type="hidden" name="communicationId" value={communication.id} />
                        <input type="hidden" name="direction" value={communication.direction} />
                        <input type="hidden" name="channel" value={communication.channel} />
                        <input type="hidden" name="status" value="sent" />
                        <input type="hidden" name="subject" value={communication.subject ?? ""} />
                        <input type="hidden" name="body" value={communication.body} />
                        <input type="hidden" name="recipientName" value={communication.recipientName ?? ""} />
                        <input type="hidden" name="recipientEmail" value={communication.recipientEmail ?? ""} />
                        <input type="hidden" name="sentAt" value={new Date().toISOString()} />
                        <button className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                          <CheckCircle2 className="h-4 w-4" />
                          Log as sent (no send)
                        </button>
                      </form>
                    )}
                  </div>

                  {communication.channel === "sms" && communication.status === "draft" && communication.direction === "outbound" && (() => {
                    const consent = smsConsentByCommunicationId.get(communication.id) ?? { ok: false, reason: "no_client" as const };
                    const canSend = consent.ok && smsSendingEnabled;
                    return (
                      <form
                        action={`/api/projects/${data.project.id}/communications/send-sms`}
                        method="post"
                        className="mt-3 flex flex-col gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="text-xs">
                          <span className={consent.ok ? "font-semibold text-[var(--accent-strong)]" : "font-semibold text-[var(--danger)]"}>
                            {smsConsentReasonLabels[consent.reason]}
                          </span>
                          {consent.ok && !smsSendingEnabled && (
                            <span className="ml-2 text-[var(--ink-3)]">SMS sending is currently disabled.</span>
                          )}
                        </div>
                        <input type="hidden" name="communicationId" value={communication.id} />
                        <input type="hidden" name="approvedBodyHash" value={sha256Hex(communication.body)} />
                        <button
                          type="submit"
                          disabled={!canSend}
                          className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Send className="h-4 w-4" />
                          Send SMS
                        </button>
                      </form>
                    );
                  })()}

                  {communication.channel === "email" && communication.status === "draft" && communication.direction === "outbound" && (() => {
                    const check = emailSendByCommunicationId.get(communication.id) ?? { recipient: null, suppressed: false, approvedBodyHash: null };
                    const canSend = Boolean(check.recipient) && !check.suppressed && emailSendEnabled && Boolean(check.approvedBodyHash);
                    const label = !check.recipient
                      ? "No resolvable recipient for this email"
                      : check.suppressed
                        ? "Recipient is suppressed — will not send"
                        : `Ready to send to ${check.recipient}`;
                    return (
                      <form
                        action={`/api/projects/${data.project.id}/communications/send-email`}
                        method="post"
                        className="mt-3 flex flex-col gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="text-xs">
                          <span className={canSend ? "font-semibold text-[var(--accent-strong)]" : "font-semibold text-[var(--danger)]"}>
                            {label}
                          </span>
                          {Boolean(check.recipient) && !check.suppressed && !emailSendEnabled && (
                            <span className="ml-2 text-[var(--ink-3)]">Email sending is currently disabled.</span>
                          )}
                        </div>
                        <input type="hidden" name="communicationId" value={communication.id} />
                        <input type="hidden" name="approvedBodyHash" value={check.approvedBodyHash ?? ""} />
                        <button
                          type="submit"
                          disabled={!canSend}
                          className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Mail className="h-4 w-4" />
                          Send email
                        </button>
                      </form>
                    );
                  })()}

                  <details className="mt-4 rounded-md border border-[var(--line)] bg-[var(--paper-2)]">
                    <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-semibold">
                      <span className="inline-flex items-center gap-2">
                        <Pencil className="h-3.5 w-3.5" />
                        Edit communication
                      </span>
                      <span className="text-xs font-medium text-[var(--ink-3)]">Same canonical record</span>
                    </summary>
                    <form action={`/api/projects/${data.project.id}/communications`} method="post" className="grid gap-3 border-t border-[var(--line)] bg-white p-3 md:grid-cols-2">
                      <input type="hidden" name="communicationId" value={communication.id} />
                      <label className="space-y-1.5 text-sm font-medium">
                        Direction
                        <select name="direction" defaultValue={communication.direction} className={inputClass}>
                          <option value="outbound">Outbound</option>
                          <option value="inbound">Inbound</option>
                          <option value="internal">Internal</option>
                        </select>
                      </label>
                      <label className="space-y-1.5 text-sm font-medium">
                        Channel
                        <select name="channel" defaultValue={communication.channel} className={inputClass}>
                          <option value="email">Email</option>
                          <option value="sms">SMS</option>
                          <option value="call">Call</option>
                          <option value="note">Note</option>
                        </select>
                      </label>
                      <label className="space-y-1.5 text-sm font-medium">
                        Status
                        <select name="status" defaultValue={communication.status} className={inputClass}>
                          <option value="draft">Draft</option>
                          <option value="queued">Queued</option>
                          <option value="sent">Sent</option>
                          <option value="archived">Archived</option>
                        </select>
                      </label>
                      <label className="space-y-1.5 text-sm font-medium">
                        Sent at
                        <input name="sentAt" type="datetime-local" defaultValue={datetimeLocalValue(communication.sentAt)} className={inputClass} />
                      </label>
                      <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                        Subject
                        <input name="subject" defaultValue={communication.subject ?? ""} className={inputClass} />
                      </label>
                      <label className="space-y-1.5 text-sm font-medium">
                        Recipient name
                        <input name="recipientName" defaultValue={communication.recipientName ?? ""} className={inputClass} />
                      </label>
                      <label className="space-y-1.5 text-sm font-medium">
                        Recipient email
                        <input name="recipientEmail" type="email" defaultValue={communication.recipientEmail ?? ""} className={inputClass} />
                      </label>
                      <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                        Message
                        <textarea name="body" required rows={5} defaultValue={communication.body} className={inputClass} />
                      </label>
                      <label className="space-y-1.5 text-sm font-medium">
                        Scheduled for
                        <input name="scheduledFor" type="datetime-local" defaultValue={datetimeLocalValue(communication.scheduledFor)} className={inputClass} />
                      </label>
                      <div className="flex items-end">
                        <button className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 text-sm transition">
                          <Pencil className="h-4 w-4" />
                          Save changes
                        </button>
                      </div>
                    </form>
                  </details>
                </div>
              ))}
              {!data.communications.length && (
                <p className="p-4 text-sm text-[var(--ink-3)]">
                  No communication records yet. Draft follow-ups here or let the Studio agent create them from discovery calls and planning sources.
                </p>
              )}
            </div>
          </section>

          <section id="sources" className="studio-section-card">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <div className="flex items-center gap-2">
                  <NotebookPen className="h-4 w-4 text-[var(--ink-3)]" />
                  <h2 className="studio-serif text-3xl">Project sources</h2>
                </div>
                <p className="mt-1 text-sm text-[var(--ink-3)]">
                  Evidence the Studio can cite: discovery calls, questionnaires, transcripts, import summaries, and planning notes.
                </p>
              </div>
              <span className="studio-chip">{data.sources.length} sources</span>
            </div>

            <details className="group mt-5 rounded-md border border-[var(--line)] bg-[var(--paper-2)]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold transition hover:bg-white">
                <span className="inline-flex items-center gap-2">
                  <NotebookPen className="h-4 w-4" />
                  Add source
                </span>
                <span className="text-xs uppercase tracking-[0.12em] text-[var(--ink-3)] group-open:hidden">Open</span>
                <span className="hidden text-xs uppercase tracking-[0.12em] text-[var(--ink-3)] group-open:inline">Close</span>
              </summary>
              <form action={`/api/projects/${data.project.id}/sources`} method="post" className="grid gap-3 border-t border-[var(--line)] bg-white p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 text-sm font-medium">
                    Source kind
                    <select name="kind" defaultValue="discovery_call" className={inputClass}>
                      <option value="discovery_call">Discovery call</option>
                      <option value="planning_note">Planning note</option>
                      <option value="questionnaire_notes">Questionnaire notes</option>
                      <option value="receipt_upload">Receipt upload</option>
                      <option value="note">Note</option>
                    </select>
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    Occurred at
                    <input name="occurredAt" type="datetime-local" className={inputClass} />
                  </label>
                </div>
                <label className="space-y-1.5 text-sm font-medium">
                  Title
                  <input name="title" required placeholder="Discovery call with Alex and Jordan" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Summary
                  <input name="summary" placeholder="Notes for proposal and timeline drafting" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Source body
                  <textarea name="body" required rows={6} placeholder="Paste transcript, call notes, planning context, or extracted source material." className={inputClass} />
                </label>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="space-y-1.5 text-sm font-medium sm:col-span-2">
                    External URL
                    <input name="externalUrl" type="url" placeholder="https://..." className={inputClass} />
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    Source ID
                    <input name="sourceId" placeholder="call-123" className={inputClass} />
                  </label>
                </div>
                <input type="hidden" name="sourceType" value="studio_project" />
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-[var(--ink-3)]">
                    Adding a source does not change the project by itself. It gives Studio and agent tools exact context to cite.
                  </p>
                  <button className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 text-sm transition">
                    <NotebookPen className="h-4 w-4" />
                    Save source
                  </button>
                </div>
              </form>
            </details>

            <div className="mt-5 divide-y divide-[var(--line-soft)] rounded-md border border-[var(--line)]">
              {data.sources.map((source) => (
                <div key={source.id} className="p-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">{source.kind.replaceAll("_", " ")}</span>
                        {source.occurredAt && <span className="text-xs text-[var(--ink-3)]">{formatDate(source.occurredAt)}</span>}
                      </div>
                      <div className="mt-2 font-semibold">{source.title}</div>
                      {source.summary && <p className="mt-1 text-sm text-[var(--ink-2)]">{source.summary}</p>}
                    </div>
                    {source.externalUrl && (
                      <a href={source.externalUrl} target="_blank" className="inline-flex items-center gap-1.5 text-sm font-semibold underline">
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open
                      </a>
                    )}
                  </div>
                  <p className="mt-3 line-clamp-4 whitespace-pre-line text-sm leading-6 text-[var(--ink-3)]">{source.body}</p>
                  <div className="studio-caps mt-3 text-[0.52rem] text-[var(--ink-3)]">
                    Source: {source.sourceType ?? "studio_project"}{source.sourceId ? ` · ${source.sourceId}` : ""}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <form action={`/api/projects/${data.project.id}/agent-tasks`} method="post">
                      <input type="hidden" name="title" value={`Create proposal from ${source.title}`} />
                      <input
                        type="hidden"
                        name="instructions"
                        value="Use this saved project source as the canonical discovery context. Draft the proposal package, scope summary, contract-ready notes, assumptions, missing details, and recommended invoice schedule. Cite the source on every generated output."
                      />
                      <input type="hidden" name="priority" value="high" />
                      <input type="hidden" name="assignedAgent" value="Proposal Agent" />
                      <input type="hidden" name="projectSourceId" value={source.id} />
                      <button className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-xs font-semibold transition hover:border-[var(--foreground)]">
                        <FileSignature className="h-3.5 w-3.5" />
                        Create proposal task
                      </button>
                    </form>
                    <form action={`/api/projects/${data.project.id}/agent-tasks`} method="post">
                      <input type="hidden" name="title" value={`Create timeline from ${source.title}`} />
                      <input
                        type="hidden"
                        name="instructions"
                        value="Use this saved project source as the canonical planning context. Draft a wedding-day timeline with assumptions, missing details, key logistics, and next-step questions. Cite the source on every generated timeline item."
                      />
                      <input type="hidden" name="priority" value="high" />
                      <input type="hidden" name="assignedAgent" value="Timeline Agent" />
                      <input type="hidden" name="projectSourceId" value={source.id} />
                      <input type="hidden" name="runTimelineDraft" value="1" />
                      <button className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-xs font-semibold transition hover:border-[var(--foreground)]">
                        <CalendarCheck className="h-3.5 w-3.5" />
                        Create timeline draft
                      </button>
                    </form>
                    <form action={`/api/projects/${data.project.id}/agent-tasks`} method="post">
                      <input type="hidden" name="title" value={`Create invoice from ${source.title}`} />
                      <input
                        type="hidden"
                        name="instructions"
                        value="Use this saved project source as canonical billing context. Inspect the project proposal, payment settings, client-paid fee policy, and existing invoices before drafting or creating the invoice. Cite the source on every generated invoice or payment schedule row."
                      />
                      <input type="hidden" name="priority" value="high" />
                      <input type="hidden" name="assignedAgent" value="Billing Agent" />
                      <input type="hidden" name="projectSourceId" value={source.id} />
                      <button className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-xs font-semibold transition hover:border-[var(--foreground)]">
                        <ReceiptText className="h-3.5 w-3.5" />
                        Create invoice task
                      </button>
                    </form>
                    <form action={`/api/projects/${data.project.id}/agent-tasks`} method="post">
                      <input type="hidden" name="title" value={`Create expense from ${source.title}`} />
                      <input
                        type="hidden"
                        name="instructions"
                        value="Use this saved project source as canonical bookkeeping context. Extract vendor, category, description, amount, paid date, payment method, receipt URL, tax-deductible status, and source evidence before creating or updating the expense. Cite the source on every generated expense row."
                      />
                      <input type="hidden" name="priority" value="high" />
                      <input type="hidden" name="assignedAgent" value="Bookkeeping Agent" />
                      <input type="hidden" name="projectSourceId" value={source.id} />
                      <button className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-xs font-semibold transition hover:border-[var(--foreground)]">
                        <ReceiptText className="h-3.5 w-3.5" />
                        Create expense task
                      </button>
                    </form>
                    <form action={`/api/projects/${data.project.id}/agent-tasks`} method="post">
                      <input type="hidden" name="title" value={`Create follow-up from ${source.title}`} />
                      <input
                        type="hidden"
                        name="instructions"
                        value="Use this saved project source as canonical client-communication context. Draft the next client follow-up with a recommended channel, subject or SMS opener, body copy, action items, approval notes, and any missing details. Cite the source on every generated communication record."
                      />
                      <input type="hidden" name="priority" value="high" />
                      <input type="hidden" name="assignedAgent" value="Communications Agent" />
                      <input type="hidden" name="projectSourceId" value={source.id} />
                      <button className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-xs font-semibold transition hover:border-[var(--foreground)]">
                        <Mail className="h-3.5 w-3.5" />
                        Create follow-up task
                      </button>
                    </form>
                  </div>
                </div>
              ))}
              {!data.sources.length && (
                <p className="p-4 text-sm text-[var(--ink-3)]">
                  No manual sources yet. Add discovery-call notes or transcripts when you want proposals, timelines, or follow-ups grounded in exact context.
                </p>
              )}
            </div>
          </section>

          <section id="agent-tasks" className="studio-section-card">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-[var(--ink-3)]" />
                  <h2 className="studio-serif text-3xl">Agent tasks</h2>
                </div>
                <p className="mt-1 text-sm text-[var(--ink-3)]">
                  Queue reviewable work for the agent using this project, its sources, questionnaire answers, and financial records as context.
                </p>
              </div>
              <Link href="/inbox" prefetch={false} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                Open Inbox
                <ExternalLink className="h-4 w-4" />
              </Link>
            </div>

            <details className="group mt-5 rounded-md border border-[var(--line)] bg-[var(--paper-2)]" open={saved === "agent-task" ? undefined : undefined}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold transition hover:bg-white">
                <span className="inline-flex items-center gap-2">
                  <Sparkles className="h-4 w-4" />
                  Assign agent task
                </span>
                <span className="text-xs uppercase tracking-[0.12em] text-[var(--ink-3)] group-open:hidden">Open</span>
                <span className="hidden text-xs uppercase tracking-[0.12em] text-[var(--ink-3)] group-open:inline">Close</span>
              </summary>
              <form action={`/api/projects/${data.project.id}/agent-tasks`} method="post" className="grid gap-3 border-t border-[var(--line)] bg-white p-4">
                <label className="space-y-1.5 text-sm font-medium">
                  Task
                  <input name="title" required placeholder="Create a wedding day timeline" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Instructions
                  <textarea
                    name="instructions"
                    rows={5}
                    placeholder="Use the discovery call, questionnaire responses, project events, proposal, and notes. Return assumptions and missing details."
                    className={inputClass}
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 text-sm font-medium">
                    Priority
                    <select name="priority" defaultValue="normal" className={inputClass}>
                      <option value="low">Low</option>
                      <option value="normal">Normal</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </label>
                  <label className="space-y-1.5 text-sm font-medium">
                    Agent
                    <input name="assignedAgent" defaultValue="The Reeses Studio Agent" className={inputClass} />
                  </label>
                </div>
                <label className="space-y-1.5 text-sm font-medium">
                  Source
                  <select name="projectSourceId" defaultValue="" className={inputClass}>
                    <option value="">Use general project context</option>
                    {data.sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.title}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-[var(--ink-3)]">
                    Tasks land in the Inbox. They do not send messages, publish timelines, or change invoices until their output is saved or approved.
                  </p>
                  <button className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 text-sm transition">
                    <Bot className="h-4 w-4" />
                    Assign task
                  </button>
                </div>
              </form>
            </details>

            <div className="mt-5 divide-y divide-[var(--line-soft)] rounded-md border border-[var(--line)]">
              {agentTasks.map((task) => (
                <div key={task.id} className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-start">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="studio-caps text-[0.58rem] text-[var(--ink-3)]">{agentTaskStatusLabels[task.status] ?? task.status}</span>
                      <span className="text-xs text-[var(--ink-3)]">{task.priority}</span>
                    </div>
                    <div className="mt-2 font-semibold">{task.title}</div>
                    {task.instructions && <p className="mt-1 line-clamp-2 text-sm text-[var(--ink-2)]">{task.instructions}</p>}
                    {task.resultSummary && <p className="mt-2 text-sm text-[var(--brand-brown)]">{task.resultSummary}</p>}
                    {taskSourceLabel(task.sourceType, task.sourceId, data.sources) && (
                      <div className="studio-caps mt-2 text-[0.52rem] text-[var(--ink-3)]">
                        Source: {taskSourceLabel(task.sourceType, task.sourceId, data.sources)}
                      </div>
                    )}
                    {task.errorMessage && <p className="mt-2 text-sm text-[var(--danger)]">{task.errorMessage}</p>}
                    {taskTimelineDraft(task.outputJson) && (
                      <div className="mt-3 rounded-md border border-[var(--line)] bg-white p-3">
                        <div className="studio-caps text-[0.55rem] text-[var(--ink-3)]">Timeline draft</div>
                        <div className="mt-2 grid gap-3 text-sm md:grid-cols-3">
                          <div>
                            <div className="font-semibold">{taskTimelineDraft(task.outputJson)?.timelineItems?.length ?? 0} timeline items</div>
                            <ul className="mt-1 space-y-1 text-[var(--ink-2)]">
                              {(taskTimelineDraft(task.outputJson)?.timelineItems ?? []).slice(0, 4).map((item, index) => (
                                <li key={`${item.title}-${index}`}>{item.startAt ? `${item.startAt} - ` : ""}{item.title}</li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <div className="font-semibold">{taskTimelineDraft(task.outputJson)?.familyFormals?.length ?? 0} family groups</div>
                            <ul className="mt-1 space-y-1 text-[var(--ink-2)]">
                              {(taskTimelineDraft(task.outputJson)?.familyFormals ?? []).slice(0, 4).map((group, index) => (
                                <li key={`${group.groupName}-${index}`}>{group.groupName} ({group.people?.length ?? 0})</li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <div className="font-semibold">{taskTimelineDraft(task.outputJson)?.openQuestions?.length ?? 0} review questions</div>
                            <ul className="mt-1 space-y-1 text-[var(--ink-2)]">
                              {(taskTimelineDraft(task.outputJson)?.openQuestions ?? []).slice(0, 3).map((question, index) => (
                                <li key={`${question}-${index}`}>{question}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                        {autofillReviewOn && (
                          <div className="mt-3 border-t border-[var(--line)] pt-3">
                            {applyConfirm === task.id ? (
                              <div className="space-y-2">
                                <p className="text-sm text-[var(--danger)]">
                                  {applyConfirmCount ?? "Some"} hand-edited timeline item{applyConfirmCount === "1" ? "" : "s"} would be
                                  overwritten by this re-apply — confirm to replace the draft-sourced items.
                                </p>
                                <form action={`/api/projects/${data.project.id}/timeline-draft/apply`} method="post">
                                  <input type="hidden" name="taskId" value={task.id} />
                                  <input type="hidden" name="confirmReplace" value="1" />
                                  <input type="hidden" name="draftVersion" value={timelineDraftVersion(task.outputJson)} />
                                  <button className="inline-flex items-center gap-2 rounded-sm border border-[var(--danger)] px-3 py-2 text-sm font-semibold text-[var(--danger)] transition hover:bg-[#fdf1f1]">
                                    Confirm replace draft-sourced items
                                  </button>
                                </form>
                              </div>
                            ) : (
                              <form action={`/api/projects/${data.project.id}/timeline-draft/apply`} method="post">
                                <input type="hidden" name="taskId" value={task.id} />
                                <input type="hidden" name="draftVersion" value={timelineDraftVersion(task.outputJson)} />
                                <button className="brand-primary-button inline-flex items-center gap-2 rounded-sm px-3 py-2 text-sm">
                                  Apply timeline draft
                                </button>
                                <p className="mt-1 text-xs text-[var(--ink-3)]">Re-applying replaces the draft-sourced timeline items.</p>
                              </form>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-start gap-2 text-xs text-[var(--ink-3)] sm:items-end">
                    <span>{new Date(task.createdAt).toLocaleDateString()}</span>
                    {task.status !== "completed" && (
                      <form action={`/api/projects/${data.project.id}/agent-tasks`} method="post">
                        <input type="hidden" name="taskId" value={task.id} />
                        <input type="hidden" name="status" value="completed" />
                        <input type="hidden" name="resultSummary" value={task.resultSummary ?? "Marked complete in The Reeses Studio."} />
                        <button className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--foreground)]">
                          <CheckCircle2 className="h-4 w-4" />
                          Complete
                        </button>
                      </form>
                    )}
                  </div>
                  <details className="sm:col-span-2 rounded-md border border-[var(--line)] bg-[var(--paper-2)]">
                    <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-semibold">
                      <span className="inline-flex items-center gap-2">
                        <Pencil className="h-3.5 w-3.5" />
                        Edit task state
                      </span>
                      <span className="text-xs font-medium text-[var(--ink-3)]">Shared with Inbox and MCP</span>
                    </summary>
                    <form action={`/api/projects/${data.project.id}/agent-tasks`} method="post" className="grid gap-3 border-t border-[var(--line)] bg-white p-3 md:grid-cols-2">
                      <input type="hidden" name="taskId" value={task.id} />
                      <label className="space-y-1.5 text-sm font-medium">
                        Status
                        <select name="status" defaultValue={task.status} className={inputClass}>
                          <option value="queued">Queued</option>
                          <option value="in_progress">In progress</option>
                          <option value="completed">Completed</option>
                          <option value="failed">Failed</option>
                          <option value="cancelled">Cancelled</option>
                        </select>
                      </label>
                      <label className="space-y-1.5 text-sm font-medium">
                        Error message
                        <input name="errorMessage" defaultValue={task.errorMessage ?? ""} placeholder="Why failed or blocked" className={inputClass} />
                      </label>
                      <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                        Result summary
                        <textarea name="resultSummary" rows={3} defaultValue={task.resultSummary ?? ""} placeholder="What the agent produced, what Tyler reviewed, or what needs attention." className={inputClass} />
                      </label>
                      <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                        Output JSON
                        <textarea name="outputJson" rows={4} defaultValue={task.outputJson ?? ""} placeholder='{"proposalId":"...", "timelineId":"..."}' className={inputClass} />
                      </label>
                      <div className="md:col-span-2">
                        <button className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 text-sm transition">
                          <Pencil className="h-4 w-4" />
                          Save task state
                        </button>
                      </div>
                    </form>
                  </details>
                </div>
              ))}
              {!agentTasks.length && (
                <p className="p-4 text-sm text-[var(--ink-3)]">
                  No agent tasks yet. Assign timeline, proposal, invoice, or research work from here.
                </p>
              )}
            </div>
          </section>

          <section id="calendar" className="studio-section-card">
            <details className="group">
              <summary className="list-none cursor-pointer">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div>
                    <h2 className="text-lg font-semibold">Calendar dates</h2>
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">
                      Dates that belong on the calendar: wedding day, engagement session, welcome party, rehearsal, brunch, and other scheduled events.
                    </p>
                  </div>
                  <span className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition group-open:border-[var(--foreground)] hover:border-[var(--foreground)]">
                    <CalendarPlus className="h-4 w-4" />
                    Add event
                  </span>
                </div>
              </summary>
              <form action={`/api/projects/${data.project.id}/events`} method="post" className="mt-4 grid gap-3 rounded-md border border-dashed border-[var(--line)] bg-[#fbfaf7] p-4 md:grid-cols-2">
                <input type="hidden" name="projectId" value={data.project.id} />
                <label className="space-y-1.5 text-sm font-medium">
                  Event title
                  <input name="title" required placeholder="Engagement session" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Event date
                  <input name="eventDate" type="date" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Type
                  <select name="type" className={inputClass} defaultValue="engagement">
                    <option value="engagement">Engagement</option>
                    <option value="wedding">Wedding</option>
                    <option value="rehearsal">Rehearsal / Welcome party</option>
                    <option value="portrait">Portrait</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Custom type
                  <input name="customType" placeholder="After party, brunch, etc." className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Venue
                  <input name="venueName" placeholder="Location name" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                  Address
                  <input name="venueAddress" placeholder="Full address for Google Maps" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  City
                  <input name="city" placeholder="Beacon" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  State
                  <input name="state" placeholder="NY" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                  Notes
                  <textarea name="notes" rows={3} className={inputClass} />
                </label>
                <div className="md:col-span-2">
                  <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Add event</button>
                  <p className="mt-2 text-xs text-[var(--ink-muted)]">After adding a project event, sync it from the event card above.</p>
                </div>
              </form>
            </details>
            <div className="mt-4 space-y-3">
              {data.events.map((event) => {
                const eventMapsUrl = mapsUrl(event.venueAddress, event.venueName, event.city, event.state);
                return (
                  <div key={event.id} className="rounded-md border border-[var(--line)] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold">{event.title}</div>
                        <div className="mt-1 text-xs capitalize text-[var(--ink-muted)]">{event.type.replaceAll("_", " ")} · {formatDate(event.eventDate)}</div>
                        <div className="mt-2 text-sm">{event.venueName || "Venue TBD"}</div>
                        {event.notes && (
                          <p className="mt-2 line-clamp-4 whitespace-pre-line text-sm leading-6 text-[var(--ink-muted)]">{event.notes}</p>
                        )}
                        {eventMapsUrl && (
                          <a href={eventMapsUrl} target="_blank" className="mt-1 inline-flex items-center gap-1 text-xs font-semibold underline">
                            <MapPin className="h-3 w-3" />
                            Open map
                          </a>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2 text-right text-xs capitalize text-[var(--ink-muted)]">
                        <span>{event.calendarSyncStatus.replaceAll("_", " ")}</span>
                        {event.googleCalendarEventId && event.calendarSyncStatus === "synced" ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] px-2.5 py-1 text-xs normal-case text-[var(--accent-strong)]">
                            <CalendarCheck className="h-3.5 w-3.5" />
                            Synced
                          </span>
                        ) : event.eventDate ? (
                          <form action={`/api/projects/${data.project.id}/calendar`} method="post">
                            <input type="hidden" name="eventId" value={event.id} />
                            <button className="inline-flex items-center gap-1 rounded-sm border border-[var(--line)] px-2.5 py-1 text-xs font-semibold normal-case transition hover:border-[var(--foreground)]">
                              <CalendarPlus className="h-3.5 w-3.5" />
                              Sync
                            </button>
                          </form>
                        ) : (
                          <span className="normal-case">Add date first</span>
                        )}
                      </div>
                    </div>
                    <details className="mt-3 rounded-md border border-[var(--line)] bg-[#fbfaf7]">
                      <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-semibold">
                        <span className="inline-flex items-center gap-2">
                          <Pencil className="h-3.5 w-3.5" />
                          Edit event
                        </span>
                        <span className="text-xs font-medium text-[var(--ink-muted)]">Date, venue, notes, and calendar sync</span>
                      </summary>
                      <form action={`/api/projects/${data.project.id}/events/${event.id}`} method="post" className="grid gap-3 border-t border-[var(--line)] p-3 md:grid-cols-2">
                        <input type="hidden" name="projectId" value={data.project.id} />
                        <input type="hidden" name="eventId" value={event.id} />
                        <label className="space-y-1.5 text-sm font-medium">
                          Event title
                          <input name="title" required defaultValue={event.title} className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          Event date
                          <input name="eventDate" type="date" defaultValue={event.eventDate ?? ""} className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          Type
                          <select name="type" className={inputClass} defaultValue={projectEventTypeValue(event.type)}>
                            <option value="engagement">Engagement</option>
                            <option value="wedding">Wedding</option>
                            <option value="rehearsal">Rehearsal / Welcome party</option>
                            <option value="portrait">Portrait</option>
                            <option value="other">Other</option>
                          </select>
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          Custom type
                          <input name="customType" defaultValue={customProjectEventTypeValue(event.type)} placeholder="After party, brunch, etc." className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          Venue
                          <input name="venueName" defaultValue={event.venueName ?? ""} placeholder="Location name" className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          City
                          <input name="city" defaultValue={event.city ?? ""} placeholder="Chatham" className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                          Address
                          <input name="venueAddress" defaultValue={event.venueAddress ?? ""} placeholder="Full address for Google Maps" className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          State
                          <input name="state" defaultValue={event.state ?? ""} placeholder="MA" className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                          Notes
                          <textarea name="notes" rows={3} defaultValue={event.notes ?? ""} className={inputClass} />
                        </label>
                        <div className="md:col-span-2">
                          <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Save event</button>
                        </div>
                      </form>
                    </details>
                  </div>
                );
              })}
              {!data.events.length && <p className="text-sm text-[var(--ink-muted)]">No calendar dates yet.</p>}
            </div>
          </section>

          <section id="locations" className="studio-section-card">
            <details className="group">
              <summary className="list-none cursor-pointer">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div>
                    <h2 className="text-lg font-semibold">Locations & logistics</h2>
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">
                      Places for the day: getting ready, ceremony, portraits, reception, parking, load-in, rain plans, and other stops.
                    </p>
                  </div>
                  <span className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition group-open:border-[var(--foreground)] hover:border-[var(--foreground)]">
                    <MapPin className="h-4 w-4" />
                    Add location
                  </span>
                </div>
              </summary>
              <form action={`/api/projects/${data.project.id}/locations`} method="post" className="mt-4 grid gap-3 rounded-md border border-dashed border-[var(--line)] bg-[#fbfaf7] p-4 md:grid-cols-2">
                <input type="hidden" name="projectId" value={data.project.id} />
                <label className="space-y-1.5 text-sm font-medium">
                  Location name
                  <input name="name" required placeholder="Bridal suite, ceremony lawn, reception tent" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Type
                  <select name="type" defaultValue="getting_ready" className={inputClass}>
                    <option value="getting_ready">Getting ready</option>
                    <option value="ceremony">Ceremony</option>
                    <option value="reception">Reception</option>
                    <option value="portrait">Portrait</option>
                    <option value="after_party">After party</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                  Address
                  <input name="address" placeholder="Full address for Google Maps" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  City
                  <input name="city" placeholder="Hudson" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  State
                  <input name="state" placeholder="NY" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                  Custom type
                  <input name="customType" placeholder="First look, welcome party, family portraits" className={inputClass} />
                </label>
                <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                  Notes
                  <textarea name="notes" rows={3} placeholder="Parking, permits, load-in, light, rain plan, point of contact." className={inputClass} />
                </label>
                <div className="md:col-span-2">
                  <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Add location</button>
                  <p className="mt-2 text-xs text-[var(--ink-muted)]">
                    Location records are shared by the project page, portal context, and MCP project context. Questionnaire answers can fill these in automatically.
                  </p>
                </div>
              </form>
            </details>
            <div className="mt-4 space-y-3">
              {data.locations.map((location) => {
                const locationMapsUrl = mapsUrl(location.address, location.name, location.city, location.state);
                return (
                  <div key={location.id} className="rounded-md border border-[var(--line)] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold">{location.name}</div>
                        <div className="mt-1 text-xs capitalize text-[var(--ink-muted)]">{location.type.replaceAll("_", " ")}</div>
                        <div className="mt-2 text-sm text-[var(--ink-muted)]">{[location.address, location.city, location.state].filter(Boolean).join(", ") || "Address not set"}</div>
                        {locationMapsUrl && (
                          <a href={locationMapsUrl} target="_blank" className="mt-1 inline-flex items-center gap-1 text-xs font-semibold underline">
                            <MapPin className="h-3 w-3" />
                            Open map
                          </a>
                        )}
                      </div>
                    </div>
                    <details className="mt-3 rounded-md border border-[var(--line)] bg-[#fbfaf7]">
                      <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-semibold">
                        <span className="inline-flex items-center gap-2">
                          <Pencil className="h-3.5 w-3.5" />
                          Edit location
                        </span>
                        <span className="text-xs font-medium text-[var(--ink-muted)]">Shared logistics record</span>
                      </summary>
                      <form action={`/api/projects/${data.project.id}/locations/${location.id}`} method="post" className="grid gap-3 border-t border-[var(--line)] p-3 md:grid-cols-2">
                        <input type="hidden" name="projectId" value={data.project.id} />
                        <input type="hidden" name="locationId" value={location.id} />
                        <label className="space-y-1.5 text-sm font-medium">
                          Location name
                          <input name="name" required defaultValue={location.name} className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          Type
                          <select name="type" defaultValue={projectLocationTypeValue(location.type)} className={inputClass}>
                            <option value="getting_ready">Getting ready</option>
                            <option value="ceremony">Ceremony</option>
                            <option value="reception">Reception</option>
                            <option value="portrait">Portrait</option>
                            <option value="after_party">After party</option>
                            <option value="other">Other</option>
                          </select>
                        </label>
                        <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                          Address
                          <input name="address" defaultValue={location.address ?? ""} placeholder="Full address for Google Maps" className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          City
                          <input name="city" defaultValue={location.city ?? ""} placeholder="Hudson" className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                          State
                          <input name="state" defaultValue={location.state ?? ""} placeholder="NY" className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                          Custom type
                          <input name="customType" defaultValue={customProjectLocationTypeValue(location.type)} placeholder="First look, welcome party, family portraits" className={inputClass} />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium md:col-span-2">
                          Notes
                          <textarea name="notes" rows={3} defaultValue={location.notes ?? ""} className={inputClass} />
                        </label>
                        <div className="md:col-span-2">
                          <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Save location</button>
                        </div>
                      </form>
                    </details>
                  </div>
                );
              })}
              {!data.locations.length && <p className="text-sm text-[var(--ink-muted)]">No locations or logistics records yet.</p>}
            </div>
          </section>

          <section id="galleries" className="studio-section-card">
            <details className="group">
              <summary className="list-none cursor-pointer">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div>
                    <h2 className="text-lg font-semibold">Galleries</h2>
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">
                      Provider delivery links (Pixieset, Pic-Time, Cloudinary, or other). Draft is admin/agent-only; set status to Delivered to make it client-visible in the portal once the gallery flag is on.
                    </p>
                  </div>
                  <span className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition group-open:border-[var(--foreground)] hover:border-[var(--foreground)]">
                    <Images className="h-4 w-4" />
                    Add gallery
                  </span>
                </div>
              </summary>
              <div className="mt-4">
                <ProjectGalleryForm projectId={data.project.id} />
              </div>
            </details>
            <div className="mt-4 space-y-3">
              {data.galleries.map((gallery) => (
                <div key={gallery.id} className="rounded-md border border-[var(--line)] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">{gallery.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
                        <span className="rounded-full border border-[var(--line)] px-2 py-0.5 font-semibold capitalize">{gallery.status}</span>
                        {gallery.provider && <span>{gallery.provider}</span>}
                        {gallery.expiresAt && <span>Available until {formatDate(gallery.expiresAt)}</span>}
                      </div>
                      {isGalleryUrlSafe(gallery.url) ? (
                        <a href={gallery.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold underline">
                          <ExternalLink className="h-3 w-3" />
                          Open gallery
                        </a>
                      ) : (
                        // Belt-and-suspenders (mirrors the portal shaper): a
                        // hand-edited D1 row with a non-https/script-scheme url
                        // must never become a clickable link in front of the
                        // higher-value admin session — render it as inert text.
                        <div className="mt-2 break-all text-xs text-[var(--danger)]">Unsafe gallery URL (not shown as a link): {gallery.url}</div>
                      )}
                    </div>
                    <ProjectGalleryDeleteForm projectId={data.project.id} galleryId={gallery.id} />
                  </div>
                  <details className="mt-3 rounded-md border border-[var(--line)] bg-[#fbfaf7]">
                    <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-semibold">
                      <span className="inline-flex items-center gap-2">
                        <Pencil className="h-3.5 w-3.5" />
                        Edit gallery
                      </span>
                    </summary>
                    <div className="border-t border-[var(--line)] p-3">
                      <ProjectGalleryForm projectId={data.project.id} gallery={gallery} />
                    </div>
                  </details>
                </div>
              ))}
              {!data.galleries.length && <p className="text-sm text-[var(--ink-muted)]">No galleries yet.</p>}
            </div>
          </section>

          <section id="portal" className="studio-section-card">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <h2 className="text-lg font-semibold">Client portal access</h2>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">
                  Secure project-scoped link for this client portal.
                </p>
              </div>
              {data.tokens.length > 0 && (
                <form action={`/api/projects/${data.project.id}/portal`} method="post">
                  <input type="hidden" name="projectId" value={data.project.id} />
                  <input type="hidden" name="clientId" value={primaryClient?.id ?? ""} />
                  <button className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                    <Send className="h-4 w-4" />
                    New link
                  </button>
                </form>
              )}
            </div>
            <div className="mt-4 space-y-3">
              {data.tokens.map((token) => (
                <div key={token.id} className="rounded-md border border-[var(--line)] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">{token.label ?? "Portal link"}</div>
                      <div className="mt-1 text-xs text-[var(--ink-muted)]">Expires {formatDate(token.expiresAt.slice(0, 10))}</div>
                      <div className="mt-1 text-xs text-[var(--ink-muted)]">{token.revokedAt ? "Revoked" : token.lastUsedAt ? `Last used ${formatDate(token.lastUsedAt.slice(0, 10))}` : "Not used yet"}</div>
                    </div>
                    {!token.revokedAt && (
                      <form action={`/api/projects/${data.project.id}/portal/${token.id}/revoke`} method="post">
                        <input type="hidden" name="projectId" value={data.project.id} />
                        <input type="hidden" name="tokenId" value={token.id} />
                        <button className="text-xs font-semibold text-[var(--danger)]">Revoke</button>
                      </form>
                    )}
                  </div>
                </div>
              ))}
              {!data.tokens.length && (
                <div className="rounded-md border border-dashed border-[var(--line)] p-4">
                  <p className="text-sm text-[var(--ink-muted)]">
                    No portal link has been created for this project yet.
                  </p>
                  <form action={`/api/projects/${data.project.id}/portal`} method="post" className="mt-3">
                    <input type="hidden" name="projectId" value={data.project.id} />
                    <input type="hidden" name="clientId" value={primaryClient?.id ?? ""} />
                    <button className="brand-primary-button inline-flex rounded-sm px-4 py-2.5 text-sm">
                      Create portal link
                    </button>
                  </form>
                </div>
              )}
            </div>
          </section>
        </div>

        <section id="activity" className="studio-section-card">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Activity</h2>
            <ExternalLink className="h-4 w-4 text-[var(--ink-muted)]" />
          </div>
          <div className="mt-4 divide-y divide-[var(--line)]">
            {data.activity.map((entry) => (
              <div key={entry.id} className="py-3 text-sm">
                <div className="font-semibold">{formatActivityAction(entry.action)}</div>
                <div className="mt-1 text-xs text-[var(--ink-muted)]">{new Date(entry.createdAt).toLocaleString()}</div>
              </div>
            ))}
            {!data.activity.length && <p className="py-3 text-sm text-[var(--ink-muted)]">No activity yet.</p>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
