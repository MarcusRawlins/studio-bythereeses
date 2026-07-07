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
import {
  keywordAnswers,
  resolveSemanticValue,
  type SemanticAnswer,
  type SemanticKey,
} from "@/lib/questionnaire-semantic-keys";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
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

// -----------------------------------------------------------------------------
// Phase 23 (CR-5) — autofill review-and-apply proposal shapes (spec §3/§4).
//
// Each of the four canonical syncs below is split into a PURE compute half
// (returns FieldChange[] / LocationChange[], never writes) and an apply half
// (performs the db.update/insert for accepted, non-stale fields). Flag OFF calls
// compute() then apply()-with-everything-accepted in the same request (today's
// behavior, I1); flag ON stores the compute result as a proposal and defers
// apply to the admin action in questionnaire-autofill.ts. This keeps exactly
// ONE extraction implementation for both paths.
// -----------------------------------------------------------------------------
export type FieldChange = {
  field: string;
  current: string | null;
  proposed: string;
  questionTitle: string;
  semanticKey?: string;
};

export type LocationChange = {
  action: "create" | "update";
  type: string;
  proposed: {
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
    notes: string | null;
  };
  current?: {
    name: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    notes: string | null;
  };
  existingId?: string;
};

export type FieldApplyOutcome = {
  applied: string[];
  alreadyApplied: string[];
  skipped: Array<{ field: string; reason: string }>;
};

export type QuestionnaireAutofillActor = {
  actorType: "admin" | "system";
  actorName: string;
};

const PROJECT_PROFILE_FIELD_ALLOWLIST = new Set(["eventDate", "venueName", "venueAddress", "city", "state"]);
const CLIENT_PROFILE_FIELD_ALLOWLIST = new Set([
  "instagramHandle",
  "phone",
  "communicationPreference",
  "referralSource",
  "preferredName",
  "firstName",
  "lastName",
  "email",
]);
const PROJECT_EVENT_FIELD_ALLOWLIST = new Set(["notes"]);

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

// Semantic-first match against a client field: try the keyed answer first (role
// scoping preserved, M8), falling back to the ORIGINAL, unchanged
// `textAnswerForClient` keyword matcher restricted to keyword-eligible answers
// (keyed answers excluded from the keyword scan, M8 rule 1). Reuses
// `textAnswerForClient` as the value-extraction authority so the computed value
// is byte-identical to today's whether or not a semantic key is involved.
function clientTextAnswerField(
  answers: SemanticAnswer[],
  semanticKey: SemanticKey,
  participantRole: string | null | undefined,
  matcher: (title: string) => boolean,
): { value: string; title: string; semanticKey?: string } | null {
  const semanticRaw = resolveSemanticValue(answers, semanticKey, participantRole);
  if (semanticRaw !== null) {
    const cleaned = cleanTextAnswer(semanticRaw);
    if (cleaned) {
      const source = answers.find((answer) => answer.semanticKey === semanticKey);
      return { value: cleaned, title: source?.title ?? "", semanticKey };
    }
  }

  const eligible = keywordAnswers(answers);
  const value = textAnswerForClient(eligible, participantRole, matcher);
  if (!value) return null;
  const source = eligible.find((answer) =>
    matcher(normalizedQuestionTitle(answer.title)) &&
    answerAppliesToParticipant(answer.title, participantRole) &&
    cleanTextAnswer(answer.value) === value);
  return { value, title: source?.title ?? "" };
}

// Same idea for the `answers.find(...)` + custom-clean fields (instagram/email)
// the original sync computed inline rather than via `textAnswerForClient`.
function clientDirectAnswerField(
  answers: SemanticAnswer[],
  semanticKey: SemanticKey,
  participantRole: string | null | undefined,
  matcher: (title: string) => boolean,
  clean: (value: QuestionnaireAnswerValue) => string | null,
): { value: string; title: string; semanticKey?: string } | null {
  const semanticRaw = resolveSemanticValue(answers, semanticKey, participantRole);
  if (semanticRaw !== null) {
    const cleaned = clean(semanticRaw);
    if (cleaned) {
      const source = answers.find((answer) => answer.semanticKey === semanticKey);
      return { value: cleaned, title: source?.title ?? "", semanticKey };
    }
  }

  const eligible = keywordAnswers(answers);
  const match = eligible.find((entry) =>
    matcher(normalizedQuestionTitle(entry.title)) &&
    answerAppliesToParticipant(entry.title, participantRole));
  if (!match) return null;
  const cleaned = clean(match.value);
  return cleaned ? { value: cleaned, title: match.title } : null;
}

/**
 * Compute half of the client-profile sync (§4). Pure — no DB reads/writes.
 * `client`/`participantRole` are pre-fetched by the caller. Returns the exact
 * same diffs the original direct-write sync computed (byte-for-byte, I1),
 * plus semantic-key-first resolution (§5) when a question carries one.
 */
export function computeClientProfileChanges({
  response,
  client,
  participantRole,
  answers,
}: {
  response: { clientId: string | null };
  client: typeof clients.$inferSelect | null;
  participantRole: string | null | undefined;
  answers: SemanticAnswer[];
}): FieldChange[] {
  if (!response.clientId || !client) return [];

  const changes: FieldChange[] = [];
  const push = (field: string, proposed: string | null, current: string | null, match: { title: string; semanticKey?: string } | null) => {
    if (!proposed || proposed === current) return;
    changes.push({ field, current, proposed, questionTitle: match?.title ?? "", semanticKey: match?.semanticKey });
  };

  const instagram = clientDirectAnswerField(answers, "client_instagram", participantRole, (title) => title.includes("instagram"), cleanInstagramAnswer);
  push("instagramHandle", instagram?.value ?? null, client.instagramHandle, instagram);

  const phone = clientTextAnswerField(answers, "client_phone", participantRole, (title) => title.includes("phone"));
  push("phone", phone?.value ?? null, client.phone, phone);

  const communicationPreference = clientTextAnswerField(
    answers,
    "communication_preference",
    participantRole,
    (title) => title.includes("communication") || title.includes("preferred contact") || title.includes("contact preference"),
  );
  push("communicationPreference", communicationPreference?.value ?? null, client.communicationPreference, communicationPreference);

  const referralSource = clientTextAnswerField(
    answers,
    "referral_source",
    participantRole,
    (title) => title.includes("referral") || title.includes("how did you hear") || title === "source",
  );
  push("referralSource", referralSource?.value ?? null, client.referralSource, referralSource);

  // No semantic key for "preferred name" in the §5 vocabulary — keyword-only,
  // still excluded-from-keyword-scan for any OTHER keyed answer (M8 rule 1).
  const eligibleForPreferredName = keywordAnswers(answers);
  const preferredName = textAnswerForClient(eligibleForPreferredName, participantRole, (title) => title.includes("preferred name"));
  push("preferredName", preferredName, client.preferredName, preferredName ? { title: "Preferred name" } : null);

  const fullName = clientTextAnswerField(
    answers,
    "client_full_name",
    participantRole,
    (title) => title.includes("full name") || title === "your names" || title === "your name",
  );
  if (fullName?.value) {
    const parsedName = splitFullName(fullName.value);
    if (parsedName.firstName && !client.firstName) {
      changes.push({ field: "firstName", current: client.firstName, proposed: parsedName.firstName, questionTitle: fullName.title, semanticKey: fullName.semanticKey });
    }
    if (parsedName.lastName && !client.lastName) {
      changes.push({ field: "lastName", current: client.lastName, proposed: parsedName.lastName, questionTitle: fullName.title, semanticKey: fullName.semanticKey });
    }
    const preferredNameAlreadyProposed = changes.some((change) => change.field === "preferredName");
    if (!preferredNameAlreadyProposed && !client.preferredName) {
      changes.push({ field: "preferredName", current: client.preferredName, proposed: fullName.value, questionTitle: fullName.title, semanticKey: fullName.semanticKey });
    }
  }

  const email = clientDirectAnswerField(answers, "client_email", participantRole, (title) => title.includes("email"), cleanEmailAnswer);
  push("email", email?.value ?? null, client.email, email);

  return changes;
}

/**
 * Apply half of the client-profile sync. Re-reads the live client row (D5 stale
 * guard) and re-runs the email-uniqueness collision check at apply time (D9/M2)
 * rather than trusting the compute-time snapshot. Used both by the flag-OFF
 * direct-write path (accept-all, called immediately after compute) and the
 * flag-ON admin apply action (Tyler's accepted subset, possibly much later).
 */
export async function applyClientProfileChanges({
  responseContext,
  clientId,
  changes,
  acceptedFields,
  actor,
}: {
  responseContext: { questionnaireId: string; projectId: string | null; responseId: string };
  clientId: string;
  changes: FieldChange[];
  acceptedFields: Set<string>;
  actor: QuestionnaireAutofillActor;
}): Promise<FieldApplyOutcome> {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  const skipped: Array<{ field: string; reason: string }> = [];
  if (!client) return { applied, alreadyApplied, skipped };

  const updates: Partial<typeof clients.$inferInsert> = {};

  for (const change of changes) {
    if (!acceptedFields.has(change.field)) continue;
    if (!CLIENT_PROFILE_FIELD_ALLOWLIST.has(change.field)) {
      skipped.push({ field: change.field, reason: "unknown_field" });
      continue;
    }
    const live = client[change.field as keyof typeof client] as string | null;
    if (live === change.proposed) {
      alreadyApplied.push(change.field);
      continue;
    }
    if (live !== change.current) {
      skipped.push({ field: change.field, reason: "changed" });
      continue;
    }
    if (change.field === "email") {
      const existingEmailClient = await db.query.clients.findFirst({ where: eq(clients.email, change.proposed) });
      if (existingEmailClient && existingEmailClient.id !== clientId) {
        skipped.push({ field: "email", reason: "email_collision" });
        continue;
      }
    }
    (updates as Record<string, unknown>)[change.field] = change.proposed;
    applied.push(change.field);
  }

  if (applied.length) {
    const now = new Date().toISOString();
    await db.update(clients)
      .set({ ...updates, updatedAt: now })
      .where(eq(clients.id, clientId));

    await logActivity({
      action: "client.profile_synced_from_questionnaire",
      projectId: responseContext.projectId || undefined,
      clientId,
      actorType: actor.actorType,
      actorName: actor.actorName,
      metadata: {
        questionnaireId: responseContext.questionnaireId,
        responseId: responseContext.responseId,
        changedFields: applied,
      },
    });
  }

  return { applied, alreadyApplied, skipped };
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

type QuestionnaireLocationInput = {
  type: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  notes: string | null;
};

function locationInputFromValue(type: string, label: string, value: string): QuestionnaireLocationInput | null {
  const normalizedValue = normalizedLocationName(value);
  if (!normalizedValue || normalizedValue === "na" || normalizedValue === "n a" || normalizedValue === "none" || normalizedValue === "same as ceremony") return null;

  if (type === "other") {
    return { type, name: label, address: null, city: null, state: null, notes: value };
  }

  const parsed = splitLocationAnswer(value);
  const name = type === "getting_ready" && label !== "Other locations"
    ? `${label}: ${parsed.name}`
    : parsed.name;
  return { type, name: name || label, address: parsed.address, city: null, state: null, notes: parsed.notes };
}

function questionnaireLocationInputs(answers: Array<{ title: string; value: QuestionnaireAnswerValue }>): QuestionnaireLocationInput[] {
  const inputs: QuestionnaireLocationInput[] = [];

  for (const answer of answers) {
    const type = questionnaireLocationType(answer.title);
    const value = cleanTextAnswer(answer.value);
    if (!type || !value) continue;

    const label = questionnaireLocationLabel(answer.title, type);
    const input = locationInputFromValue(type, label, value);
    if (input) inputs.push(input);
  }

  return inputs;
}

// §5 semantic keys for the five location roles. Purely additive — a keyed
// answer is resolved here FIRST; the keyword pass above only ever sees
// keyword-eligible (unkeyed) answers (M8 rule 1), so there is no double-match.
const LOCATION_SEMANTIC_KEYS: Partial<Record<SemanticKey, { type: string; label: string }>> = {
  getting_ready_location_bride: { type: "getting_ready", label: "Bride getting ready" },
  getting_ready_location_groom: { type: "getting_ready", label: "Groom getting ready" },
  ceremony_location: { type: "ceremony", label: "Ceremony" },
  reception_location: { type: "reception", label: "Reception" },
  portrait_location: { type: "portrait", label: "Portrait location" },
};

function semanticLocationInputs(answers: SemanticAnswer[]): QuestionnaireLocationInput[] {
  const inputs: QuestionnaireLocationInput[] = [];
  for (const [key, info] of Object.entries(LOCATION_SEMANTIC_KEYS) as Array<[SemanticKey, { type: string; label: string }]>) {
    const raw = resolveSemanticValue(answers, key);
    const value = raw !== null ? cleanTextAnswer(raw) : null;
    if (!value) continue;
    const input = locationInputFromValue(info.type, info.label, value);
    if (input) inputs.push(input);
  }
  return inputs;
}

function allQuestionnaireLocationInputs(answers: SemanticAnswer[]): QuestionnaireLocationInput[] {
  return [...semanticLocationInputs(answers), ...questionnaireLocationInputs(keywordAnswers(answers))];
}

/**
 * Compute half of the locations sync. Pure — `existingLocations` is pre-fetched
 * by the caller. D5/M1: `current` is a full field snapshot of the matched row at
 * compute time, so the apply half can detect per-field drift.
 */
export function computeProjectLocationsChanges({
  response,
  existingLocations,
  answers,
}: {
  response: { projectId: string | null; submittedAt: string | null; id: string };
  existingLocations: Array<typeof projectLocations.$inferSelect>;
  answers: SemanticAnswer[];
}): LocationChange[] {
  if (!response.projectId || !response.submittedAt) return [];

  const locations = allQuestionnaireLocationInputs(answers);
  if (!locations.length) return [];

  return locations.map((location): LocationChange => {
    const existingLocation = existingLocations.find((entry) =>
      entry.sourceType === "questionnaire_response" &&
      entry.sourceId === response.id &&
      entry.type === location.type &&
      normalizedLocationName(entry.name) === normalizedLocationName(location.name));

    const proposed = {
      name: location.name,
      address: location.address,
      city: location.city,
      state: location.state,
      notes: location.notes,
    };

    if (!existingLocation) {
      return { action: "create", type: location.type, proposed };
    }

    return {
      action: "update",
      type: location.type,
      proposed,
      current: {
        name: existingLocation.name,
        address: existingLocation.address,
        city: existingLocation.city,
        state: existingLocation.state,
        notes: existingLocation.notes,
      },
      existingId: existingLocation.id,
    };
  });
}

const LOCATION_UPDATE_FIELDS = ["name", "address", "city", "state", "notes"] as const;

/**
 * Apply half of the locations sync. `create` entries are accepted/rejected as a
 * whole row (key `locations.create.<index>`); `update` entries are accepted
 * per-field (key `locations.<existingId>.<field>`), each independently re-read
 * against the LIVE row (D5/M1): a field whose live value drifted from the
 * compute-time snapshot is skipped (`reason:"changed"`); an `existingId` whose
 * row was deleted between compute and apply skips that whole entry
 * (`reason:"existing_missing"`) rather than re-inserting or throwing.
 */
export async function applyProjectLocationsChanges({
  responseContext,
  projectId,
  changes,
  acceptedFields,
  actor,
}: {
  responseContext: { questionnaireId: string; responseId: string; clientId: string | null };
  projectId: string;
  changes: LocationChange[];
  acceptedFields: Set<string>;
  actor: QuestionnaireAutofillActor;
}): Promise<FieldApplyOutcome> {
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  const skipped: Array<{ field: string; reason: string }> = [];
  let touchedCount = 0;
  const now = new Date().toISOString();

  for (const [index, change] of changes.entries()) {
    if (change.action === "create") {
      const key = `locations.create.${index}`;
      if (!acceptedFields.has(key)) continue;

      // M9-equivalent idempotency for creates: a prior apply (or the flag-OFF
      // accept-all path) may already have inserted this exact row (same
      // matching key the compute half uses: sourceType/sourceId/type/name). A
      // double-apply must be a no-op here too, not a duplicate insert.
      const candidates = await db.query.projectLocations.findMany({
        where: (location, { and, eq }) => and(
          eq(location.projectId, projectId),
          eq(location.sourceType, "questionnaire_response"),
          eq(location.sourceId, responseContext.responseId),
          eq(location.type, change.type),
        ),
      });
      const alreadyExists = candidates.some((location) => normalizedLocationName(location.name) === normalizedLocationName(change.proposed.name));
      if (alreadyExists) {
        alreadyApplied.push(key);
        continue;
      }

      await db.insert(projectLocations).values({
        id: crypto.randomUUID(),
        projectId,
        type: change.type,
        name: change.proposed.name,
        address: change.proposed.address,
        city: change.proposed.city,
        state: change.proposed.state,
        notes: change.proposed.notes,
        sourceType: "questionnaire_response",
        sourceId: responseContext.responseId,
        createdAt: now,
        updatedAt: now,
      });
      applied.push(key);
      touchedCount += 1;
      continue;
    }

    if (!change.existingId) continue;
    const acceptedFieldNames = LOCATION_UPDATE_FIELDS.filter((field) => acceptedFields.has(`locations.${change.existingId}.${field}`));
    if (!acceptedFieldNames.length) continue;

    const liveLocation = await db.query.projectLocations.findFirst({ where: eq(projectLocations.id, change.existingId) });
    if (!liveLocation) {
      for (const field of acceptedFieldNames) {
        skipped.push({ field: `locations.${change.existingId}.${field}`, reason: "existing_missing" });
      }
      continue;
    }

    const updates: Partial<typeof projectLocations.$inferInsert> = {};
    for (const field of acceptedFieldNames) {
      const key = `locations.${change.existingId}.${field}`;
      const proposedValue = change.proposed[field];
      const currentSnapshot = change.current?.[field] ?? null;
      const liveValue = liveLocation[field];
      if (liveValue === proposedValue) {
        alreadyApplied.push(key);
        continue;
      }
      if (liveValue !== currentSnapshot) {
        skipped.push({ field: key, reason: "changed" });
        continue;
      }
      (updates as Record<string, unknown>)[field] = proposedValue;
      applied.push(key);
    }

    if (Object.keys(updates).length) {
      await db.update(projectLocations).set({ ...updates, updatedAt: now }).where(eq(projectLocations.id, change.existingId));
      touchedCount += 1;
    }
  }

  if (touchedCount > 0) {
    await logActivity({
      action: "project.locations_synced_from_questionnaire",
      projectId,
      clientId: responseContext.clientId || undefined,
      actorType: actor.actorType,
      actorName: actor.actorName,
      metadata: {
        questionnaireId: responseContext.questionnaireId,
        responseId: responseContext.responseId,
        locationCount: touchedCount,
      },
    });
  }

  return { applied, alreadyApplied, skipped };
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

function resolveWeddingDayEvent(existingEvents: Array<typeof projectEvents.$inferSelect>) {
  return existingEvents.find((entry) => entry.title.toLowerCase() === "wedding day")
    ?? existingEvents.find((entry) => entry.type === "wedding")
    ?? existingEvents[0]
    ?? null;
}

// §5: "ceremony_time" is the only vocabulary key overlapping the composite
// event-notes blob. A keyed answer is resolved first and prepended; the
// keyword pass (unchanged `questionnaireWeddingDayEventNotes`) only ever sees
// keyword-eligible answers (M8 rule 1), so there's no duplicate section.
function computeWeddingDayEventNotes(answers: SemanticAnswer[]): string | null {
  const sections: string[] = [];
  const semanticCeremonyTime = resolveSemanticValue(answers, "ceremony_time");
  const ceremonyTimeValue = semanticCeremonyTime !== null ? cleanTextAnswer(semanticCeremonyTime) : null;
  if (ceremonyTimeValue) sections.push(`Ceremony time:\n${ceremonyTimeValue}`);

  const keywordNotes = questionnaireWeddingDayEventNotes(keywordAnswers(answers));
  if (keywordNotes) sections.push(keywordNotes);

  return sections.length ? sections.join("\n\n") : null;
}

/**
 * Compute half of the "Wedding day" project_events sync. v1 only proposes the
 * composite `notes` field (§3) — the venue/date/type/title backfill is
 * re-derived from LIVE state at apply time (D9/M6), not proposed to Tyler as a
 * separate diffable field.
 */
export function computeProjectEventChanges({
  response,
  project,
  existingEvents,
  answers,
}: {
  response: { projectId: string | null; submittedAt: string | null };
  project: typeof projects.$inferSelect | null;
  existingEvents: Array<typeof projectEvents.$inferSelect>;
  answers: SemanticAnswer[];
}): FieldChange[] {
  if (!response.projectId || !response.submittedAt || !project) return [];

  const notes = computeWeddingDayEventNotes(answers);
  if (!notes) return [];

  const event = resolveWeddingDayEvent(existingEvents);
  const current = event?.notes ?? null;
  if (notes === current) return [];

  return [{ field: "notes", current, proposed: notes, questionTitle: "Wedding day notes" }];
}

/**
 * Apply half of the event sync. D9/M6: re-resolves which project_events row to
 * target (same fallback chain as compute) and re-derives the venue/date
 * backfill from LIVE project + event state — never the compute-time snapshot —
 * because either could have changed between compute and apply. Callers MUST
 * invoke this AFTER `applyProjectProfileChanges` so the backfill inherits the
 * freshly-applied project venue/date rather than pre-apply values.
 */
export async function applyProjectEventChanges({
  responseContext,
  projectId,
  changes,
  acceptedFields,
  actor,
}: {
  responseContext: { questionnaireId: string; responseId: string; clientId: string | null };
  projectId: string;
  changes: FieldChange[];
  acceptedFields: Set<string>;
  actor: QuestionnaireAutofillActor;
}): Promise<FieldApplyOutcome> {
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  const skipped: Array<{ field: string; reason: string }> = [];

  const change = changes.find((entry) => entry.field === "notes");
  if (!change || !acceptedFields.has("notes")) return { applied, alreadyApplied, skipped };
  if (!PROJECT_EVENT_FIELD_ALLOWLIST.has(change.field)) {
    skipped.push({ field: change.field, reason: "unknown_field" });
    return { applied, alreadyApplied, skipped };
  }

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) return { applied, alreadyApplied, skipped };
  const existingEvents = await db.query.projectEvents.findMany({
    where: eq(projectEvents.projectId, projectId),
    orderBy: asc(projectEvents.createdAt),
  });
  const event = resolveWeddingDayEvent(existingEvents);
  const liveNotes = event?.notes ?? null;

  if (liveNotes === change.proposed) {
    alreadyApplied.push("notes");
    return { applied, alreadyApplied, skipped };
  }
  if (liveNotes !== change.current) {
    skipped.push({ field: "notes", reason: "changed" });
    return { applied, alreadyApplied, skipped };
  }

  const now = new Date().toISOString();
  const updates = {
    type: event?.type || project.type || "wedding",
    title: event?.title || "Wedding day",
    eventDate: event?.eventDate || project.eventDate,
    venueName: event?.venueName || project.venueName,
    venueAddress: event?.venueAddress || project.venueAddress,
    city: event?.city || project.city,
    state: event?.state || project.state,
    calendarSyncStatus: event?.calendarSyncStatus || (project.eventDate ? "needs_google_connection" : "not_connected"),
    notes: change.proposed,
    sourceType: "questionnaire_response",
    sourceId: responseContext.responseId,
    updatedAt: now,
  };

  if (event) {
    await db.update(projectEvents)
      .set(updates)
      .where(eq(projectEvents.id, event.id));
  } else {
    await db.insert(projectEvents).values({
      id: crypto.randomUUID(),
      projectId,
      ...updates,
      createdAt: now,
    });
  }
  applied.push("notes");

  await logActivity({
    action: "project.event_synced_from_questionnaire",
    projectId,
    clientId: responseContext.clientId || undefined,
    actorType: actor.actorType,
    actorName: actor.actorName,
    metadata: {
      questionnaireId: responseContext.questionnaireId,
      responseId: responseContext.responseId,
      eventTitle: updates.title,
    },
  });

  return { applied, alreadyApplied, skipped };
}

// Semantic-first match against a project field: try the keyed answer first,
// falling back to the ORIGINAL, unchanged `textAnswerForProject`/
// `dateAnswerForProject` keyword matchers restricted to keyword-eligible
// answers (keyed answers excluded, M8 rule 1). Reuses those functions as the
// value-extraction authority (byte-identical values either way).
function projectFieldValue(
  answers: SemanticAnswer[],
  semanticKey: SemanticKey,
  matcher: (title: string) => boolean,
  isDate: boolean,
): { value: string; title: string; semanticKey?: string } | null {
  const semanticRaw = resolveSemanticValue(answers, semanticKey);
  if (semanticRaw !== null) {
    const cleaned = cleanTextAnswer(semanticRaw);
    const value = isDate ? (cleaned && /^\d{4}-\d{2}-\d{2}$/.test(cleaned) ? cleaned : null) : cleaned;
    if (value) {
      const source = answers.find((answer) => answer.semanticKey === semanticKey);
      return { value, title: source?.title ?? "", semanticKey };
    }
  }

  const eligible = keywordAnswers(answers);
  const value = isDate ? dateAnswerForProject(eligible, matcher) : textAnswerForProject(eligible, matcher);
  if (!value) return null;
  const source = eligible.find((answer) => matcher(normalizedQuestionTitle(answer.title)) && cleanTextAnswer(answer.value) === value);
  return { value, title: source?.title ?? "" };
}

/**
 * Compute half of the project-profile sync. Pure — `project` is pre-fetched by
 * the caller. Preserves the exact original extraction/diff semantics (I1),
 * plus semantic-key-first resolution (§5).
 */
export function computeProjectProfileChanges({
  response,
  project,
  answers,
}: {
  response: { projectId: string | null };
  project: typeof projects.$inferSelect | null;
  answers: SemanticAnswer[];
}): FieldChange[] {
  if (!response.projectId || !project) return [];

  const changes: FieldChange[] = [];

  const eventDateMatch = !project.eventDate
    ? projectFieldValue(answers, "event_date", (title) => title.includes("wedding date") || title.includes("event date") || title === "date", true)
    : null;
  if (eventDateMatch && eventDateMatch.value !== project.eventDate) {
    changes.push({ field: "eventDate", current: project.eventDate, proposed: eventDateMatch.value, questionTitle: eventDateMatch.title, semanticKey: eventDateMatch.semanticKey });
  }

  const venueNameMatch = projectFieldValue(answers, "venue_name", (title) => (title.includes("venue") || title.includes("location")) && !title.includes("address"), false);
  if (venueNameMatch && venueNameMatch.value !== project.venueName) {
    changes.push({ field: "venueName", current: project.venueName, proposed: venueNameMatch.value, questionTitle: venueNameMatch.title, semanticKey: venueNameMatch.semanticKey });
  }

  const venueAddressMatch = projectFieldValue(answers, "venue_address", (title) => title.includes("venue address") || title === "address" || title.includes("location address"), false);
  if (venueAddressMatch && venueAddressMatch.value !== project.venueAddress) {
    changes.push({ field: "venueAddress", current: project.venueAddress, proposed: venueAddressMatch.value, questionTitle: venueAddressMatch.title, semanticKey: venueAddressMatch.semanticKey });
  }

  const cityMatch = projectFieldValue(answers, "city", (title) => title.includes("wedding city") || title.includes("event city") || title === "city", false);
  if (cityMatch && cityMatch.value !== project.city) {
    changes.push({ field: "city", current: project.city, proposed: cityMatch.value, questionTitle: cityMatch.title, semanticKey: cityMatch.semanticKey });
  }

  const stateMatch = projectFieldValue(answers, "state", (title) => title.includes("wedding state") || title.includes("event state") || title === "state", false);
  if (stateMatch && stateMatch.value !== project.state) {
    changes.push({ field: "state", current: project.state, proposed: stateMatch.value, questionTitle: stateMatch.title, semanticKey: stateMatch.semanticKey });
  }

  return changes;
}

/**
 * Apply half of the project-profile sync. D9/M7: `calendarSyncStatus` is
 * recomputed from the LIVE `googleCalendarEventId` at apply time (never
 * trusted from compute) — it is a derived companion of an accepted `eventDate`
 * change, not an independently-checkboxed field, and is NOT in the allowlist.
 */
export async function applyProjectProfileChanges({
  responseContext,
  projectId,
  changes,
  acceptedFields,
  actor,
}: {
  responseContext: { questionnaireId: string; responseId: string; clientId: string | null };
  projectId: string;
  changes: FieldChange[];
  acceptedFields: Set<string>;
  actor: QuestionnaireAutofillActor;
}): Promise<FieldApplyOutcome> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  const skipped: Array<{ field: string; reason: string }> = [];
  if (!project) return { applied, alreadyApplied, skipped };

  const updates: Partial<typeof projects.$inferInsert> = {};

  for (const change of changes) {
    if (!acceptedFields.has(change.field)) continue;
    if (!PROJECT_PROFILE_FIELD_ALLOWLIST.has(change.field)) {
      skipped.push({ field: change.field, reason: "unknown_field" });
      continue;
    }
    const live = project[change.field as keyof typeof project] as string | null;
    if (live === change.proposed) {
      alreadyApplied.push(change.field);
      continue;
    }
    if (live !== change.current) {
      skipped.push({ field: change.field, reason: "changed" });
      continue;
    }
    (updates as Record<string, unknown>)[change.field] = change.proposed;
    applied.push(change.field);
  }

  if (applied.includes("eventDate")) {
    updates.calendarSyncStatus = projectEventCalendarStatusAfterEdit({
      eventDate: updates.eventDate as string,
      googleCalendarEventId: project.googleCalendarEventId,
    });
  }

  if (applied.length) {
    const now = new Date().toISOString();
    await db.update(projects)
      .set({ ...updates, updatedAt: now })
      .where(eq(projects.id, projectId));

    await logActivity({
      action: "project.profile_synced_from_questionnaire",
      projectId,
      clientId: responseContext.clientId || undefined,
      actorType: actor.actorType,
      actorName: actor.actorName,
      metadata: {
        questionnaireId: responseContext.questionnaireId,
        responseId: responseContext.responseId,
        changedFields: applied,
      },
    });
  }

  return { applied, alreadyApplied, skipped };
}

// -----------------------------------------------------------------------------
// Phase 23 (CR-5) §3 — the proposal artifact + orchestration.
// -----------------------------------------------------------------------------
export type QuestionnaireAutofillProposal = {
  version: 1;
  responseId: string;
  computedAt: string;
  contentHash: string;
  project: FieldChange[];
  projectEvent: FieldChange[];
  client: FieldChange[];
  locations: LocationChange[];
};

// Modeled on `financeRefundRecordingMode`/`unifiedSignPayEnabled` (finance-flags.ts):
// read from process.env INSIDE the body (never a default param) so the narrow
// param type never absorbs the weak ProcessEnv type; strict `=== "1"` (unset,
// "", "0", "true", "on", any typo -> OFF).
export function questionnaireAutofillReviewEnabled(env?: { QUESTIONNAIRE_AUTOFILL_REVIEW?: string }): boolean {
  return (env ?? process.env).QUESTIONNAIRE_AUTOFILL_REVIEW === "1";
}

/**
 * Orchestrates the four compute halves into a single proposal (§3), including
 * the D8 version token (`computedAt` + `contentHash`) and the §3 size cap
 * (fails soft — returns null rather than throwing/blocking the submission).
 */
export function buildQuestionnaireAutofillProposal({
  response,
  project,
  client,
  participantRole,
  existingEvents,
  existingLocations,
  answers,
}: {
  response: { id: string; projectId: string | null; clientId: string | null; submittedAt: string | null };
  project: typeof projects.$inferSelect | null;
  client: typeof clients.$inferSelect | null;
  participantRole: string | null | undefined;
  existingEvents: Array<typeof projectEvents.$inferSelect>;
  existingLocations: Array<typeof projectLocations.$inferSelect>;
  answers: SemanticAnswer[];
}): QuestionnaireAutofillProposal | null {
  const projectChanges = computeProjectProfileChanges({ response, project, answers });
  const clientChanges = computeClientProfileChanges({ response, client, participantRole, answers });
  const projectEventChanges = computeProjectEventChanges({ response, project, existingEvents, answers });
  const locationChanges = computeProjectLocationsChanges({ response, existingLocations, answers });

  const computedAt = new Date().toISOString();
  const contentBasis = JSON.stringify({
    responseId: response.id,
    project: projectChanges,
    projectEvent: projectEventChanges,
    client: clientChanges,
    locations: locationChanges,
  });
  const contentHash = createHash("sha256").update(contentBasis).digest("hex");

  const proposal: QuestionnaireAutofillProposal = {
    version: 1,
    responseId: response.id,
    computedAt,
    contentHash,
    project: projectChanges,
    projectEvent: projectEventChanges,
    client: clientChanges,
    locations: locationChanges,
  };

  const serialized = JSON.stringify(proposal);
  if (serialized.length > maxSerializedAnswersLength) return null;

  return proposal;
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

// Zips a question's `semanticKey` onto each stored answer for the compute
// halves (§5). Deliberately NOT persisted into `answersJson` — the stored
// answer shape stays byte-identical to today (I1); this is an in-memory join
// used only to drive proposal computation.
function withSemanticKeys(
  answers: Array<{ title: string; value: QuestionnaireAnswerValue; questionId?: string }>,
  questions: Array<{ id: string; semanticKey?: string | null }>,
): SemanticAnswer[] {
  const semanticKeyById = new Map(questions.map((question) => [question.id, question.semanticKey ?? null]));
  return answers.map((answer) => ({
    title: answer.title,
    value: answer.value,
    semanticKey: answer.questionId ? semanticKeyById.get(answer.questionId) ?? null : null,
  }));
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
      questionId: answer.questionId,
      title: String(answer.title ?? ""),
      value: Array.isArray(answer.value)
        ? answer.value.map((entry) => String(entry))
        : String(answer.value ?? ""),
    }));
    const backfillQuestions = await listQuestionnaireQuestions(row.response.questionnaireId);
    const semanticAnswers = withSemanticKeys(typedAnswers, backfillQuestions);
    const backfillActor: QuestionnaireAutofillActor = { actorType: "system", actorName: "The Reeses Studio" };
    const backfillResponseContext = {
      questionnaireId: row.response.questionnaireId,
      responseId: row.response.id,
      clientId: row.response.clientId,
    };

    // Phase 23 review MEDIUM-2 — when the review flag is ON, this backfill's
    // canonical location/event applies would re-open the untrusted-input write
    // channel the flag exists to close (client-submitted answers → canonical
    // rows with actorType "system", no review). The transcript source sync above
    // is always safe (non-canonical); gate ONLY the canonical applies. (This
    // function is currently unwired — test-only caller — so this is defensive.)
    const backfillReviewGated = questionnaireAutofillReviewEnabled();

    const existingLocations = await db.query.projectLocations.findMany({
      where: eq(projectLocations.projectId, row.response.projectId as string),
    });
    const locationChanges = computeProjectLocationsChanges({
      response: { projectId: row.response.projectId, submittedAt: row.response.submittedAt, id: row.response.id },
      existingLocations,
      answers: semanticAnswers,
    });
    if (!backfillReviewGated && locationChanges.length) {
      const acceptedLocationFields = new Set(locationChanges.flatMap((change, index) => change.action === "create"
        ? [`locations.create.${index}`]
        : LOCATION_UPDATE_FIELDS.map((field) => `locations.${change.existingId}.${field}`)));
      await applyProjectLocationsChanges({
        responseContext: backfillResponseContext,
        projectId: row.response.projectId as string,
        changes: locationChanges,
        acceptedFields: acceptedLocationFields,
        actor: backfillActor,
      });
    }

    const backfillProject = row.response.projectId
      ? await db.query.projects.findFirst({ where: eq(projects.id, row.response.projectId) }) ?? null
      : null;
    const existingEvents = row.response.projectId
      ? await db.query.projectEvents.findMany({ where: eq(projectEvents.projectId, row.response.projectId), orderBy: asc(projectEvents.createdAt) })
      : [];
    const eventChanges = computeProjectEventChanges({
      response: { projectId: row.response.projectId, submittedAt: row.response.submittedAt },
      project: backfillProject,
      existingEvents,
      answers: semanticAnswers,
    });
    if (!backfillReviewGated && eventChanges.length) {
      await applyProjectEventChanges({
        responseContext: backfillResponseContext,
        projectId: row.response.projectId as string,
        changes: eventChanges,
        acceptedFields: new Set(eventChanges.map((change) => change.field)),
        actor: backfillActor,
      });
    }

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

// D5 "changed since computed" annotation for the response-detail review card:
// re-diffs each FieldChange against the LIVE row (never trusted from compute
// time) so Tyler sees drift before applying. Purely a render concern — the
// authoritative stale check happens again, independently, at apply time.
type FieldChangeView = FieldChange & { live: string | null; stale: boolean };
type LocationChangeView = LocationChange & {
  liveCurrent?: { name: string | null; address: string | null; city: string | null; state: string | null; notes: string | null };
  missing?: boolean;
};
export type QuestionnaireAutofillProposalView = Omit<QuestionnaireAutofillProposal, "project" | "projectEvent" | "client" | "locations"> & {
  project: FieldChangeView[];
  projectEvent: FieldChangeView[];
  client: FieldChangeView[];
  locations: LocationChangeView[];
};

function annotateFieldChanges(changes: FieldChange[], live: Record<string, unknown> | null): FieldChangeView[] {
  return changes.map((change) => {
    const liveValue = live ? (live[change.field] as string | null | undefined) ?? null : null;
    return { ...change, live: liveValue, stale: liveValue !== change.current };
  });
}

export async function getQuestionnaireResponseDetail(responseId: string) {
  const [response] = await db.select({
    ...responseSummarySelect(),
    answersJson: questionnaireResponses.answersJson,
    suggestedChangesJson: questionnaireResponses.suggestedChangesJson,
    suggestedChangesComputedAt: questionnaireResponses.suggestedChangesComputedAt,
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

  let proposal: QuestionnaireAutofillProposalView | null = null;
  if (response.suggestedChangesJson) {
    try {
      const parsed = JSON.parse(response.suggestedChangesJson) as QuestionnaireAutofillProposal;
      const liveProject = response.projectId && (parsed.project.length || parsed.projectEvent.length)
        ? await db.query.projects.findFirst({ where: eq(projects.id, response.projectId) })
        : null;
      const liveClient = response.clientId && parsed.client.length
        ? await db.query.clients.findFirst({ where: eq(clients.id, response.clientId) })
        : null;
      const liveEvent = response.projectId && parsed.projectEvent.length
        ? resolveWeddingDayEvent(await db.query.projectEvents.findMany({
            where: eq(projectEvents.projectId, response.projectId),
            orderBy: asc(projectEvents.createdAt),
          }))
        : null;
      const liveLocationsById = response.projectId && parsed.locations.length
        ? new Map((await db.query.projectLocations.findMany({
            where: eq(projectLocations.projectId, response.projectId),
          })).map((location) => [location.id, location]))
        : new Map<string, typeof projectLocations.$inferSelect>();

      proposal = {
        ...parsed,
        project: annotateFieldChanges(parsed.project, liveProject as unknown as Record<string, unknown> | null),
        client: annotateFieldChanges(parsed.client, liveClient as unknown as Record<string, unknown> | null),
        projectEvent: annotateFieldChanges(parsed.projectEvent, { notes: liveEvent?.notes ?? null }),
        locations: parsed.locations.map((change): LocationChangeView => {
          if (change.action === "create" || !change.existingId) return { ...change };
          const liveLocation = liveLocationsById.get(change.existingId);
          if (!liveLocation) return { ...change, missing: true };
          return {
            ...change,
            liveCurrent: {
              name: liveLocation.name,
              address: liveLocation.address,
              city: liveLocation.city,
              state: liveLocation.state,
              notes: liveLocation.notes,
            },
          };
        }),
      };
    } catch {
      proposal = null;
    }
  }

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
    proposal,
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

/**
 * D1/D2/I2 flag hinge. Flag OFF: today's four direct-write syncs, unchanged
 * (I1) — now implemented as compute()-then-apply()-with-everything-accepted in
 * the same request, so there is exactly ONE extraction implementation shared
 * with the flag-ON path. Flag ON: computes a proposal and stores it on the
 * response row; NO canonical write happens (I2) — the four canonical syncs are
 * not called. The `project_sources` transcript sync runs in BOTH branches
 * (non-canonical, unaffected by the flag).
 *
 * Return shape: flag OFF returns the bare `responseId` string (unchanged, I1);
 * flag ON returns `{ responseId, proposal }` (M3) so the agent-API/MCP callers
 * (via `questionnaireResponseResult`) and the admin action (via the redirect
 * target) can surface the proposal instead of silently dead-ending.
 */
export async function updateQuestionnaireResponseAnswers({
  responseId,
  answers,
  submit = false,
}: {
  responseId: string;
  answers: QuestionnaireAnswerInput;
  submit?: boolean;
}): Promise<string | { responseId: string; proposal: QuestionnaireAutofillProposal | null }> {
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
    ? await db.query.clients.findFirst({ where: eq(clients.id, response.clientId) }) ?? null
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

  const updatedResponse = {
    ...response,
    respondentName,
    respondentEmail,
    submittedAt,
    answersJson: serializedAnswers,
    updatedAt: now,
  };

  const questionnaire = await db.query.questionnaires.findFirst({
    where: eq(questionnaires.id, response.questionnaireId),
  });
  if (questionnaire) {
    await syncQuestionnaireResponseProjectSource({
      response: updatedResponse,
      questionnaireTitle: questionnaire.title,
      answers: storedAnswers,
      submittedAt,
    });
  }

  const answersForProposal = withSemanticKeys(storedAnswers, questions);
  const participant = response.projectId && response.clientId
    ? await db.query.projectParticipants.findFirst({
        where: and(eq(projectParticipants.projectId, response.projectId), eq(projectParticipants.clientId, response.clientId)),
      })
    : null;
  const participantRole = participant?.role ?? null;
  const project = response.projectId
    ? await db.query.projects.findFirst({ where: eq(projects.id, response.projectId) }) ?? null
    : null;
  const existingLocations = response.projectId
    ? await db.query.projectLocations.findMany({ where: eq(projectLocations.projectId, response.projectId) })
    : [];
  const existingEvents = response.projectId
    ? await db.query.projectEvents.findMany({ where: eq(projectEvents.projectId, response.projectId), orderBy: asc(projectEvents.createdAt) })
    : [];

  if (questionnaireAutofillReviewEnabled()) {
    const proposal = buildQuestionnaireAutofillProposal({
      response: updatedResponse,
      project,
      client,
      participantRole,
      existingEvents,
      existingLocations,
      answers: answersForProposal,
    });

    await db.update(questionnaireResponses)
      .set({
        suggestedChangesJson: proposal ? JSON.stringify(proposal) : null,
        suggestedChangesComputedAt: proposal ? proposal.computedAt : null,
      })
      .where(eq(questionnaireResponses.id, responseId));

    await logActivity({
      action: submit ? "questionnaire.response.submitted" : "questionnaire.response.edited",
      projectId: response.projectId || undefined,
      clientId: response.clientId || undefined,
      metadata: { questionnaireId: response.questionnaireId, responseId },
    });

    return { responseId, proposal };
  }

  // Flag OFF (I1): the same four canonical syncs as today, now expressed as
  // compute()-then-apply()-with-everything-accepted so there is exactly ONE
  // extraction implementation. Ordering matches D9/M6 (project-profile before
  // projectEvent) even though same-request drift can't occur here.
  const responseContext = { questionnaireId: response.questionnaireId, responseId, projectId: response.projectId, clientId: response.clientId };
  const systemActor: QuestionnaireAutofillActor = { actorType: "system", actorName: "The Reeses Studio" };

  const projectChanges = computeProjectProfileChanges({ response: updatedResponse, project, answers: answersForProposal });
  if (projectChanges.length && response.projectId) {
    await applyProjectProfileChanges({
      responseContext,
      projectId: response.projectId,
      changes: projectChanges,
      acceptedFields: new Set(projectChanges.map((change) => change.field)),
      actor: systemActor,
    });
  }

  const eventChanges = computeProjectEventChanges({ response: updatedResponse, project, existingEvents, answers: answersForProposal });
  if (eventChanges.length && response.projectId) {
    await applyProjectEventChanges({
      responseContext,
      projectId: response.projectId,
      changes: eventChanges,
      acceptedFields: new Set(eventChanges.map((change) => change.field)),
      actor: systemActor,
    });
  }

  const locationChanges = computeProjectLocationsChanges({ response: updatedResponse, existingLocations, answers: answersForProposal });
  if (locationChanges.length && response.projectId) {
    const acceptedLocationFields = new Set(locationChanges.flatMap((change, index) => change.action === "create"
      ? [`locations.create.${index}`]
      : LOCATION_UPDATE_FIELDS.map((field) => `locations.${change.existingId}.${field}`)));
    await applyProjectLocationsChanges({
      responseContext,
      projectId: response.projectId,
      changes: locationChanges,
      acceptedFields: acceptedLocationFields,
      actor: systemActor,
    });
  }

  const clientChanges = computeClientProfileChanges({ response: updatedResponse, client, participantRole, answers: answersForProposal });
  if (clientChanges.length && response.clientId) {
    await applyClientProfileChanges({
      responseContext,
      clientId: response.clientId,
      changes: clientChanges,
      acceptedFields: new Set(clientChanges.map((change) => change.field)),
      actor: systemActor,
    });
  }

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
  // D1/M3: flag ON routes this caller through the proposal path too — redirect
  // to the response-detail page where the "Suggested changes" card renders,
  // instead of a dead-end back to /edit (I2's admin-path equivalent of the
  // agent/MCP silent-dead-end problem). Flag OFF keeps today's exact redirect
  // (I1) — the card doesn't exist, so /edit is still the right landing spot.
  if (questionnaireAutofillReviewEnabled()) {
    redirect(`/questionnaires/${questionnaireId}/responses/${responseId}?saved=${saved}`);
  }
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
