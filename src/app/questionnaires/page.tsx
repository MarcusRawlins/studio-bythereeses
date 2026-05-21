import { AppShell } from "@/components/AppShell";
import { listQuestionnaireQuestions, listQuestionnaireResponses, listQuestionnaires } from "@/lib/questionnaires";
import { ClipboardList, Eye, FileQuestion, Pencil, Send } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function QuestionnairesPage() {
  const questionnaires = await listQuestionnaires();
  const cards = await Promise.all(questionnaires.map(async (questionnaire) => {
    const [questions, responses] = await Promise.all([
      listQuestionnaireQuestions(questionnaire.id),
      listQuestionnaireResponses(questionnaire.id),
    ]);

    return { questionnaire, questionCount: questions.length, responseCount: responses.length };
  }));

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 sm:flex-row sm:items-end">
          <div>
            <h1 className="brand-page-title text-4xl">Questionnaires</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">Create, edit, send, and track client questionnaires that feed timelines, family lists, vendor credits, and writing workflows.</p>
          </div>
          <button type="button" disabled className="brand-primary-button inline-flex cursor-not-allowed items-center gap-2 rounded-sm px-4 py-2.5 opacity-60 transition">
            <FileQuestion className="h-4 w-4" />
            Create questionnaire
          </button>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <ClipboardList className="h-4 w-4" />
              Active questionnaires
            </div>
            <div className="mt-3 text-3xl font-semibold">{questionnaires.length}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Structured forms stored in D1.</p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <FileQuestion className="h-4 w-4" />
              Questions available
            </div>
            <div className="mt-3 text-3xl font-semibold">{cards.reduce((total, card) => total + card.questionCount, 0)}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Reusable fields clients can answer.</p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
              <Send className="h-4 w-4" />
              CRM responses
            </div>
            <div className="mt-3 text-3xl font-semibold">{cards.reduce((total, card) => total + card.responseCount, 0)}</div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">Responses linked to clients and projects.</p>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          {cards.map(({ questionnaire, questionCount, responseCount }) => (
            <article key={questionnaire.id} className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">Questionnaire</div>
                  <h2 className="mt-2 text-2xl font-semibold">{questionnaire.title}</h2>
                  {questionnaire.description && <p className="mt-3 line-clamp-3 max-w-2xl whitespace-pre-line text-sm leading-6 text-[var(--ink-muted)]">{questionnaire.description}</p>}
                </div>
                <span className="w-fit rounded-full border border-[var(--line)] px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                  {questionnaire.status}
                </span>
              </div>

              <div className="mt-5 grid gap-3 border-y border-[var(--line)] py-4 sm:grid-cols-3">
                <div>
                  <div className="text-2xl font-semibold">{questionCount}</div>
                  <div className="mt-1 text-xs text-[var(--ink-muted)]">Questions</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold">{responseCount}</div>
                  <div className="mt-1 text-xs text-[var(--ink-muted)]">CRM responses</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold">{questionnaire.lastResponseCount}</div>
                  <div className="mt-1 text-xs text-[var(--ink-muted)]">Historical answers</div>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                <Link href={`/questionnaires/${questionnaire.id}`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                  <Eye className="h-4 w-4" />
                  View
                </Link>
                <Link href={`/questionnaires/${questionnaire.id}/preview`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                  <Eye className="h-4 w-4" />
                  Client preview
                </Link>
                <Link href={`/questionnaires/${questionnaire.id}/responses`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                  <ClipboardList className="h-4 w-4" />
                  Responses
                </Link>
                <Link href={`/questionnaires/${questionnaire.id}/edit`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                  <Pencil className="h-4 w-4" />
                  Edit
                </Link>
                <Link href={`/questionnaires/${questionnaire.id}/send`} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                  <Send className="h-4 w-4" />
                  Send
                </Link>
              </div>
            </article>
          ))}
        </section>
      </div>
    </AppShell>
  );
}
