import { AppShell } from "@/components/AppShell";
import { QuestionnaireTemplateEditor } from "@/components/QuestionnaireTemplateEditor";
import { addQuestionnaireQuestionAction, getQuestionnaire, listQuestionnaireQuestions, reorderQuestionnaireQuestionsAction, updateQuestionnaireAction, updateQuestionnaireQuestionAction } from "@/lib/questionnaires";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function QuestionnaireDetailPage({
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

  const questions = await listQuestionnaireQuestions(questionnaire.id);

  return (
    <AppShell>
      <QuestionnaireTemplateEditor
        questionnaire={questionnaire}
        questions={questions}
        updateQuestionnaire={updateQuestionnaireAction}
        updateQuestion={updateQuestionnaireQuestionAction}
        addQuestion={addQuestionnaireQuestionAction}
        reorderQuestions={reorderQuestionnaireQuestionsAction}
        projectId={projectId}
      />
    </AppShell>
  );
}
