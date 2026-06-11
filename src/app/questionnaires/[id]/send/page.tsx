import { AppShell } from "@/components/AppShell";
import {
  createQuestionnaireContext,
  getQuestionnairePublicUrl,
  getTimelineQuestionnaireCallUrl,
} from "@/lib/questionnaire-links";
import { getQuestionnaire, listQuestionnaireSendRecipients } from "@/lib/questionnaires";
import { CalendarClock, ExternalLink, Mail, Send } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

function clientName(recipient: Awaited<ReturnType<typeof listQuestionnaireSendRecipients>>[number]) {
  const fullName = [recipient.clientFirstName, recipient.clientLastName].filter(Boolean).join(" ");
  return recipient.clientPreferredName || fullName || recipient.clientEmail;
}

function formatDate(value: string | null) {
  if (!value) return "No event date";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function mailtoLink(email: string, questionnaireTitle: string, questionnaireUrl: string, timelineUrl: string) {
  const subject = `Questionnaire for ${questionnaireTitle}`;
  const body = [
    "Hi!",
    "",
    "Here is the questionnaire for your project:",
    questionnaireUrl,
    "",
    "After you submit it, you will be sent to schedule your timeline and vision call. You can also use this scheduling link:",
    timelineUrl,
    "",
    "The Reeses Studio",
  ].join("\n");

  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default async function SendQuestionnairePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ projectId?: string }>;
}) {
  const { id } = await params;
  const { projectId } = await searchParams;
  const questionnaire = await getQuestionnaire(id);
  if (!questionnaire) notFound();

  const recipients = await listQuestionnaireSendRecipients(projectId);
  const genericQuestionnaireUrl = getQuestionnairePublicUrl(questionnaire.id);
  const genericTimelineUrl = getTimelineQuestionnaireCallUrl();

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 lg:flex-row lg:items-end">
          <div>
            <Link href={projectId ? `/projects/${projectId}` : `/questionnaires/${questionnaire.id}`} className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">
              {projectId ? "Back to project" : "Back to questionnaire"}
            </Link>
            <h1 className="brand-page-title mt-3 text-4xl">Send Questionnaire</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--ink-muted)]">
              Send this questionnaire to a project client. Their response is saved to that project, then they are sent to the public timeline and vision call scheduler.
            </p>
          </div>
          <Link href={genericQuestionnaireUrl} target="_blank" className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--foreground)]">
            <ExternalLink className="h-4 w-4" />
            Open generic link
          </Link>
        </header>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <Send className="mt-0.5 h-5 w-5 text-[var(--ink-muted)]" />
            <div>
              <h2 className="text-lg font-semibold">{questionnaire.title}</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--ink-muted)]">
                The project-specific links below include a signed context token. That is how Studio knows which client and project should receive the submitted answers.
              </p>
            </div>
          </div>
        </section>

        <section className="grid gap-4">
          {recipients.map((recipient) => {
            const context = createQuestionnaireContext(questionnaire.id, recipient.projectId, recipient.clientId);
            const questionnaireUrl = getQuestionnairePublicUrl(questionnaire.id, context);
            const timelineUrl = getTimelineQuestionnaireCallUrl(recipient.projectId, recipient.clientId);
            const emailLink = mailtoLink(recipient.clientEmail, questionnaire.title, questionnaireUrl, timelineUrl);

            return (
              <article key={`${recipient.projectId}-${recipient.clientId}`} className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
                <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">{recipient.role}</div>
                    <h3 className="mt-2 text-xl font-semibold">{clientName(recipient)}</h3>
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">{recipient.clientEmail}</p>
                    <p className="mt-3 flex items-center gap-2 text-sm text-[var(--ink-muted)]">
                      <CalendarClock className="h-4 w-4" />
                      {recipient.projectName} · {formatDate(recipient.projectEventDate)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link href={questionnaireUrl} target="_blank" className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                      <ExternalLink className="h-4 w-4" />
                      Open questionnaire
                    </Link>
                    <Link href={emailLink} className="brand-primary-button inline-flex items-center gap-2 rounded-sm px-3 py-2 text-sm">
                      <Mail className="h-4 w-4" />
                      Email link
                    </Link>
                  </div>
                </div>

                <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                  Client questionnaire URL
                  <input readOnly value={questionnaireUrl} className="mt-2 w-full rounded-md border border-[var(--line)] bg-[#fbf9f5] px-3 py-2 text-sm normal-case tracking-normal text-[var(--foreground)]" />
                </label>
              </article>
            );
          })}
          {!recipients.length && (
            <div className="rounded-md border border-dashed border-[var(--line)] bg-[var(--surface-muted)] p-5">
              <h2 className="text-lg font-semibold">No project clients found</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
                Add a client to this project before sending a project-scoped questionnaire link.
              </p>
              {projectId && (
                <Link href={`/projects/${projectId}`} className="mt-4 inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                  Back to project
                </Link>
              )}
            </div>
          )}
        </section>

        <section className="rounded-md border border-dashed border-[var(--line)] bg-[var(--surface-muted)] p-5">
          <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">Unlinked fallback</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
            This public link works, but answers will not attach to a project unless the questionnaire is sent from one of the project/client rows above.
          </p>
          <div className="mt-4 grid gap-3">
            <input readOnly value={genericQuestionnaireUrl} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm" />
            <input readOnly value={genericTimelineUrl} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm" />
          </div>
        </section>
      </div>
    </AppShell>
  );
}
