import { db } from "@/db/client";
import { clients, projectEvents, projectLocations, projectParticipants, projectSources, projects, questionnaireQuestions, questionnaireResponses, questionnaires } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { projectEventCalendarStatusAfterEdit } from "@/lib/project-event-calendar";
import {
  createQuestionnaireContext,
  getQuestionnairePublicUrl,
  getTimelineQuestionnaireCallUrl,
  weddingTimelineQuestionnaireId,
} from "@/lib/questionnaire-links";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
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

export type QuestionnaireAnswerValue = string | string[];
export type QuestionnaireAnswerInput = Record<string, QuestionnaireAnswerValue | null | undefined>;

export type AgentQuestionnaireLinkInput = {
  questionnaireId?: string | null;
  clientId?: string | null;
};

export type AgentQuestionnaireLink = {
  questionnaireId: string;
  projectId: string;
  clientId: string | null;
  questionnaireUrl: string;
  timelineCallUrl: string;
  expiresAt: string;
};

type StudioQuestionnaireListOptions = {
  status?: string | null;
  includeArchived?: boolean;
  includeQuestions?: boolean;
};

const questionnaireStatuses = ["active", "draft", "archived"] as const;
const questionnaireQuestionTypes: QuestionnaireQuestionType[] = [
  "section",
  "short_text",
  "paragraph",
  "multiple_choice",
  "checkboxes",
  "dropdown",
  "linear_scale",
];

const weddingTimelineFormUrl = "https://docs.google.com/forms/d/e/1FAIpQLSdpuguIkS2hmOX7CqK0h-pcBiSTdxokoMkSKiPAXj9y_DJyMw/viewform?usp=header";
const weddingTimelineResponseSheetUrl = "https://docs.google.com/spreadsheets/d/1wPknhFe7Kv6Fc5glpvwNWzxv5SXh9U_OK1vxOPT_3hM/edit?resourcekey=&gid=913926914#gid=913926914";
const weddingTimelineResponseSheetName = "Form Responses 1";
const knownExistingResponseCount = 107;
const maxAnswerLength = 5000;
const maxCheckboxValueLength = 500;
const maxSerializedAnswersLength = 100000;

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

function parseQuestionOptions(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((option) => String(option)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function listStudioQuestionnaires({
  status,
  includeArchived = false,
  includeQuestions = true,
}: StudioQuestionnaireListOptions = {}) {
  const normalizedStatus = status?.trim() || null;
  const questionnaireRows = await db.query.questionnaires.findMany({
    where: normalizedStatus
      ? eq(questionnaires.status, normalizedStatus)
      : includeArchived
        ? undefined
        : eq(questionnaires.status, "active"),
    orderBy: desc(questionnaires.updatedAt),
  });
  const questionnaireIds = questionnaireRows.map((questionnaire) => questionnaire.id);
  const questionRows = questionnaireIds.length
    ? await db.query.questionnaireQuestions.findMany({
        where: (question, { inArray }) => inArray(question.questionnaireId, questionnaireIds),
        orderBy: asc(questionnaireQuestions.sortOrder),
      })
    : [];
  const questionsByQuestionnaire = new Map<string, Array<typeof questionnaireQuestions.$inferSelect>>();
  for (const question of questionRows) {
    questionsByQuestionnaire.set(question.questionnaireId, [
      ...(questionsByQuestionnaire.get(question.questionnaireId) ?? []),
      question,
    ]);
  }

  return questionnaireRows.map((questionnaire) => {
    const questions = questionsByQuestionnaire.get(questionnaire.id) ?? [];
    const result: {
      id: string;
      title: string;
      description: string | null;
      status: string;
      questionCount: number;
      updatedAt: string;
      questions?: Array<{
        id: string;
        title: string;
        description: string | null;
        type: string;
        required: boolean;
        options: string[];
        sortOrder: number;
      }>;
    } = {
      id: questionnaire.id,
      title: questionnaire.title,
      description: questionnaire.description,
      status: questionnaire.status,
      questionCount: questions.length,
      updatedAt: questionnaire.updatedAt,
    };
    if (includeQuestions) {
      result.questions = questions.map((question) => ({
        id: question.id,
        title: question.title,
        description: question.description,
        type: question.type,
        required: question.required,
        options: parseQuestionOptions(question.optionsJson),
        sortOrder: question.sortOrder,
      }));
    }
    return result;
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

function questionnaireStatusValue(value: string) {
  return questionnaireStatuses.includes(value as typeof questionnaireStatuses[number]) ? value : "draft";
}

function questionnaireQuestionTypeValue(value: string): QuestionnaireQuestionType {
  return questionnaireQuestionTypes.includes(value as QuestionnaireQuestionType)
    ? value as QuestionnaireQuestionType
    : "short_text";
}

function questionnaireEditorPath(questionnaireId: string, projectId?: string | null) {
  return projectId
    ? `/questionnaires/${questionnaireId}?projectId=${encodeURIComponent(projectId)}`
    : `/questionnaires/${questionnaireId}`;
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

export async function createQuestionnaireTemplate({
  title,
  description,
  status = "draft",
}: {
  title: string;
  description?: string | null;
  status?: string;
}) {
  const now = new Date().toISOString();
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    throw new Error("Questionnaire title is required.");
  }

  const questionnaireId = crypto.randomUUID();
  await db.insert(questionnaires).values({
    id: questionnaireId,
    title: cleanTitle,
    description: description?.trim() || null,
    status: questionnaireStatusValue(status),
    sourceFormUrl: null,
    responseSheetUrl: null,
    responseSheetName: null,
    externalQuestionCount: 0,
    lastResponseCount: 0,
    lastImportedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(questionnaireQuestions).values({
    id: crypto.randomUUID(),
    questionnaireId,
    title: "New question",
    description: null,
    type: "short_text",
    required: false,
    optionsJson: null,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });

  await logActivity({
    action: "questionnaire.created",
    metadata: { questionnaireId, title: cleanTitle },
  });

  return questionnaireId;
}

export async function addQuestionnaireQuestion({
  questionnaireId,
  title = "New question",
  description = null,
  type = "short_text",
  required = false,
  options = [],
}: {
  questionnaireId: string;
  title?: string;
  description?: string | null;
  type?: string;
  required?: boolean;
  options?: string[];
}) {
  const questionnaire = await db.query.questionnaires.findFirst({
    where: eq(questionnaires.id, questionnaireId),
  });
  if (!questionnaire) {
    throw new Error("Questionnaire not found.");
  }

  const existingQuestions = await listQuestionnaireQuestions(questionnaireId);
  const now = new Date().toISOString();
  const questionId = crypto.randomUUID();
  await db.insert(questionnaireQuestions).values({
    id: questionId,
    questionnaireId,
    title: title.trim() || "New question",
    description: description?.trim() || null,
    type: questionnaireQuestionTypeValue(type),
    required,
    optionsJson: options.length ? JSON.stringify(options.map((option) => option.trim()).filter(Boolean)) : null,
    sortOrder: existingQuestions.length,
    createdAt: now,
    updatedAt: now,
  });

  await db.update(questionnaires)
    .set({ updatedAt: now })
    .where(eq(questionnaires.id, questionnaireId));

  await logActivity({
    action: "questionnaire.question.created",
    metadata: { questionnaireId, questionId },
  });

  return questionId;
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

function isEmptyAnswer(value: QuestionnaireAnswerValue) {
  return Array.isArray(value)
    ? value.length === 0 || value.every((entry) => entry.trim() === "")
    : value.trim() === "";
}

function firstTextAnswer(
  answers: Array<{ title: string; value: QuestionnaireAnswerValue }>,
  matcher: (title: string) => boolean,
) {
  const match = answers.find((answer) => matcher(answer.title.toLowerCase()));
  if (!match || Array.isArray(match.value)) return null;
  const value = match.value.trim();
  return value || null;
}

function cleanTextAnswer(value: QuestionnaireAnswerValue) {
  return Array.isArray(value) ? null : value.trim() || null;
}

function cleanEmailAnswer(value: QuestionnaireAnswerValue) {
  return cleanTextAnswer(value)?.toLowerCase() ?? null;
}

function cleanInstagramAnswer(value: QuestionnaireAnswerValue) {
  const cleaned = cleanTextAnswer(value);
  if (!cleaned) return null;
  return cleaned.startsWith("@") ? cleaned : `@${cleaned}`;
}

function normalizedQuestionTitle(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function questionRoleTokens(title: string) {
  const normalized = normalizedQuestionTitle(title);
  return ["bride", "groom", "partner", "spouse"].filter((token) => normalized.includes(token));
}

function answerAppliesToParticipant(title: string, participantRole: string | null | undefined) {
  const tokens = questionRoleTokens(title);
  if (!tokens.length) return true;

  const normalizedRole = normalizedQuestionTitle(participantRole ?? "");
  return tokens.some((token) => normalizedRole.includes(token));
}

function textAnswerForClient(
  answers: Array<{ title: string; value: QuestionnaireAnswerValue }>,
  participantRole: string | null | undefined,
  matcher: (title: string) => boolean,
) {
  for (const answer of answers) {
    const title = normalizedQuestionTitle(answer.title);
    if (!matcher(title) || !answerAppliesToParticipant(answer.title, participantRole)) continue;
    const value = cleanTextAnswer(answer.value);
    if (value) return value;
  }

  return null;
}

function splitFullName(value: string) {
  const parts = value.split(/\s+/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return { firstName: null, lastName: null };
  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

async function syncQuestionnaireResponseClientProfile({
  response,
  answers,
}: {
  response: typeof questionnaireResponses.$inferSelect;
  answers: Array<{ title: string; value: QuestionnaireAnswerValue }>;
}) {
  if (!response.clientId) return;

  const client = await db.query.clients.findFirst({
    where: eq(clients.id, response.clientId),
  });
  if (!client) return;

  const participant = response.projectId
    ? await db.query.projectParticipants.findFirst({
      where: and(
        eq(projectParticipants.projectId, response.projectId),
        eq(projectParticipants.clientId, response.clientId),
      ),
    })
    : null;
  const participantRole = participant?.role ?? null;

  const instagramHandle = (() => {
    const answer = answers.find((entry) =>
      normalizedQuestionTitle(entry.title).includes("instagram") &&
      answerAppliesToParticipant(entry.title, participantRole));
    return answer ? cleanInstagramAnswer(answer.value) : null;
  })();
  const phone = textAnswerForClient(answers, participantRole, (title) => title.includes("phone"));
  const communicationPreference = textAnswerForClient(
    answers,
    participantRole,
    (title) => title.includes("communication") || title.includes("preferred contact") || title.includes("contact preference"),
  );
  const referralSource = textAnswerForClient(
    answers,
    participantRole,
    (title) => title.includes("referral") || title.includes("how did you hear") || title === "source",
  );
  const preferredName = textAnswerForClient(
    answers,
    participantRole,
    (title) => title.includes("preferred name"),
  );
  const fullName = textAnswerForClient(
    answers,
    participantRole,
    (title) => title.includes("full name") || title === "your names" || title === "your name",
  );
  const email = (() => {
    const answer = answers.find((entry) =>
      normalizedQuestionTitle(entry.title).includes("email") &&
      answerAppliesToParticipant(entry.title, participantRole));
    return answer ? cleanEmailAnswer(answer.value) : null;
  })();

  const updates: Partial<typeof clients.$inferInsert> = {};
  if (instagramHandle && instagramHandle !== client.instagramHandle) updates.instagramHandle = instagramHandle;
  if (phone && phone !== client.phone) updates.phone = phone;
  if (communicationPreference && communicationPreference !== client.communicationPreference) updates.communicationPreference = communicationPreference;
  if (referralSource && referralSource !== client.referralSource) updates.referralSource = referralSource;
  if (preferredName && preferredName !== client.preferredName) updates.preferredName = preferredName;

  if (fullName) {
    const parsedName = splitFullName(fullName);
    if (parsedName.firstName && !client.firstName) updates.firstName = parsedName.firstName;
    if (parsedName.lastName && !client.lastName) updates.lastName = parsedName.lastName;
    if (!updates.preferredName && !client.preferredName) updates.preferredName = fullName;
  }

  if (email && email !== client.email) {
    const existingEmailClient = await db.query.clients.findFirst({
      where: eq(clients.email, email),
    });
    if (!existingEmailClient || existingEmailClient.id === client.id) {
      updates.email = email;
    }
  }

  const changedFields = Object.entries(updates)
    .filter(([key, value]) => key !== "updatedAt" && client[key as keyof typeof client] !== value)
    .map(([key]) => key);
  if (!changedFields.length) return;

  const now = new Date().toISOString();
  await db.update(clients)
    .set({ ...updates, updatedAt: now })
    .where(eq(clients.id, client.id));

  await logActivity({
    action: "client.profile_synced_from_questionnaire",
    projectId: response.projectId || undefined,
    clientId: client.id,
    actorType: "system",
    actorName: "The Reeses Studio",
    metadata: {
      questionnaireId: response.questionnaireId,
      responseId: response.id,
      changedFields,
    },
  });
}

function textAnswerForProject(
  answers: Array<{ title: string; value: QuestionnaireAnswerValue }>,
  matcher: (title: string) => boolean,
) {
  for (const answer of answers) {
    const title = normalizedQuestionTitle(answer.title);
    if (!matcher(title)) continue;
    const value = cleanTextAnswer(answer.value);
    if (value) return value;
  }

  return null;
}

function dateAnswerForProject(
  answers: Array<{ title: string; value: QuestionnaireAnswerValue }>,
  matcher: (title: string) => boolean,
) {
  const value = textAnswerForProject(answers, matcher);
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

function normalizedLocationName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function splitLocationAnswer(value: string) {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] ?? value.trim();
  const addressLines = lines.slice(1);
  const inlineAddress = firstLine.match(/\b\d{1,6}\s+.+/)?.[0] ?? null;

  return {
    name: inlineAddress && inlineAddress === firstLine ? "Project location" : firstLine,
    address: addressLines.length ? addressLines.join(", ") : inlineAddress,
    notes: lines.length > 1 ? value.trim() : null,
  };
}

function questionnaireLocationType(title: string) {
  const normalized = normalizedQuestionTitle(title);
  if (normalized.startsWith("getting ready location")) return "getting_ready";
  if (normalized.startsWith("reception location")) return "reception";
  if (normalized.startsWith("ceremony location")) return "ceremony";
  if (
    normalized.startsWith("do you have a specific location") ||
    normalized.startsWith("portrait location") ||
    normalized.startsWith("first look location") ||
    normalized.startsWith("family formal location")
  ) return "portrait";
  if (normalized.startsWith("after party location")) return "after_party";
  if (normalized.startsWith("are there any other locations") || normalized.startsWith("other locations")) return "other";
  return null;
}

function questionnaireLocationLabel(title: string, type: string) {
  const normalized = normalizedQuestionTitle(title);
  if (type === "getting_ready" && normalized.includes("bride")) return "Bride getting ready";
  if (type === "getting_ready" && normalized.includes("groom")) return "Groom getting ready";
  if (type === "ceremony") return "Ceremony";
  if (type === "reception") return "Reception";
  if (type === "portrait") return "Portrait location";
  if (type === "after_party") return "After party";
  return "Other locations";
}

function questionnaireLocationInputs(answers: Array<{ title: string; value: QuestionnaireAnswerValue }>) {
  const inputs: Array<{
    type: string;
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
    notes: string | null;
  }> = [];

  for (const answer of answers) {
    const type = questionnaireLocationType(answer.title);
    const value = cleanTextAnswer(answer.value);
    if (!type || !value) continue;

    const normalizedValue = normalizedLocationName(value);
    if (!normalizedValue || normalizedValue === "na" || normalizedValue === "n a" || normalizedValue === "none" || normalizedValue === "same as ceremony") continue;

    if (type === "other") {
      inputs.push({
        type,
        name: questionnaireLocationLabel(answer.title, type),
        address: null,
        city: null,
        state: null,
        notes: value,
      });
      continue;
    }

    const parsed = splitLocationAnswer(value);
    const label = questionnaireLocationLabel(answer.title, type);
    const name = type === "getting_ready" && label !== "Other locations"
      ? `${label}: ${parsed.name}`
      : parsed.name;
    inputs.push({
      type,
      name: name || label,
      address: parsed.address,
      city: null,
      state: null,
      notes: parsed.notes,
    });
  }

  return inputs;
}

async function syncQuestionnaireResponseProjectLocations({
  response,
  answers,
}: {
  response: typeof questionnaireResponses.$inferSelect;
  answers: Array<{ title: string; value: QuestionnaireAnswerValue }>;
}) {
  if (!response.projectId || !response.submittedAt) return;

  const locations = questionnaireLocationInputs(answers);
  if (!locations.length) return;

  const now = new Date().toISOString();
  const existing = await db.query.projectLocations.findMany({
    where: (location, { eq }) => eq(location.projectId, response.projectId as string),
  });

  for (const location of locations) {
    const existingLocation = existing.find((entry) =>
      entry.sourceType === "questionnaire_response" &&
      entry.sourceId === response.id &&
      entry.type === location.type &&
      normalizedLocationName(entry.name) === normalizedLocationName(location.name));

    if (existingLocation) {
      await db.update(projectLocations)
        .set({
          name: location.name,
          address: location.address,
          city: location.city,
          state: location.state,
          notes: location.notes,
          updatedAt: now,
        })
        .where(eq(projectLocations.id, existingLocation.id));
      continue;
    }

    await db.insert(projectLocations).values({
      id: crypto.randomUUID(),
      projectId: response.projectId,
      type: location.type,
      name: location.name,
      address: location.address,
      city: location.city,
      state: location.state,
      notes: location.notes,
      sourceType: "questionnaire_response",
      sourceId: response.id,
      createdAt: now,
      updatedAt: now,
    });
  }

  await logActivity({
    action: "project.locations_synced_from_questionnaire",
    projectId: response.projectId,
    clientId: response.clientId || undefined,
    actorType: "system",
    actorName: "The Reeses Studio",
    metadata: {
      questionnaireId: response.questionnaireId,
      responseId: response.id,
      locationCount: locations.length,
    },
  });
}

function questionnaireWeddingDayEventNotes(answers: Array<{ title: string; value: QuestionnaireAnswerValue }>) {
  const sections: string[] = [];
  const usefulAnswers: Array<[string, (title: string) => boolean]> = [
    ["Ceremony time", (title) => title.includes("ceremony begin") || title.includes("ceremony lasting")],
    ["Ceremony notes", (title) => title.includes("special") && title.includes("ceremony")],
    ["Photography restrictions", (title) => title.includes("photography rules") || title.includes("photography restrictions")],
    ["Cocktail hour", (title) => title.includes("cocktail hour scheduled")],
    ["Reception start", (title) => title.includes("reception begin") || title.includes("planning on doing an entrance")],
    ["Reception flow", (title) => title.includes("reception events") || title.includes("flow of the reception")],
    ["Formal exit", (title) => title.includes("formal exit")],
    ["Other locations / flow", (title) => title.includes("other locations for the day")],
  ];

  for (const [label, matcher] of usefulAnswers) {
    const answer = textAnswerForProject(answers, matcher);
    if (!answer) continue;
    sections.push(`${label}:\n${answer}`);
  }

  return sections.length ? sections.join("\n\n") : null;
}

async function syncQuestionnaireResponseProjectEvent({
  response,
  answers,
}: {
  response: typeof questionnaireResponses.$inferSelect;
  answers: Array<{ title: string; value: QuestionnaireAnswerValue }>;
}) {
  if (!response.projectId || !response.submittedAt) return;

  const notes = questionnaireWeddingDayEventNotes(answers);
  if (!notes) return;

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, response.projectId),
  });
  if (!project) return;

  const now = new Date().toISOString();
  const existingEvents = await db.query.projectEvents.findMany({
    where: eq(projectEvents.projectId, response.projectId),
    orderBy: asc(projectEvents.createdAt),
  });
  const event = existingEvents.find((entry) => entry.title.toLowerCase() === "wedding day")
    ?? existingEvents.find((entry) => entry.type === "wedding")
    ?? existingEvents[0]
    ?? null;

  const updates = {
    type: event?.type || project.type || "wedding",
    title: event?.title || "Wedding day",
    eventDate: event?.eventDate || project.eventDate,
    venueName: event?.venueName || project.venueName,
    venueAddress: event?.venueAddress || project.venueAddress,
    city: event?.city || project.city,
    state: event?.state || project.state,
    calendarSyncStatus: event?.calendarSyncStatus || (project.eventDate ? "needs_google_connection" : "not_connected"),
    notes,
    sourceType: "questionnaire_response",
    sourceId: response.id,
    updatedAt: now,
  };

  if (event) {
    await db.update(projectEvents)
      .set(updates)
      .where(eq(projectEvents.id, event.id));
  } else {
    await db.insert(projectEvents).values({
      id: crypto.randomUUID(),
      projectId: response.projectId,
      ...updates,
      createdAt: now,
    });
  }

  await logActivity({
    action: "project.event_synced_from_questionnaire",
    projectId: response.projectId,
    clientId: response.clientId || undefined,
    actorType: "system",
    actorName: "The Reeses Studio",
    metadata: {
      questionnaireId: response.questionnaireId,
      responseId: response.id,
      eventTitle: updates.title,
    },
  });
}

async function syncQuestionnaireResponseProjectProfile({
  response,
  answers,
}: {
  response: typeof questionnaireResponses.$inferSelect;
  answers: Array<{ title: string; value: QuestionnaireAnswerValue }>;
}) {
  if (!response.projectId) return;

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, response.projectId),
  });
  if (!project) return;

  const eventDate = !project.eventDate
    ? dateAnswerForProject(
      answers,
      (title) => title.includes("wedding date") || title.includes("event date") || title === "date",
    )
    : null;
  const venueName = textAnswerForProject(
    answers,
    (title) => (title.includes("venue") || title.includes("location")) && !title.includes("address"),
  );
  const venueAddress = textAnswerForProject(
    answers,
    (title) => title.includes("venue address") || title === "address" || title.includes("location address"),
  );
  const city = textAnswerForProject(
    answers,
    (title) => title.includes("wedding city") || title.includes("event city") || title === "city",
  );
  const state = textAnswerForProject(
    answers,
    (title) => title.includes("wedding state") || title.includes("event state") || title === "state",
  );

  const updates: Partial<typeof projects.$inferInsert> = {};
  if (eventDate && eventDate !== project.eventDate) {
    updates.eventDate = eventDate;
    updates.calendarSyncStatus = projectEventCalendarStatusAfterEdit({
      eventDate,
      googleCalendarEventId: project.googleCalendarEventId,
    });
  }
  if (venueName && venueName !== project.venueName) updates.venueName = venueName;
  if (venueAddress && venueAddress !== project.venueAddress) updates.venueAddress = venueAddress;
  if (city && city !== project.city) updates.city = city;
  if (state && state !== project.state) updates.state = state;

  const changedFields = Object.entries(updates)
    .filter(([key, value]) => key !== "updatedAt" && project[key as keyof typeof project] !== value)
    .map(([key]) => key);
  if (!changedFields.length) return;

  const now = new Date().toISOString();
  await db.update(projects)
    .set({ ...updates, updatedAt: now })
    .where(eq(projects.id, project.id));

  await logActivity({
    action: "project.profile_synced_from_questionnaire",
    projectId: project.id,
    clientId: response.clientId || undefined,
    actorType: "system",
    actorName: "The Reeses Studio",
    metadata: {
      questionnaireId: response.questionnaireId,
      responseId: response.id,
      changedFields,
    },
  });
}

function validateAnswerPayload(answer: { title: string; value: QuestionnaireAnswerValue }) {
  if (Array.isArray(answer.value)) {
    for (const entry of answer.value) {
      if (entry.length > maxCheckboxValueLength) {
        throw new Error(`Answer choice too long for "${answer.title}".`);
      }
    }
    return;
  }

  if (answer.value.length > maxAnswerLength) {
    throw new Error(`Answer too long for "${answer.title}".`);
  }
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

function buildStoredAnswers(
  questions: Awaited<ReturnType<typeof listQuestionnaireQuestions>>,
  values: QuestionnaireAnswerInput,
) {
  return questions
    .filter((question) => question.type !== "section")
    .map((question) => {
      const rawValue = values[question.id];
      const value = question.type === "checkboxes"
        ? (Array.isArray(rawValue) ? rawValue : rawValue ? [rawValue] : []).map((entry) => String(entry).trim()).filter(Boolean)
        : String(Array.isArray(rawValue) ? rawValue[0] ?? "" : rawValue ?? "").trim();

      return {
        questionId: question.id,
        title: question.title,
        type: question.type,
        required: question.required,
        value,
      };
    });
}

function questionnaireSourceBody(answers: StoredQuestionnaireAnswer[]) {
  const answered = answers
    .filter((answer) => answer.type !== "section")
    .map((answer) => {
      const title = String(answer.title ?? "Untitled question").trim() || "Untitled question";
      return `## ${title}\n${formatQuestionnaireAnswerValue(answer.value)}`;
    });

  return answered.length ? answered.join("\n\n") : "No questionnaire answers recorded.";
}

async function syncQuestionnaireResponseProjectSource({
  response,
  questionnaireTitle,
  answers,
  submittedAt,
}: {
  response: typeof questionnaireResponses.$inferSelect;
  questionnaireTitle: string;
  answers: StoredQuestionnaireAnswer[];
  submittedAt: string | null;
}) {
  if (!response.projectId || !submittedAt) return;

  const now = new Date().toISOString();
  const title = `Questionnaire: ${questionnaireTitle}`;
  const body = questionnaireSourceBody(answers);
  const answeredCount = answers.filter((answer) => answer.type !== "section" && formatQuestionnaireAnswerValue(answer.value) !== "No answer").length;
  const summary = `${answeredCount} answered question${answeredCount === 1 ? "" : "s"} from ${response.respondentName || response.respondentEmail || "client questionnaire"}.`;
  const metadata = {
    questionnaireId: response.questionnaireId,
    responseId: response.id,
    clientId: response.clientId,
    respondentName: response.respondentName,
    respondentEmail: response.respondentEmail,
    submittedAt,
    answeredCount,
  };

  const existing = await db.query.projectSources.findFirst({
    where: (source, { and, eq }) => and(
      eq(source.projectId, response.projectId as string),
      eq(source.sourceType, "questionnaire_response"),
      eq(source.sourceId, response.id),
    ),
  });

  if (existing) {
    await db.update(projectSources)
      .set({
        title,
        body,
        summary,
        occurredAt: submittedAt,
        capturedBy: "Studio Questionnaire",
        metadataJson: JSON.stringify(metadata),
        updatedAt: now,
      })
      .where(eq(projectSources.id, existing.id));
    return;
  }

  await db.insert(projectSources).values({
    id: crypto.randomUUID(),
    projectId: response.projectId,
    kind: "questionnaire_response",
    title,
    body,
    summary,
    occurredAt: submittedAt,
    externalUrl: null,
    capturedBy: "Studio Questionnaire",
    sourceType: "questionnaire_response",
    sourceId: response.id,
    metadataJson: JSON.stringify(metadata),
    createdAt: now,
    updatedAt: now,
  });
}

export async function backfillSubmittedQuestionnaireResponseSources() {
  const rows = await db
    .select({
      response: questionnaireResponses,
      questionnaireTitle: questionnaires.title,
    })
    .from(questionnaireResponses)
    .innerJoin(questionnaires, eq(questionnaireResponses.questionnaireId, questionnaires.id))
    .where(and(
      isNotNull(questionnaireResponses.submittedAt),
      isNotNull(questionnaireResponses.projectId),
    ));

  let syncedCount = 0;
  for (const row of rows) {
    const before = await db.query.projectSources.findFirst({
      where: (source, { and, eq }) => and(
        eq(source.projectId, row.response.projectId as string),
        eq(source.sourceType, "questionnaire_response"),
        eq(source.sourceId, row.response.id),
      ),
    });

    await syncQuestionnaireResponseProjectSource({
      response: row.response,
      questionnaireTitle: row.questionnaireTitle,
      answers: parseQuestionnaireAnswers(row.response.answersJson),
      submittedAt: row.response.submittedAt,
    });
    const parsedAnswers = parseQuestionnaireAnswers(row.response.answersJson);
    const typedAnswers = parsedAnswers.map((answer) => ({
      title: String(answer.title ?? ""),
      value: Array.isArray(answer.value)
        ? answer.value.map((entry) => String(entry))
        : String(answer.value ?? ""),
    }));

    await syncQuestionnaireResponseProjectLocations({
      response: row.response,
      answers: typedAnswers,
    });
    await syncQuestionnaireResponseProjectEvent({
      response: row.response,
      answers: typedAnswers,
    });

    const after = await db.query.projectSources.findFirst({
      where: (source, { and, eq }) => and(
        eq(source.projectId, row.response.projectId as string),
        eq(source.sourceType, "questionnaire_response"),
        eq(source.sourceId, row.response.id),
      ),
    });
    if (!before && after) syncedCount += 1;
  }

  return {
    checkedCount: rows.length,
    syncedCount,
  };
}

function answerInputsFromFormData(
  formData: FormData,
  questions: Awaited<ReturnType<typeof listQuestionnaireQuestions>>,
) {
  return Object.fromEntries(
    questions
      .filter((question) => question.type !== "section")
      .map((question) => [
        question.id,
        question.type === "checkboxes"
          ? formData.getAll(question.id).map((entry) => String(entry).trim()).filter(Boolean)
          : String(formData.get(question.id) ?? "").trim(),
      ]),
  ) as QuestionnaireAnswerInput;
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

  const responseProjectSource = response.projectId
    ? await db.query.projectSources.findFirst({
        where: and(
          eq(projectSources.projectId, response.projectId),
          eq(projectSources.sourceType, "questionnaire_response"),
          eq(projectSources.sourceId, response.id),
        ),
      })
    : null;
  const questions = await listQuestionnaireQuestions(response.questionnaireId);
  const storedAnswers = parseQuestionnaireAnswers(response.answersJson);
  const answersByQuestionId = new Map(storedAnswers.map((answer) => [answer.questionId, answer]));
  const answersByTitle = new Map(storedAnswers.map((answer) => [answer.title, answer]));

  return {
    response: {
      ...response,
      projectSourceId: responseProjectSource?.id ?? null,
    },
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

export async function createProjectQuestionnaireResponseDraft({
  questionnaireId,
  projectId,
  clientId,
}: {
  questionnaireId: string;
  projectId: string;
  clientId?: string | null;
}) {
  const [questionnaire, project, client] = await Promise.all([
    db.query.questionnaires.findFirst({ where: eq(questionnaires.id, questionnaireId) }),
    db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
    clientId ? db.query.clients.findFirst({ where: eq(clients.id, clientId) }) : Promise.resolve(null),
  ]);

  if (!questionnaire) throw new Error("Questionnaire not found.");
  if (!project) throw new Error("Project not found.");
  if (clientId && !client) throw new Error("Client not found.");
  if (clientId) {
    const participant = await db.query.projectParticipants.findFirst({
      where: and(eq(projectParticipants.projectId, projectId), eq(projectParticipants.clientId, clientId)),
    });
    if (!participant) throw new Error("Questionnaire client is not linked to this project.");
  }

  const existingResponse = await db.query.questionnaireResponses.findFirst({
    where: and(
      eq(questionnaireResponses.questionnaireId, questionnaireId),
      eq(questionnaireResponses.projectId, projectId),
      clientId ? eq(questionnaireResponses.clientId, clientId) : isNull(questionnaireResponses.clientId),
    ),
    orderBy: desc(questionnaireResponses.updatedAt),
  });

  if (existingResponse) return existingResponse.id;

  const now = new Date().toISOString();
  const responseId = crypto.randomUUID();
  const respondentName = client ? [client.firstName, client.lastName].filter(Boolean).join(" ") || client.preferredName : null;

  await db.insert(questionnaireResponses).values({
    id: responseId,
    questionnaireId,
    projectId,
    clientId: clientId || null,
    respondentName,
    respondentEmail: client?.email ?? null,
    submittedAt: null,
    sourceResponseId: null,
    answersJson: "[]",
    createdAt: now,
    updatedAt: now,
  });

  await logActivity({
    action: "questionnaire.response.draft_created",
    projectId,
    clientId: clientId || undefined,
    metadata: { questionnaireId, responseId },
  });

  return responseId;
}

export async function createQuestionnaireLinkFromAgent(
  projectId: string,
  input: AgentQuestionnaireLinkInput,
): Promise<AgentQuestionnaireLink> {
  const questionnaireId = input.questionnaireId?.trim();
  if (!questionnaireId) {
    throw new Error("Questionnaire is required.");
  }

  const clientId = input.clientId?.trim() || null;
  const [questionnaire, project, client] = await Promise.all([
    db.query.questionnaires.findFirst({ where: eq(questionnaires.id, questionnaireId) }),
    db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
    clientId ? db.query.clients.findFirst({ where: eq(clients.id, clientId) }) : Promise.resolve(null),
  ]);

  if (!questionnaire || questionnaire.status !== "active") {
    throw new Error("Questionnaire is unavailable.");
  }
  if (!project) {
    throw new Error("Project not found.");
  }
  if (clientId && !client) {
    throw new Error("Client not found.");
  }
  if (clientId) {
    const participant = await db.query.projectParticipants.findFirst({
      where: and(eq(projectParticipants.projectId, projectId), eq(projectParticipants.clientId, clientId)),
    });
    if (!participant) {
      throw new Error("Questionnaire client is not linked to this project.");
    }
  }

  const context = createQuestionnaireContext(questionnaireId, projectId, clientId);
  const [encodedContext] = context.split(".");
  const decoded = JSON.parse(Buffer.from(encodedContext, "base64url").toString("utf8")) as { expiresAt: string };
  const link = {
    questionnaireId,
    projectId,
    clientId,
    questionnaireUrl: getQuestionnairePublicUrl(questionnaireId, context),
    timelineCallUrl: getTimelineQuestionnaireCallUrl(projectId, clientId),
    expiresAt: decoded.expiresAt,
  };

  await logActivity({
    action: "questionnaire.link_created_by_agent",
    projectId,
    clientId: clientId || undefined,
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
    metadata: { questionnaireId, expiresAt: link.expiresAt },
  });

  return link;
}

export async function updateQuestionnaireResponseAnswers({
  responseId,
  answers,
  submit = false,
}: {
  responseId: string;
  answers: QuestionnaireAnswerInput;
  submit?: boolean;
}) {
  const response = await db.query.questionnaireResponses.findFirst({
    where: eq(questionnaireResponses.id, responseId),
  });
  if (!response) throw new Error("Questionnaire response not found.");

  const questions = await listQuestionnaireQuestions(response.questionnaireId);
  const storedAnswers = buildStoredAnswers(questions, answers);
  const missingRequired = submit ? storedAnswers.filter((answer) => answer.required && isEmptyAnswer(answer.value)) : [];
  if (missingRequired.length > 0) {
    throw new Error("Please complete all required questions before marking this response submitted.");
  }

  for (const answer of storedAnswers) {
    validateAnswerPayload(answer);
  }

  const serializedAnswers = JSON.stringify(storedAnswers);
  if (serializedAnswers.length > maxSerializedAnswersLength) {
    throw new Error("Answer payload is too large. Please shorten the responses and try again.");
  }

  const now = new Date().toISOString();
  const client = response.clientId
    ? await db.query.clients.findFirst({ where: eq(clients.id, response.clientId) })
    : null;
  const respondentName =
    firstTextAnswer(storedAnswers, (title) => title.includes("full name") || title === "your names") ||
    response.respondentName ||
    (client ? [client.firstName, client.lastName].filter(Boolean).join(" ") || client.preferredName : null);
  const respondentEmail =
    firstTextAnswer(storedAnswers, (title) => title.includes("email")) ||
    response.respondentEmail ||
    client?.email ||
    null;

  const submittedAt = submit ? response.submittedAt ?? now : response.submittedAt;

  await db.update(questionnaireResponses)
    .set({
      respondentName,
      respondentEmail,
      submittedAt,
      answersJson: serializedAnswers,
      updatedAt: now,
    })
    .where(eq(questionnaireResponses.id, responseId));

  const questionnaire = await db.query.questionnaires.findFirst({
    where: eq(questionnaires.id, response.questionnaireId),
  });
  if (questionnaire) {
    await syncQuestionnaireResponseProjectSource({
      response: {
        ...response,
        respondentName,
        respondentEmail,
        submittedAt,
        answersJson: serializedAnswers,
        updatedAt: now,
      },
      questionnaireTitle: questionnaire.title,
      answers: storedAnswers,
      submittedAt,
    });
  }
  await syncQuestionnaireResponseProjectProfile({
    response: {
      ...response,
      respondentName,
      respondentEmail,
      submittedAt,
      answersJson: serializedAnswers,
      updatedAt: now,
    },
    answers: storedAnswers,
  });
  await syncQuestionnaireResponseProjectLocations({
    response: {
      ...response,
      respondentName,
      respondentEmail,
      submittedAt,
      answersJson: serializedAnswers,
      updatedAt: now,
    },
    answers: storedAnswers,
  });
  await syncQuestionnaireResponseProjectEvent({
    response: {
      ...response,
      respondentName,
      respondentEmail,
      submittedAt,
      answersJson: serializedAnswers,
      updatedAt: now,
    },
    answers: storedAnswers,
  });
  await syncQuestionnaireResponseClientProfile({
    response: {
      ...response,
      respondentName,
      respondentEmail,
      submittedAt,
      answersJson: serializedAnswers,
      updatedAt: now,
    },
    answers: storedAnswers,
  });

  await logActivity({
    action: submit ? "questionnaire.response.submitted" : "questionnaire.response.edited",
    projectId: response.projectId || undefined,
    clientId: response.clientId || undefined,
    metadata: { questionnaireId: response.questionnaireId, responseId },
  });

  return responseId;
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
  const projectId = String(formData.get("projectId") ?? "").trim();
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
  if (projectId) revalidatePath(`/projects/${projectId}`);
  redirect(questionnaireEditorPath(questionnaireId, projectId));
}

export async function createQuestionnaireAction(formData: FormData) {
  "use server";

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const status = String(formData.get("status") ?? "draft");
  const projectId = String(formData.get("projectId") ?? "").trim();
  const questionnaireId = await createQuestionnaireTemplate({
    title,
    description,
    status,
  });

  revalidatePath("/questionnaires");
  if (projectId) revalidatePath(`/projects/${projectId}`);

  redirect(questionnaireEditorPath(questionnaireId, projectId));
}

export async function createProjectQuestionnaireResponseAction(formData: FormData) {
  "use server";

  const questionnaireId = String(formData.get("questionnaireId") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();
  const clientId = String(formData.get("clientId") ?? "").trim();
  if (!questionnaireId || !projectId) {
    throw new Error("Questionnaire and project are required.");
  }

  const responseId = await createProjectQuestionnaireResponseDraft({
    questionnaireId,
    projectId,
    clientId: clientId || null,
  });

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/questionnaires/${questionnaireId}/responses`);
  redirect(`/questionnaires/${questionnaireId}/responses/${responseId}/edit`);
}

export async function updateQuestionnaireResponseAction(formData: FormData) {
  "use server";

  const responseId = String(formData.get("responseId") ?? "").trim();
  const questionnaireId = String(formData.get("questionnaireId") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();
  const intent = String(formData.get("intent") ?? "save");
  if (!responseId || !questionnaireId) {
    throw new Error("Questionnaire response is required.");
  }

  const questions = await listQuestionnaireQuestions(questionnaireId);
  await updateQuestionnaireResponseAnswers({
    responseId,
    answers: answerInputsFromFormData(formData, questions),
    submit: intent === "submit",
  });

  revalidatePath("/questionnaires");
  revalidatePath(`/questionnaires/${questionnaireId}`);
  revalidatePath(`/questionnaires/${questionnaireId}/responses`);
  revalidatePath(`/questionnaires/${questionnaireId}/responses/${responseId}`);
  if (projectId) revalidatePath(`/projects/${projectId}`);

  const saved = intent === "submit" ? "submitted" : "response";
  redirect(`/questionnaires/${questionnaireId}/responses/${responseId}/edit?saved=${saved}`);
}

export async function updateQuestionnaireQuestionAction(formData: FormData) {
  "use server";

  const questionnaireId = String(formData.get("questionnaireId") ?? "");
  const questionId = String(formData.get("questionId") ?? "");
  const projectId = String(formData.get("projectId") ?? "").trim();
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

  const existingQuestion = await db.query.questionnaireQuestions.findFirst({
    where: eq(questionnaireQuestions.id, questionId),
  });
  if (!existingQuestion) {
    throw new Error("Question not found.");
  }
  if (existingQuestion.questionnaireId !== questionnaireId) {
    throw new Error("Question does not belong to this questionnaire.");
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

  safeRevalidatePath(`/questionnaires/${questionnaireId}`);
  safeRevalidatePath(`/questionnaires/${questionnaireId}/preview`);
  if (projectId) safeRevalidatePath(`/projects/${projectId}`);
}

export async function addQuestionnaireQuestionAction(formData: FormData) {
  "use server";

  const questionnaireId = String(formData.get("questionnaireId") ?? "");
  const projectId = String(formData.get("projectId") ?? "").trim();
  const title = String(formData.get("title") ?? "New question").trim();
  const type = String(formData.get("type") ?? "short_text");

  if (!questionnaireId) {
    throw new Error("Questionnaire is required.");
  }

  await addQuestionnaireQuestion({
    questionnaireId,
    title,
    type,
  });

  revalidatePath(`/questionnaires/${questionnaireId}`);
  revalidatePath(`/questionnaires/${questionnaireId}/preview`);
  if (projectId) revalidatePath(`/projects/${projectId}`);
  redirect(questionnaireEditorPath(questionnaireId, projectId));
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

  const existingQuestions = await db.query.questionnaireQuestions.findMany({
    where: eq(questionnaireQuestions.questionnaireId, questionnaireId),
  });
  const ownedQuestionIds = new Set(existingQuestions.map((question) => question.id));
  if (
    existingQuestions.length === 0 ||
    orderedIds.length !== ownedQuestionIds.size ||
    orderedIds.some((questionId) => !ownedQuestionIds.has(questionId))
  ) {
    throw new Error("Question order includes a question outside this questionnaire.");
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

  safeRevalidatePath(`/questionnaires/${questionnaireId}`);
  safeRevalidatePath(`/questionnaires/${questionnaireId}/preview`);
}

export async function refreshWeddingTimelineQuestionnaireAction() {
  "use server";

  await refreshWeddingTimelineQuestionnaire();
  revalidatePath("/questionnaires");
  redirect("/questionnaires");
}
