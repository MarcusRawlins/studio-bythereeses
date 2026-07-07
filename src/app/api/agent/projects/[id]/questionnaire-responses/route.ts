import { db } from "@/db/client";
import { questionnaireResponses } from "@/db/schema";
import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import {
  createProjectQuestionnaireResponseDraft,
  getQuestionnaireResponseDetail,
  questionnaireResponseStatus,
  updateQuestionnaireResponseAnswers,
  type QuestionnaireAnswerInput,
} from "@/lib/questionnaires";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

type QuestionnaireResponseRequestBody = {
  responseId?: unknown;
  questionnaireId?: unknown;
  clientId?: unknown;
  answers?: unknown;
  submit?: unknown;
};

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function questionnaireAnswers(value: unknown): QuestionnaireAnswerInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const answers: QuestionnaireAnswerInput = {};
  for (const [questionId, answer] of Object.entries(value)) {
    if (typeof answer === "string" || answer === null || answer === undefined) {
      answers[questionId] = answer;
      continue;
    }

    if (Array.isArray(answer)) {
      answers[questionId] = answer.filter((entry): entry is string => typeof entry === "string");
    }
  }

  return answers;
}

async function assertResponseBelongsToProject({
  responseId,
  projectId,
  questionnaireId,
}: {
  responseId: string;
  projectId: string;
  questionnaireId?: string | null;
}) {
  const detail = await getQuestionnaireResponseDetail(responseId);
  if (!detail) throw new Error("Questionnaire response not found.");
  if (detail.response.projectId !== projectId) {
    throw new Error("Questionnaire response does not belong to this project.");
  }
  if (questionnaireId && detail.response.questionnaireId !== questionnaireId) {
    throw new Error("Questionnaire response does not belong to this questionnaire.");
  }
}

async function questionnaireResponseResult(responseId: string) {
  const detail = await getQuestionnaireResponseDetail(responseId);
  if (!detail) throw new Error("Questionnaire response not found.");

  return {
    id: detail.response.id,
    questionnaireId: detail.response.questionnaireId,
    projectId: detail.response.projectId,
    clientId: detail.response.clientId,
    respondentName: detail.response.respondentName,
    respondentEmail: detail.response.respondentEmail,
    status: questionnaireResponseStatus(detail.response),
    submittedAt: detail.response.submittedAt,
    updatedAt: detail.response.updatedAt,
    sourceType: "questionnaire_response",
    sourceId: detail.response.id,
    answers: detail.answers.map((answer) => ({
      questionId: answer.questionId,
      title: answer.title,
      type: answer.type,
      required: answer.required,
      value: answer.value,
      formattedValue: answer.formattedValue,
    })),
    // D1/M3: flag ON routes this caller through the proposal path (no canonical
    // write, I2). Surface the proposal here so the agent round-trip sees the
    // suggested changes instead of assuming a silent canonical write happened.
    // Flag OFF (or no proposal computed): null, unchanged shape otherwise.
    suggestedChanges: detail.proposal,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const { id: projectId } = await params;
    const body = await request.json() as QuestionnaireResponseRequestBody;
    const questionnaireId = stringValue(body.questionnaireId);
    const requestedResponseId = stringValue(body.responseId);
    const clientId = stringValue(body.clientId);
    const existingCanonicalResponse = !requestedResponseId && questionnaireId
      ? await db.query.questionnaireResponses.findFirst({
        where: and(
          eq(questionnaireResponses.questionnaireId, questionnaireId),
          eq(questionnaireResponses.projectId, projectId),
          clientId ? eq(questionnaireResponses.clientId, clientId) : isNull(questionnaireResponses.clientId),
        ),
      })
      : null;

    const responseId = requestedResponseId ?? await createProjectQuestionnaireResponseDraft({
      questionnaireId: questionnaireId ?? "",
      projectId,
      clientId,
    });

    if (requestedResponseId) {
      await assertResponseBelongsToProject({
        responseId,
        projectId,
        questionnaireId,
      });
    }

    await updateQuestionnaireResponseAnswers({
      responseId,
      answers: questionnaireAnswers(body.answers),
      submit: body.submit === true,
    });

    return NextResponse.json(
      { questionnaireResponse: await questionnaireResponseResult(responseId) },
      { status: requestedResponseId || existingCanonicalResponse ? 200 : 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Questionnaire response upsert failed." },
      { status: 400 },
    );
  }
}
