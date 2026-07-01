import type { DashboardActionKind } from "@/lib/dashboard";
import { formatDate } from "@/lib/format";

const actionKindLabels: Record<DashboardActionKind, string> = {
  engagement_session: "Scheduling",
  invoice_payment: "Payment",
  proposal_waiting: "Proposal",
  questionnaire_draft: "Questionnaire",
  inquiry_followup: "Inquiry",
};

export function dashboardActionHref(
  kind: DashboardActionKind,
  href: string,
  projectId: string | null,
) {
  if (!projectId) return href;

  const sectionByKind: Partial<Record<DashboardActionKind, string>> = {
    engagement_session: "events",
    invoice_payment: "finances",
    proposal_waiting: "sales",
    questionnaire_draft: "questionnaires",
    inquiry_followup: "communications",
  };

  const section = sectionByKind[kind];
  if (section) return `/projects/${projectId}#${section}`;
  return href;
}

export function DashboardActionContext({
  kind,
  detail,
  dueDate,
}: {
  kind: DashboardActionKind;
  detail: string;
  dueDate: string | null;
}) {
  return (
    <div className="studio-action-context">
      <span className="studio-review-badge">{actionKindLabels[kind]}</span>
      {dueDate ? <span className="studio-action-due">Due {formatDate(dueDate)}</span> : null}
      {detail ? <span className="studio-action-detail">{detail}</span> : null}
    </div>
  );
}