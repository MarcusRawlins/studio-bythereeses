export function formatMoney(cents?: number | null) {
  if (cents === undefined || cents === null) return "Not set";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function formatDate(value?: string | null) {
  if (!value) return "Date TBD";
  const date = value.includes("T") ? new Date(value) : new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "Date TBD";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

const activityActionLabels: Record<string, string> = {
  "agent_task.claimed": "Agent task claimed",
  "agent_task.completed": "Agent task completed",
  "agent_task.created": "Agent task assigned",
  "agent_task.updated": "Agent task updated",
  "client.linked_to_project": "Client linked to project",
  "communication.created": "Communication created",
  "communication.updated": "Communication updated",
  "engagement.pending_added": "Engagement session needs scheduling",
  "engagement.scheduled": "Engagement session scheduled",
  "gallery.created": "Gallery link added",
  "gallery.updated": "Gallery link updated",
  "gallery.deleted": "Gallery link removed",
  "invoice.created": "Invoice created",
  "invoice.payment_updated": "Invoice payment updated",
  "invoice.payment_refunded_from_stripe": "Payment refunded (from Stripe)",
  "invoice.payment_dispute_opened_from_stripe": "Payment dispute opened (from Stripe)",
  "invoice.payment_dispute_closed_from_stripe": "Payment dispute closed (from Stripe)",
  "invoice.payment_dispute_funds_reinstated_from_stripe": "Dispute funds reinstated (from Stripe)",
  "invoice.reminder_logged": "Invoice reminder logged",
  "invoice.reminder_logged_by_agent": "Invoice reminder logged by agent",
  "invoice.status_updated": "Invoice status updated",
  "portal_token.created": "Portal link created",
  "portal_token.revoked": "Portal link revoked",
  "project.created": "Project created",
  "project.details_updated": "Project details updated",
  "project.event_added": "Project event added",
  "project.event_created": "Project event added",
  "project.event_updated": "Project event updated",
  "project.location_created": "Project location added",
  "project.location_created_by_agent": "Project location added by agent",
  "project.location_updated": "Project location updated",
  "project.location_updated_by_agent": "Project location updated by agent",
  "project.calendar_sync_failed": "Project calendar sync failed",
  "project.calendar_synced": "Project synced to calendar",
  "project_event.calendar_sync_failed": "Project event calendar sync failed",
  "project_event.calendar_synced": "Project event synced to calendar",
  "project.stage_changed": "Project stage updated",
  "project.stage_updated": "Project stage updated",
  "project.updated": "Project updated",
  "project_source.created": "Project source created",
  "project_source.updated": "Project source updated",
  "project_timeline.created": "Timeline item created",
  "project_timeline.updated": "Timeline item updated",
  "proposal.accepted": "Proposal accepted by client",
  "proposal.created": "Proposal created",
  "proposal.link_created": "Proposal link created",
  "proposal.signed": "Proposal signed by client",
  "proposal.updated": "Proposal updated",
  "proposal.viewed": "Client opened the proposal",
  "proposal.workflow_updated": "Proposal workflow updated",
  "questionnaire.created": "Questionnaire created",
  "questionnaire.response_created": "Questionnaire response created",
  "questionnaire.response_submitted": "Questionnaire submitted",
  "questionnaire.response_updated": "Questionnaire response updated",
  "questionnaire.updated": "Questionnaire updated",
  "scheduler.meeting_type_created": "Scheduler meeting type created",
  "scheduler.meeting_type_deleted": "Scheduler meeting type deleted",
  "scheduler.meeting_type_updated": "Scheduler meeting type updated",
  "scheduler_booking.cancelled": "Call cancelled",
  "scheduler_booking.created": "Call booked",
  "scheduler_booking.payment_updated": "Call payment updated",
  "scheduler_booking.rescheduled": "Call rescheduled",
  "template.created": "Template created",
  "template.deleted": "Template deleted",
  "template.updated": "Template updated",
};

export function formatActivityAction(action: string) {
  const trimmed = action.trim();
  const label = activityActionLabels[trimmed];
  if (label) return label;

  const words = trimmed
    .replaceAll(".", " ")
    .replaceAll("_", " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "Activity recorded";

  const sentence = words.join(" ").toLowerCase();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
