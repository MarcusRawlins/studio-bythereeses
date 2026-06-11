import { AppShell } from "@/components/AppShell";
import { QuestionnaireQuestionList, type QuestionnaireAnswerMap } from "@/components/QuestionnaireQuestionList";
import { getQuestionnaireResponseDetail, listQuestionnaireQuestions, questionnaireResponseStatus, updateQuestionnaireResponseAction } from "@/lib/questionnaires";
import { CheckCircle2, ClipboardEdit, Save } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

function answerMap(answers: NonNullable<Awaited<ReturnType<typeof getQuestionnaireResponseDetail>>>["answers"]) {
  return Object.fromEntries(
    answers.map((answer) => [
      answer.questionId,
      Array.isArray(answer.value)
        ? answer.value.map((value) => String(value))
        : String(answer.value ?? ""),
    ]),
  ) as QuestionnaireAnswerMap;
}

function displayClient(response: {
  clientFirstName: string | null;
  clientLastName: string | null;
  clientEmail: string | null;
}) {
  const name = [response.clientFirstName, response.clientLastName].filter(Boolean).join(" ");
  return name || response.clientEmail || "No linked client";
}

export default async function EditQuestionnaireResponsePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; responseId: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id, responseId } = await params;
  const { saved } = await searchParams;
  const detail = await getQuestionnaireResponseDetail(responseId);
  if (!detail || detail.response.questionnaireId !== id) notFound();

  const { response, answers } = detail;
  const questions = await listQuestionnaireQuestions(id);
  const status = questionnaireResponseStatus(response);
  const backHref = response.projectId ? `/projects/${response.projectId}` : `/questionnaires/${id}/responses`;
  const backLabel = response.projectId ? "Back to project" : "Back to responses";

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 lg:flex-row lg:items-end">
          <div>
            <Link href={backHref} className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">
              {backLabel}
            </Link>
            <h1 className="brand-page-title mt-3 text-4xl">Edit Client Responses</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">
              {response.questionnaireTitle} · {displayClient(response)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="h-fit w-fit rounded-full border border-[var(--line)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              {status}
            </span>
            <Link href={`/questionnaires/${id}/responses/${responseId}`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
              View saved response
            </Link>
          </div>
        </header>

        {saved && (
          <div className="rounded-md border border-[var(--accent)] bg-[#edf6f1] p-4 text-sm font-semibold text-[var(--accent-strong)]">
            {saved === "submitted" ? "Client responses marked submitted." : "Client responses saved."}
          </div>
        )}

        <form action={updateQuestionnaireResponseAction} className="rounded-md border border-[var(--line)] bg-[var(--surface)] shadow-sm">
          <input type="hidden" name="responseId" value={responseId} />
          <input type="hidden" name="questionnaireId" value={id} />
          <input type="hidden" name="projectId" value={response.projectId ?? ""} />
          <div className="border-b border-[var(--line)] p-5">
            <div className="flex items-center gap-2">
              <ClipboardEdit className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="text-lg font-semibold">Client answer fields</h2>
            </div>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">
              Save partial answers at any time, or mark the response submitted when it should count as complete.
            </p>
          </div>
          <div className="p-5">
            <QuestionnaireQuestionList questions={questions} clientPreview defaultAnswers={answerMap(answers)} />
          </div>
          <div className="flex flex-col gap-2 border-t border-[var(--line)] p-5 sm:flex-row sm:justify-end">
            <button name="intent" value="save" className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--foreground)]">
              <Save className="h-4 w-4" />
              Save responses
            </button>
            <button name="intent" value="submit" className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 text-sm">
              <CheckCircle2 className="h-4 w-4" />
              Mark submitted
            </button>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
