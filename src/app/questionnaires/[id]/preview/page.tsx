import { QuestionnairePreviewForm } from "@/components/QuestionnairePreviewForm";
import type { QuestionnaireAnswerMap } from "@/components/QuestionnaireQuestionList";
import { db } from "@/db/client";
import { questionnaireResponses } from "@/db/schema";
import { verifyQuestionnaireContext } from "@/lib/questionnaire-links";
import { getQuestionnaire, listQuestionnaireQuestions } from "@/lib/questionnaires";
import { and, desc, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function QuestionnairePreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ context?: string; saved?: string }>;
}) {
  const { id } = await params;
  const { context = "", saved } = await searchParams;
  const questionnaire = await getQuestionnaire(id);
  if (!questionnaire) notFound();
  const questions = await listQuestionnaireQuestions(questionnaire.id);
  const verifiedContext = verifyQuestionnaireContext(context, questionnaire.id);
  let defaultAnswers: QuestionnaireAnswerMap = {};

  if (verifiedContext?.projectId && verifiedContext?.clientId) {
    const draft = await db.query.questionnaireResponses.findFirst({
      where: and(
        eq(questionnaireResponses.questionnaireId, questionnaire.id),
        eq(questionnaireResponses.projectId, verifiedContext.projectId),
        eq(questionnaireResponses.clientId, verifiedContext.clientId),
        isNull(questionnaireResponses.submittedAt),
      ),
      orderBy: desc(questionnaireResponses.updatedAt),
    });

    if (draft) {
      try {
        const answers = JSON.parse(draft.answersJson) as Array<{ questionId: string; value: string | string[] }>;
        defaultAnswers = Object.fromEntries(answers.map((answer) => [answer.questionId, answer.value]));
      } catch {
        defaultAnswers = {};
      }
    }
  }

  return (
    <main className="min-h-screen bg-[var(--background)] px-4 py-8 text-[var(--foreground)]">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 text-center">
          <span className="studio-caps block text-[0.62rem] text-[var(--ink-muted)]">The Reeses</span>
          <span className="font-serif text-3xl leading-none text-[var(--foreground)]">Studio</span>
        </div>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] shadow-sm">
          <div className="border-b border-[var(--line)] p-7">
            <h1 className="text-3xl font-semibold leading-tight">{questionnaire.title}</h1>
            {questionnaire.description && <p className="mt-4 whitespace-pre-line text-sm leading-6 text-[var(--ink-muted)]">{questionnaire.description}</p>}
          </div>

          <QuestionnairePreviewForm
            questionnaireId={questionnaire.id}
            context={context}
            questions={questions}
            defaultAnswers={defaultAnswers}
            savedState={saved}
          />
        </section>
      </div>
    </main>
  );
}
