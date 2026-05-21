import { db } from "@/db/client";
import { clients, projectParticipants, projects, questionnaireQuestions, questionnaireResponses, questionnaires } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { weddingTimelineQuestionnaireId } from "@/lib/questionnaire-links";
import { asc, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export type QuestionnaireQuestionType =
  | "section"
  | "short_text"
  | "paragraph"
  | "multiple_choice"
  | "checkboxes"
  | "dropdown"
  | "linear_scale";

type ParsedQuestion = {
  id: string;
  title: string;
  description: string | null;
  type: QuestionnaireQuestionType;
  required: boolean;
  options: string[];
  sortOrder: number;
};

type ParsedGoogleForm = {
  title: string;
  description: string | null;
  questions: ParsedQuestion[];
};

export type QuestionnaireResponseStatus = "draft" | "submitted";

export type QuestionnaireResponseSummary = {
  id: string;
  questionnaireId: string;
  questionnaireTitle: string;
  projectId: string | null;
  projectName: string | null;
  projectEventDate: string | null;
  clientId: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  clientPreferredName: string | null;
  clientEmail: string | null;
  respondentName: string | null;
  respondentEmail: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type StoredQuestionnaireAnswer = {
  questionId?: string;
  title?: string;
  type?: string;
  required?: boolean;
  value?: unknown;
};

const weddingTimelineFormUrl = "https://docs.google.com/forms/d/e/1FAIpQLSdpuguIkS2hmOX7CqK0h-pcBiSTdxokoMkSKiPAXj9y_DJyMw/viewform?usp=header";
const weddingTimelineResponseSheetUrl = "https://docs.google.com/spreadsheets/d/1wPknhFe7Kv6Fc5glpvwNWzxv5SXh9U_OK1vxOPT_3hM/edit?resourcekey=&gid=913926914#gid=913926914";
const weddingTimelineResponseSheetName = "Form Responses 1";
const knownExistingResponseCount = 107;

const googleFormTypeMap: Record<number, QuestionnaireQuestionType> = {
  0: "short_text",
  1: "paragraph",
  2: "multiple_choice",
  3: "dropdown",
  4: "checkboxes",
  5: "linear_scale",
  6: "section",
};

function fallbackQuestionnaire(): ParsedGoogleForm {
  return {
    title: "Photography Timeline & Vision Questionnaire",
    description: "Wedding-day planning questionnaire for timeline details, family formals, styling details, and vendor information.",
    questions: [],
  };
}

function parseGoogleFormLoadData(html: string): ParsedGoogleForm {
  const match = html.match(/FB_PUBLIC_LOAD_DATA_ = ([\s\S]*?);<\/script>/);
  if (!match?.[1]) return fallbackQuestionnaire();

  const data = JSON.parse(match[1]) as unknown[];
  const form = data[1] as unknown[] | undefined;
  const description = typeof form?.[0] === "string" ? form[0] : null;
  const rawQuestions = Array.isArray(form?.[1]) ? form[1] as unknown[][] : [];
  const title = typeof form?.[8] === "string" ? form[8] : "Photography Timeline & Vision Questionnaire";

  const questions = rawQuestions.map((item, index) => {
    const entry = Array.isArray(item[4]) ? item[4][0] as unknown[] | undefined : undefined;
    const rawOptions = Array.isArray(entry?.[1]) ? entry[1] as unknown[] : [];
    const title = typeof item[1] === "string" ? item[1] : "Untitled question";
    const description = typeof item[2] === "string" ? item[2] : null;
    const type = googleFormTypeMap[Number(item[3])] ?? "short_text";

    return {
      id: `gform-${String(item[0] ?? index)}`,
      title,
      description,
      type,
      required: Boolean(entry?.[2]),
      options: rawOptions.map((option) => Array.isArray(option) ? String(option[0] ?? "") : "").filter(Boolean),
      sortOrder: index,
    } satisfies ParsedQuestion;
  });

  return { title, description, questions: normalizeQuestionnaireQuestions(questions) };
}

function normalizeQuestionnaireQuestions(questions: ParsedQuestion[]) {
  const normalized: ParsedQuestion[] = [];

  for (const question of questions) {
    const splitQuestions = splitCombinedQuestion(question);
    normalized.push(...splitQuestions);
  }

  return normalized.map((question, index) => ({
    ...question,
    sortOrder: index,
  }));
}

function splitCombinedQuestion(question: ParsedQuestion): ParsedQuestion[] {
  const shared = {
    description: question.description,
    type: question.type,
    required: question.required,
    options: question.options,
  };

  if (question.title === "Bride's Name & Instagram") {
    return [
      { ...question, title: "Bride's full name" },
      {
        id: `${question.id}-instagram`,
        title: "Bride's Instagram",
        description: "Used for client profile details and social/vendor tagging.",
        type: "short_text",
        required: false,
        options: [],
        sortOrder: question.sortOrder,
      },
    ];
  }

  if (question.title === "Bride's Email & Phone Number") {
    return [
      { ...question, title: "Bride's email", type: "short_text", options: [] },
      {
        id: `${question.id}-phone`,
        title: "Bride's phone number",
        description: "Used for client contact details.",
        type: "short_text",
        required: false,
        options: [],
        sortOrder: question.sortOrder,
      },
    ];
  }

  if (question.title === "Groom's Name & Instagram") {
    return [
      { ...question, title: "Groom's full name" },
      {
        id: `${question.id}-instagram`,
        title: "Groom's Instagram",
        description: "Used for client profile details and social/vendor tagging.",
        type: "short_text",
        required: false,
        options: [],
        sortOrder: question.sortOrder,
      },
    ];
  }

  if (question.title === "Groom's Email & Phone Number") {
    return [
      { ...question, title: "Groom's email", type: "short_text", options: [] },
      {
        id: `${question.id}-phone`,
        title: "Groom's phone number",
        description: "Used for client contact details.",
        type: "short_text",
        required: false,
        options: [],
        sortOrder: question.sortOrder,
      },
    ];
  }

  return [{ ...question, ...shared }];
}

async function fetchWeddingTimelineQuestionnaire() {
  try {
    const response = await fetch(weddingTimelineFormUrl, { cache: "no-store" });
    if (!response.ok) return fallbackQuestionnaire();
    return parseGoogleFormLoadData(await response.text());
  } catch {
    return fallbackQuestionnaire();
  }
}

export async function refreshWeddingTimelineQuestionnaire() {
  const now = new Date().toISOString();
  const parsed = await fetchWeddingTimelineQuestionnaire();

  await db.insert(questionnaires).values({
    id: weddingTimelineQuestionnaireId,
    title: parsed.title,
    description: parsed.description,
    status: "active",
    sourceFormUrl: weddingTimelineFormUrl,
    responseSheetUrl: weddingTimelineResponseSheetUrl,
    responseSheetName: weddingTimelineResponseSheetName,
    externalQuestionCount: parsed.questions.length,
    lastResponseCount: knownExistingResponseCount,
    lastImportedAt: null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: questionnaires.id,
    set: {
      title: parsed.title,
      description: parsed.description,
      status: "active",
      sourceFormUrl: weddingTimelineFormUrl,
      responseSheetUrl: weddingTimelineResponseSheetUrl,
      responseSheetName: weddingTimelineResponseSheetName,
      externalQuestionCount: parsed.questions.length,
      lastResponseCount: knownExistingResponseCount,
      updatedAt: now,
    },
  });

  await db.delete(questionnaireQuestions).where(eq(questionnaireQuestions.questionnaireId, weddingTimelineQuestionnaireId));
  if (parsed.questions.length) {
    const rows = parsed.questions.map((question) => ({
      id: `${weddingTimelineQuestionnaireId}-${question.id}`,
      questionnaireId: weddingTimelineQuestionnaireId,
      title: question.title,
      description: question.description,
      type: question.type,
      required: question.required,
      optionsJson: question.options.length ? JSON.stringify(question.options) : null,
      sortOrder: question.sortOrder,
      createdAt: now,
      updatedAt: now,
    }));

    for (let index = 0; index < rows.length; index += 8) {
      await db.insert(questionnaireQuestions).values(rows.slice(index, index + 8));
    }
  }

  await logActivity({
    action: "questionnaire.synced",
    metadata: {
      questionnaireId: weddingTimelineQuestionnaireId,
      questionCount: parsed.questions.length,
      source: "google_form",
    },
  });
}

export async function ensureWeddingTimelineQuestionnaire() {
  const existing = await db.query.questionnaires.findFirst({
    where: eq(questionnaires.id, weddingTimelineQuestionnaireId),
  });
  if (!existing) {
    await refreshWeddingTimelineQuestionnaire();
    return;
  }

  const firstQuestion = await db.query.questionnaireQuestions.findFirst({
    where: eq(questionnaireQuestions.questionnaireId, weddingTimelineQuestionnaireId),
  });
  if (!firstQuestion) {
    await refreshWeddingTimelineQuestionnaire();
  }
}

export async function listQuestionnaires() {
  await ensureWeddingTimelineQuestionnaire();
  return db.query.questionnaires.findMany({
    orderBy: desc(questionnaires.createdAt),
  });
}

export async function getQuestionnaire(questionnaireId: string) {
  await ensureWeddingTimelineQuestionnaire();
  return db.query.questionnaires.findFirst({
    where: eq(questionnaires.id, questionnaireId),
  });
}

export async function listQuestionnaireQuestions(questionnaireId: string) {
  await ensureWeddingTimelineQuestionnaire();
  return db.query.questionnaireQuestions.findMany({
    where: eq(questionnaireQuestions.questionnaireId, questionnaireId),
    orderBy: asc(questionnaireQuestions.sortOrder),
  });
}

export async function listQuestionnaireResponses(questionnaireId: string) {
  return db.query.questionnaireResponses.findMany({
    where: eq(questionnaireResponses.questionnaireId, questionnaireId),
    orderBy: desc(questionnaireResponses.submittedAt),
    limit: 20,
  });
}

export function questionnaireResponseStatus(response: { submittedAt: string | null }) {
  return response.submittedAt ? "submitted" : "draft";
}

export function formatQuestionnaireAnswerValue(value: unknown) {
  if (Array.isArray(value)) {
    const answers = value.map((item) => String(item).trim()).filter(Boolean);
    return answers.length ? answers.join("\n") : "No answer";
  }

  if (value === undefined || value === null) return "No answer";

  const answer = String(value).trim();
  return answer || "No answer";
}

function parseQuestionnaireAnswers(answersJson: string): StoredQuestionnaireAnswer[] {
  try {
    const parsed = JSON.parse(answersJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((answer): answer is StoredQuestionnaireAnswer => typeof answer === "object" && answer !== null);
  } catch {
    return [];
  }
}

function responseSummarySelect() {
  return {
    id: questionnaireResponses.id,
    questionnaireId: questionnaireResponses.questionnaireId,
    questionnaireTitle: questionnaires.title,
    projectId: questionnaireResponses.projectId,
    projectName: projects.name,
    projectEventDate: projects.eventDate,
    clientId: questionnaireResponses.clientId,
    clientFirstName: clients.firstName,
    clientLastName: clients.lastName,
    clientPreferredName: clients.preferredName,
    clientEmail: clients.email,
    respondentName: questionnaireResponses.respondentName,
    respondentEmail: questionnaireResponses.respondentEmail,
    submittedAt: questionnaireResponses.submittedAt,
    createdAt: questionnaireResponses.createdAt,
    updatedAt: questionnaireResponses.updatedAt,
  };
}

export async function listQuestionnaireResponsesWithContext(questionnaireId: string) {
  return db.select(responseSummarySelect())
    .from(questionnaireResponses)
    .innerJoin(questionnaires, eq(questionnaireResponses.questionnaireId, questionnaires.id))
    .leftJoin(projects, eq(questionnaireResponses.projectId, projects.id))
    .leftJoin(clients, eq(questionnaireResponses.clientId, clients.id))
    .where(eq(questionnaireResponses.questionnaireId, questionnaireId))
    .orderBy(desc(questionnaireResponses.updatedAt))
    .limit(80);
}

export async function listProjectQuestionnaireResponses(projectId: string) {
  return db.select(responseSummarySelect())
    .from(questionnaireResponses)
    .innerJoin(questionnaires, eq(questionnaireResponses.questionnaireId, questionnaires.id))
    .leftJoin(projects, eq(questionnaireResponses.projectId, projects.id))
    .leftJoin(clients, eq(questionnaireResponses.clientId, clients.id))
    .where(eq(questionnaireResponses.projectId, projectId))
    .orderBy(desc(questionnaireResponses.updatedAt))
    .limit(80);
}

export async function getQuestionnaireResponseDetail(responseId: string) {
  const [response] = await db.select({
    ...responseSummarySelect(),
    answersJson: questionnaireResponses.answersJson,
  })
    .from(questionnaireResponses)
    .innerJoin(questionnaires, eq(questionnaireResponses.questionnaireId, questionnaires.id))
    .leftJoin(projects, eq(questionnaireResponses.projectId, projects.id))
    .leftJoin(clients, eq(questionnaireResponses.clientId, clients.id))
    .where(eq(questionnaireResponses.id, responseId))
    .limit(1);

  if (!response) return null;

  const questions = await listQuestionnaireQuestions(response.questionnaireId);
  const storedAnswers = parseQuestionnaireAnswers(response.answersJson);
  const answersByQuestionId = new Map(storedAnswers.map((answer) => [answer.questionId, answer]));
  const answersByTitle = new Map(storedAnswers.map((answer) => [answer.title, answer]));

  return {
    response,
    answers: questions.map((question) => {
      const storedAnswer = answersByQuestionId.get(question.id) ?? answersByTitle.get(question.title);
      const value = storedAnswer?.value;

      return {
        questionId: question.id,
        title: question.title,
        description: question.description,
        type: question.type,
        required: question.required,
        value,
        formattedValue: question.type === "section" ? "" : formatQuestionnaireAnswerValue(value),
      };
    }),
  };
}

export async function listQuestionnaireSendRecipients(projectId?: string) {
  const query = db.select({
    projectId: projects.id,
    projectName: projects.name,
    projectEventDate: projects.eventDate,
    projectStage: projects.stage,
    clientId: clients.id,
    clientFirstName: clients.firstName,
    clientLastName: clients.lastName,
    clientPreferredName: clients.preferredName,
    clientEmail: clients.email,
    role: projectParticipants.role,
    isPrimaryContact: projectParticipants.isPrimaryContact,
  })
    .from(projectParticipants)
    .innerJoin(projects, eq(projectParticipants.projectId, projects.id))
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .$dynamic();

  const filteredQuery = projectId ? query.where(eq(projects.id, projectId)) : query;

  return filteredQuery.orderBy(desc(projects.eventDate)).limit(80);
}

export async function updateQuestionnaireAction(formData: FormData) {
  "use server";

  const questionnaireId = String(formData.get("questionnaireId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const status = String(formData.get("status") ?? "active");

  if (!questionnaireId || !title) {
    throw new Error("Questionnaire title is required.");
  }

  await db.update(questionnaires)
    .set({
      title,
      description: description || null,
      status,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(questionnaires.id, questionnaireId));

  await logActivity({
    action: "questionnaire.updated",
    metadata: { questionnaireId },
  });

  revalidatePath("/questionnaires");
  revalidatePath(`/questionnaires/${questionnaireId}`);
  redirect(`/questionnaires/${questionnaireId}`);
}

export async function updateQuestionnaireQuestionAction(formData: FormData) {
  "use server";

  const questionnaireId = String(formData.get("questionnaireId") ?? "");
  const questionId = String(formData.get("questionId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const type = String(formData.get("type") ?? "short_text") as QuestionnaireQuestionType;
  const required = formData.get("required") === "on";
  const options = String(formData.get("options") ?? "")
    .split("\n")
    .map((option) => option.trim())
    .filter(Boolean);

  if (!questionnaireId || !questionId || !title) {
    throw new Error("Question title is required.");
  }

  await db.update(questionnaireQuestions)
    .set({
      title,
      description: description || null,
      type,
      required,
      optionsJson: options.length ? JSON.stringify(options) : null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(questionnaireQuestions.id, questionId));

  await logActivity({
    action: "questionnaire.question.updated",
    metadata: { questionnaireId, questionId },
  });

  revalidatePath(`/questionnaires/${questionnaireId}`);
  revalidatePath(`/questionnaires/${questionnaireId}/preview`);
}

export async function reorderQuestionnaireQuestionsAction(formData: FormData) {
  "use server";

  const questionnaireId = String(formData.get("questionnaireId") ?? "");
  const orderedIds = String(formData.get("orderedQuestionIds") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!questionnaireId || orderedIds.length === 0) {
    throw new Error("Question order is required.");
  }

  for (const [index, questionId] of orderedIds.entries()) {
    await db.update(questionnaireQuestions)
      .set({
        sortOrder: index,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(questionnaireQuestions.id, questionId));
  }

  await logActivity({
    action: "questionnaire.questions.reordered",
    metadata: { questionnaireId, questionCount: orderedIds.length },
  });

  revalidatePath(`/questionnaires/${questionnaireId}`);
  revalidatePath(`/questionnaires/${questionnaireId}/preview`);
}

export async function refreshWeddingTimelineQuestionnaireAction() {
  "use server";

  await refreshWeddingTimelineQuestionnaire();
  revalidatePath("/questionnaires");
  redirect("/questionnaires");
}
