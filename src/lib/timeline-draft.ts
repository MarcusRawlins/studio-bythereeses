type ProjectContext = {
  project: {
    id: string;
    name: string;
    eventDate: string | null;
    venueName: string | null;
  };
  questionnaireResponses: Array<{
    id: string;
    answers: Array<{
      questionId: string | null;
      title: string;
      formattedValue: string;
      value?: unknown;
    }>;
  }>;
  locations: Array<{
    type: string | null;
    name: string;
    address: string | null;
    notes: string | null;
    sourceType: string | null;
    sourceId: string | null;
  }>;
  sources: Array<{
    id: string;
    title: string;
    body: string;
    sourceType: string | null;
    sourceId: string | null;
    metadata?: Record<string, unknown> | null;
  }>;
};

export type TimelineDraft = {
  projectId: string;
  sourceIds: string[];
  assumptions: string[];
  openQuestions: string[];
  timelineItems: Array<{
    title: string;
    description?: string;
    startAt?: string;
    endAt?: string;
    locationRole?: string;
    locationName?: string;
    confidence: "low" | "medium" | "high";
    sourceQuestionIds?: string[];
  }>;
  familyFormals: Array<{
    groupName: string;
    people: string[];
    notes?: string;
    priority?: "must_have" | "nice_to_have";
    sourceQuestionIds?: string[];
  }>;
  locationSuggestions: Array<{
    role: string;
    name?: string;
    address?: string;
    notes?: string;
    action: "create" | "update" | "review";
  }>;
};

type AnswerMatch = {
  questionId: string;
  title: string;
  value: string;
};

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function answerValue(answer: { formattedValue: string; value?: unknown }) {
  const rawValue = cleanText(answer.value);
  const formatted = cleanText(answer.formattedValue);
  if (rawValue) return rawValue;
  if (formatted && formatted !== "No answer") return formatted;
  return "";
}

function getAnswers(context: ProjectContext, sourceId?: string | null) {
  const source = context.sources.find((item) => item.id === sourceId);
  const responseId = cleanText(source?.metadata?.responseId)
    || (source?.sourceType === "questionnaire_response" ? cleanText(source.sourceId) : "");
  const responses = responseId
    ? context.questionnaireResponses.filter((response) => response.id === responseId)
    : context.questionnaireResponses;

  return responses.flatMap((response) => response.answers.map((answer, index) => ({
    questionId: answer.questionId ?? `${response.id}-answer-${index}`,
    title: answer.title,
    value: answerValue(answer),
  }))).filter((answer) => answer.value);
}

function findAnswer(answers: AnswerMatch[], patterns: RegExp[]) {
  return answers.find((answer) => patterns.every((pattern) => pattern.test(answer.title)));
}

function findAnyAnswer(answers: AnswerMatch[], patterns: RegExp[]) {
  return answers.find((answer) => patterns.some((pattern) => pattern.test(answer.title)));
}

function maybeTime(value: string) {
  const match = value.match(/\b(\d{1,2})(?::?(\d{2}))?\s*(AM|PM)\b/i);
  if (!match) return undefined;
  const hour = match[1].padStart(2, "0");
  const minute = match[2] ?? "00";
  return `${hour}:${minute} ${match[3].toUpperCase()}`;
}

function splitPeople(value: string) {
  return value
    .split(/\r?\n|,|;|\s+\+\s+/)
    .map((item) => item.trim())
    .filter((item) => item && !/^n\/?a$/i.test(item) && item !== "0");
}

function addTimelineItem(
  items: TimelineDraft["timelineItems"],
  answer: AnswerMatch | undefined,
  input: Omit<TimelineDraft["timelineItems"][number], "sourceQuestionIds">,
) {
  if (!answer) return;
  items.push({
    ...input,
    sourceQuestionIds: [answer.questionId],
  });
}

export function buildTimelineDraftFromProjectContext(
  context: ProjectContext,
  input: { sourceId?: string | null } = {},
): TimelineDraft {
  const answers = getAnswers(context, input.sourceId);
  const sourceIds = input.sourceId ? [input.sourceId] : context.sources.map((source) => source.id);
  const timelineItems: TimelineDraft["timelineItems"] = [];
  const familyFormals: TimelineDraft["familyFormals"] = [];
  const locationSuggestions: TimelineDraft["locationSuggestions"] = [];
  const assumptions: string[] = [];
  const openQuestions = [
    "Confirm photography coverage start and end times before applying this draft.",
    "Confirm whether monument portraits are realistic, permitted, and worth the travel time.",
  ];

  const brideReady = findAnswer(answers, [/bride/i, /getting ready/i, /time/i]);
  const groomReady = findAnswer(answers, [/groom/i, /getting ready/i, /time/i]);
  const firstLook = findAnswer(answers, [/first look/i]);
  const ceremony = findAnswer(answers, [/ceremony/i, /begin|start|lasting|last/i]);
  const cocktail = findAnswer(answers, [/cocktail hour/i, /start|scheduled|room/i]);
  const reception = findAnyAnswer(answers, [/what time.*reception.*begin/i, /reception begin/i]);
  const receptionFlow = findAnswer(answers, [/reception events|traditions|flow/i]);

  addTimelineItem(timelineItems, brideReady, {
    title: "Bride getting ready",
    description: brideReady?.value,
    startAt: maybeTime(brideReady?.value ?? ""),
    locationRole: "getting_ready",
    confidence: "high",
  });
  addTimelineItem(timelineItems, groomReady, {
    title: "Groom getting ready",
    description: groomReady?.value,
    startAt: maybeTime(groomReady?.value ?? ""),
    locationRole: "getting_ready",
    confidence: "high",
  });
  if (/yes/i.test(firstLook?.value ?? "")) {
    timelineItems.push({
      title: "First look and couple portraits",
      description: "Exact timing depends on coverage start, travel, and whether monument portraits are approved.",
      confidence: "medium",
      sourceQuestionIds: firstLook ? [firstLook.questionId] : undefined,
    });
    assumptions.push("A first look is planned, so pre-ceremony portraits are likely part of the working timeline.");
  }
  addTimelineItem(timelineItems, ceremony, {
    title: "Ceremony",
    description: ceremony?.value,
    startAt: maybeTime(ceremony?.value ?? ""),
    locationRole: "ceremony",
    locationName: context.project.venueName ?? undefined,
    confidence: "high",
  });
  addTimelineItem(timelineItems, cocktail, {
    title: "Cocktail hour",
    description: cocktail?.value,
    startAt: maybeTime(cocktail?.value ?? ""),
    locationRole: "cocktail_hour",
    confidence: "high",
  });
  addTimelineItem(timelineItems, reception, {
    title: "Reception entrance",
    description: reception?.value,
    startAt: maybeTime(reception?.value ?? ""),
    locationRole: "reception",
    locationName: context.project.venueName ?? undefined,
    confidence: "high",
  });
  addTimelineItem(timelineItems, receptionFlow, {
    title: "Reception formalities",
    description: receptionFlow?.value,
    locationRole: "reception",
    locationName: context.project.venueName ?? undefined,
    confidence: "medium",
  });

  const brideParents = findAnswer(answers, [/bride/i, /parent/i]);
  const brideSiblings = findAnswer(answers, [/bride/i, /siblings/i]);
  const groomParents = findAnswer(answers, [/groom/i, /parent/i]);
  const groomSiblings = findAnswer(answers, [/groom/i, /siblings/i]);
  const extraFormals = findAnswer(answers, [/other desired family formals/i]);
  for (const [groupName, answer, priority] of [
    ["Bride immediate family", brideParents, "must_have"],
    ["Bride siblings and household", brideSiblings, "must_have"],
    ["Groom immediate family", groomParents, "must_have"],
    ["Groom siblings and household", groomSiblings, "must_have"],
    ["Additional requested groups", extraFormals, "nice_to_have"],
  ] as const) {
    const people = splitPeople(answer?.value ?? "");
    if (answer && people.length) {
      familyFormals.push({
        groupName,
        people,
        priority,
        notes: answer.value,
        sourceQuestionIds: [answer.questionId],
      });
    }
  }

  const locationAnswers = [
    ["bride_getting_ready", findAnswer(answers, [/bride/i, /getting ready location/i])],
    ["groom_getting_ready", findAnswer(answers, [/groom/i, /getting ready location/i])],
    ["ceremony", findAnswer(answers, [/ceremony location/i])],
    ["reception", findAnswer(answers, [/reception location/i])],
    ["portraits", findAnyAnswer(answers, [/other locations/i, /family formal photographs/i])],
  ] as const;
  for (const [role, answer] of locationAnswers) {
    if (!answer) continue;
    const existing = context.locations.find((location) => location.sourceId === input.sourceId || location.notes === answer.value);
    locationSuggestions.push({
      role,
      name: answer.value.split(/\r?\n/)[0],
      notes: answer.value,
      action: existing ? "review" : "create",
    });
  }

  const sensitiveFamily = findAnyAnswer(answers, [/special circumstances/i]);
  if (sensitiveFamily) {
    openQuestions.push("Review family-sensitive notes before finalizing family formal groupings.");
  }
  if (!timelineItems.length) {
    openQuestions.push("No firm timeline anchors were found in the selected source.");
  }

  return {
    projectId: context.project.id,
    sourceIds,
    assumptions,
    openQuestions,
    timelineItems,
    familyFormals,
    locationSuggestions,
  };
}
