import { db } from "@/db/client";
import { questionnaireQuestions, questionnaireResponses, questionnaires } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import {
  getQuestionnaireConfirmationUrl,
  verifyQuestionnaireContext,
  weddingTimelineQuestionnaireId,
} from "@/lib/questionnaire-links";
import {
  createProjectQuestionnaireResponseDraft,
  updateQuestionnaireResponseAnswers,
  type QuestionnaireAnswerInput,
} from "@/lib/questionnaires";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

type AnswerValue = string | string[];

const MAX_ANSWER_LENGTH = 5000;
const MAX_CHECKBOX_VALUE_LENGTH = 500;
const MAX_SERIALIZED_ANSWERS_LENGTH = 100000;

function isEmptyAnswer(value: AnswerValue) {
  return Array.isArray(value)
    ? value.length === 0 || value.every((entry) => entry.trim() === "")
    : value.trim() === "";
}

function firstTextAnswer(
  answers: Array<{ title: string; value: AnswerValue }>,
  matcher: (title: string) => boolean,
) {
  const match = answers.find((answer) => matcher(answer.title.toLowerCase()));
  if (!match || Array.isArray(match.value)) return null;
  const value = match.value.trim();
  return value || null;
}

function validateAnswerPayload(
  answer: { title: string; value: AnswerValue },
): string | null {
  if (Array.isArray(answer.value)) {
    for (const entry of answer.value) {
      if (entry.length > MAX_CHECKBOX_VALUE_LENGTH) {
        return `Answer choice too long for "${answer.title}".`;
      }
    }
    return null;
  }

  if (answer.value.length > MAX_ANSWER_LENGTH) {
    return `Answer too long for "${answer.title}".`;
  }

  return null;
}

function safeRevalidatePath(path: string) {
  try {
    revalidatePath(path);
  } catch (error) {
    if (error instanceof Error && error.message.includes("static generation store missing")) {
      return;
    }
    throw error;
  }
}

function answerInputFromStoredAnswers(answers: Array<{ questionId: string; value: AnswerValue }>) {
  return Object.fromEntries(answers.map((answer) => [answer.questionId, answer.value])) as QuestionnaireAnswerInput;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const questionnaire = await db.query.questionnaires.findFirst({
    where: eq(questionnaires.id, id),
  });

  if (!questionnaire || questionnaire.status !== "active") {
    return NextResponse.json({ error: "Questionnaire is unavailable." }, { status: 404 });
  }

  const questions = await db.query.questionnaireQuestions.findMany({
    where: eq(questionnaireQuestions.questionnaireId, id),
    orderBy: asc(questionnaireQuestions.sortOrder),
  });
  const formData = await request.formData();
  const contextToken = String(formData.get("context") ?? "");
  const context = verifyQuestionnaireContext(contextToken, questionnaire.id);
  const intent = String(formData.get("intent") ?? "submit");
  const answers = questions
    .filter((question) => question.type !== "section")
    .map((question) => {
      const value = question.type === "checkboxes"
        ? formData.getAll(question.id).map((entry) => String(entry).trim()).filter(Boolean)
        : String(formData.get(question.id) ?? "").trim();

      return {
        questionId: question.id,
        title: question.title,
        type: question.type,
        required: question.required,
        value,
      };
    });

  const isSubmit = intent !== "save";
  const missingRequired = isSubmit ? answers.filter((answer) => answer.required && isEmptyAnswer(answer.value)) : [];
  if (isSubmit && missingRequired.length > 0) {
    return NextResponse.json(
      { error: "Please complete all required questions before submitting.", missing: missingRequired.map((answer) => answer.title) },
      { status: 400 },
    );
  }

  for (const answer of answers) {
    const validationError = validateAnswerPayload(answer);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
  }

  const now = new Date().toISOString();
  const respondentName = firstTextAnswer(answers, (title) => title.includes("full name") || title === "your names");
  const respondentEmail = firstTextAnswer(answers, (title) => title.includes("email"));
  if (!isSubmit && !context) {
    const url = new URL(`/questionnaires/${questionnaire.id}/preview`, request.url);
    url.searchParams.set("saved", "device");
    return NextResponse.redirect(url, 303);
  }

  if (context?.projectId) {
    const responseId = await createProjectQuestionnaireResponseDraft({
      questionnaireId: questionnaire.id,
      projectId: context.projectId,
      clientId: context.clientId,
    });

    await updateQuestionnaireResponseAnswers({
      responseId,
      answers: answerInputFromStoredAnswers(answers),
      submit: isSubmit,
    });

    if (!isSubmit) {
      const url = new URL(`/questionnaires/${questionnaire.id}/preview`, request.url);
      if (contextToken) url.searchParams.set("context", contextToken);
      url.searchParams.set("saved", "server");
      return NextResponse.redirect(url, 303);
    }

    safeRevalidatePath("/questionnaires");
    safeRevalidatePath(`/questionnaires/${questionnaire.id}`);
    safeRevalidatePath(`/questionnaires/${questionnaire.id}/preview`);

    if (questionnaire.id === weddingTimelineQuestionnaireId) {
      return NextResponse.redirect(getQuestionnaireConfirmationUrl(questionnaire.id, contextToken), 303);
    }

    return NextResponse.redirect(new URL(`/questionnaires/${questionnaire.id}/submitted`, request.url), 303);
  }

  const draft = context?.projectId && context?.clientId
    ? await db.query.questionnaireResponses.findFirst({
      where: and(
        eq(questionnaireResponses.questionnaireId, questionnaire.id),
        eq(questionnaireResponses.projectId, context.projectId),
        eq(questionnaireResponses.clientId, context.clientId),
        isNull(questionnaireResponses.submittedAt),
      ),
      orderBy: desc(questionnaireResponses.updatedAt),
    })
    : null;

  const serializedAnswers = JSON.stringify(answers);
  if (serializedAnswers.length > MAX_SERIALIZED_ANSWERS_LENGTH) {
    return NextResponse.json(
      { error: "Answer payload is too large. Please shorten your responses and try again." },
      { status: 400 },
    );
  }

  const responseValues = {
    questionnaireId: questionnaire.id,
    projectId: context?.projectId ?? null,
    clientId: context?.clientId ?? null,
    respondentName,
    respondentEmail,
    submittedAt: isSubmit ? now : null,
    sourceResponseId: null,
    answersJson: serializedAnswers,
    updatedAt: now,
  };

  if (draft) {
    await db.update(questionnaireResponses)
      .set(responseValues)
      .where(eq(questionnaireResponses.id, draft.id));
  } else {
    await db.insert(questionnaireResponses).values({
      id: crypto.randomUUID(),
      ...responseValues,
      createdAt: now,
    });
  }

  if (!isSubmit) {
    await logActivity({
      action: "questionnaire.response.draft_saved",
      metadata: {
        questionnaireId: questionnaire.id,
        projectId: context?.projectId ?? null,
        clientId: context?.clientId ?? null,
      },
    });

    const url = new URL(`/questionnaires/${questionnaire.id}/preview`, request.url);
    if (contextToken) url.searchParams.set("context", contextToken);
    url.searchParams.set("saved", context ? "server" : "device");
    return NextResponse.redirect(url, 303);
  }

  await logActivity({
    action: "questionnaire.response.submitted",
    metadata: {
      questionnaireId: questionnaire.id,
      projectId: context?.projectId ?? null,
      clientId: context?.clientId ?? null,
      respondentEmail,
    },
  });

  safeRevalidatePath("/questionnaires");
  safeRevalidatePath(`/questionnaires/${questionnaire.id}`);
  safeRevalidatePath(`/questionnaires/${questionnaire.id}/preview`);

  if (questionnaire.id === weddingTimelineQuestionnaireId) {
    return NextResponse.redirect(getQuestionnaireConfirmationUrl(questionnaire.id, contextToken), 303);
  }

  return NextResponse.redirect(new URL(`/questionnaires/${questionnaire.id}/submitted`, request.url), 303);
}
