import { AppShell } from "@/components/AppShell";
import { getQuestionnaireResponseDetail, questionnaireResponseStatus } from "@/lib/questionnaires";
import { Bot, CalendarDays, FolderKanban, Mail, Pencil, UserRound } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

function formatTimestamp(value: string | null) {
  if (!value) return "Not submitted";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function displayClient(response: {
  clientFirstName: string | null;
  clientLastName: string | null;
  clientEmail: string | null;
}) {
  const name = [response.clientFirstName, response.clientLastName].filter(Boolean).join(" ");
  return name || response.clientEmail || "No linked client";
}

export default async function QuestionnaireResponseDetailPage({
  params,
}: {
  params: Promise<{ id: string; responseId: string }>;
}) {
  const { id, responseId } = await params;
  const detail = await getQuestionnaireResponseDetail(responseId);
  if (!detail || detail.response.questionnaireId !== id) notFound();

  const { response, answers } = detail;
  const status = questionnaireResponseStatus(response);
  const respondent = response.respondentName || response.respondentEmail || displayClient(response);
  const backHref = response.projectId ? `/projects/${response.projectId}` : `/questionnaires/${id}/responses`;
  const backLabel = response.projectId ? "Back to project" : "Back to responses";
  const responseHref = `/questionnaires/${id}/responses/${responseId}`;
  const timelineTaskInstructions = [
    `Use questionnaire response ${responseId} (${responseHref}) as the planning source.`,
    "Create a wedding day timeline draft and a family formal list draft for Tyler to review.",
    "Use the Studio timeline templates and preserve any uncertainty as review notes instead of inventing facts.",
    "Do not change the canonical wedding date.",
  ].join("\n");

  return (
    <AppShell>
      <div className="space-y-5">
        <header className="border-b border-[var(--line)] pb-4">
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <Link href={backHref} className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">
              {backLabel}
            </Link>
            <h1 className="brand-page-title mt-3 text-4xl">Questionnaire response</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">{response.questionnaireTitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="h-fit w-fit rounded-full border border-[var(--line)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              {status}
            </span>
            {response.projectId && (
              <form action={`/api/projects/${response.projectId}/agent-tasks`} method="post">
                <input type="hidden" name="title" value={`Create timeline and family formal list from ${response.questionnaireTitle}`} />
                <input type="hidden" name="instructions" value={timelineTaskInstructions} />
                <input type="hidden" name="priority" value="normal" />
                <input type="hidden" name="assignedAgent" value="Timeline Agent" />
                <input type="hidden" name="projectSourceId" value={response.projectSourceId ?? ""} />
                <button className="brand-primary-button inline-flex items-center gap-2 rounded-sm px-3 py-2 text-sm">
                  <Bot className="h-4 w-4" />
                  Create timeline
                </button>
              </form>
            )}
            <Link href={`/questionnaires/${id}/responses/${responseId}/edit`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
              <Pencil className="h-4 w-4" />
              Edit responses
            </Link>
          </div>
          </div>
        </header>

        <section className="grid gap-x-6 gap-y-3 border-b border-[var(--line)] pb-4 text-sm md:grid-cols-2 xl:grid-cols-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              <UserRound className="h-4 w-4" />
              Respondent
            </div>
            <div className="mt-1 truncate font-semibold">{respondent}</div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              <Mail className="h-4 w-4" />
              Email
            </div>
            <div className="mt-1 truncate font-semibold">{response.respondentEmail || response.clientEmail || "No email captured"}</div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              <FolderKanban className="h-4 w-4" />
              Linked project
            </div>
            <div className="mt-1 truncate font-semibold">{response.projectName || "No linked project"}</div>
            <div className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">{displayClient(response)}</div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              <CalendarDays className="h-4 w-4" />
              {status === "submitted" ? "Submitted" : "Draft saved"}
            </div>
            <div className="mt-1 truncate font-semibold">{formatTimestamp(response.submittedAt ?? response.updatedAt)}</div>
          </div>
        </section>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] shadow-sm">
          <div className="border-b border-[var(--line)] p-5">
            <h2 className="text-lg font-semibold">Answers</h2>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">Stored answers from the client-facing questionnaire.</p>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {answers.map((answer) => answer.type === "section" ? (
              <div key={answer.questionId} className="bg-[#fbf9f5] p-5">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">Section</div>
                <h3 className="mt-2 font-semibold uppercase tracking-[0.08em]">{answer.title}</h3>
                {answer.description && <p className="mt-1 text-sm leading-6 text-[var(--ink-muted)]">{answer.description}</p>}
              </div>
            ) : (
              <article key={answer.questionId} className="grid gap-3 p-5 lg:grid-cols-[minmax(240px,0.45fr)_1fr]">
                <div>
                  <h3 className="font-semibold">{answer.title}{answer.required && <span className="ml-1 text-[var(--brand-brown)]">*</span>}</h3>
                  {answer.description && <p className="mt-1 text-sm leading-6 text-[var(--ink-muted)]">{answer.description}</p>}
                  <div className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">{answer.type.replaceAll("_", " ")}</div>
                </div>
                <div className={answer.formattedValue === "No answer" ? "whitespace-pre-wrap text-sm leading-6 text-[var(--ink-muted)]" : "whitespace-pre-wrap text-sm leading-6"}>
                  {answer.formattedValue}
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
