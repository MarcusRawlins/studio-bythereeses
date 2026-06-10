import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { questionnaireQuestions, questionnaires } from "@/db/schema";
import {
  addQuestionnaireQuestion,
  createQuestionnaireTemplate,
  listQuestionnaireQuestions,
  reorderQuestionnaireQuestionsAction,
  updateQuestionnaireQuestionAction,
} from "./questionnaires";

const title = `Client Details Test ${Date.now()}`;

async function main() {
  const questionnaireId = await createQuestionnaireTemplate({
    title,
    description: "A project-specific planning form.",
    status: "draft",
  });
  const otherQuestionnaireId = await createQuestionnaireTemplate({
    title: `${title} Other`,
    description: "A separate planning form.",
    status: "draft",
  });

  try {
    const questionnaire = await db.query.questionnaires.findFirst({
      where: eq(questionnaires.id, questionnaireId),
    });

    assert.equal(questionnaire?.title, title);
    assert.equal(questionnaire?.status, "draft");

    let questions = await listQuestionnaireQuestions(questionnaireId);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].title, "New question");
    assert.equal(questions[0].type, "short_text");

    await addQuestionnaireQuestion({
      questionnaireId,
      title: "Vendor notes",
      type: "paragraph",
      required: true,
    });

    questions = await listQuestionnaireQuestions(questionnaireId);
    assert.equal(questions.length, 2);
    assert.equal(questions[1].title, "Vendor notes");
    assert.equal(questions[1].sortOrder, 1);
    assert.equal(questions[1].required, true);

    const mismatchForm = new FormData();
    mismatchForm.set("questionnaireId", otherQuestionnaireId);
    mismatchForm.set("questionId", questions[1].id);
    mismatchForm.set("title", "Wrong template update");
    mismatchForm.set("description", "This should not move across templates.");
    mismatchForm.set("type", "short_text");

    await assert.rejects(
      () => updateQuestionnaireQuestionAction(mismatchForm),
      /Question does not belong to this questionnaire/,
    );

    const unchangedQuestion = await db.query.questionnaireQuestions.findFirst({
      where: eq(questionnaireQuestions.id, questions[1].id),
    });
    assert.equal(unchangedQuestion?.title, "Vendor notes");
    assert.equal(unchangedQuestion?.description, null);
    assert.equal(unchangedQuestion?.type, "paragraph");

    const reorderForm = new FormData();
    reorderForm.set("questionnaireId", otherQuestionnaireId);
    reorderForm.set("orderedQuestionIds", questions.map((question) => question.id).join(","));

    await assert.rejects(
      () => reorderQuestionnaireQuestionsAction(reorderForm),
      /Question order includes a question outside this questionnaire/,
    );

    const reorderedOriginalQuestions = await listQuestionnaireQuestions(questionnaireId);
    assert.deepEqual(
      reorderedOriginalQuestions.map((question) => ({ id: question.id, sortOrder: question.sortOrder })),
      questions.map((question) => ({ id: question.id, sortOrder: question.sortOrder })),
    );
  } finally {
    await db.delete(questionnaireQuestions).where(eq(questionnaireQuestions.questionnaireId, questionnaireId));
    await db.delete(questionnaireQuestions).where(eq(questionnaireQuestions.questionnaireId, otherQuestionnaireId));
    await db.delete(questionnaires).where(eq(questionnaires.id, questionnaireId));
    await db.delete(questionnaires).where(eq(questionnaires.id, otherQuestionnaireId));
  }

  console.log("questionnaire template management tests passed");
}

main();
