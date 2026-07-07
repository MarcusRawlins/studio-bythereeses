// Phase 23 (CR-5), §5 — semantic mapping robustness.
//
// A small closed vocabulary an admin can assign to a questionnaire question
// (`questionnaire_questions.semantic_key`, migration 0095, additive/nullable).
// Purely additive: a question with no key behaves exactly as it does today
// (keyword-on-title matching, unchanged). A migration never auto-populates this
// column — assigning a key is an explicit admin action from the question editor.
//
// Two correctness rules (rev 2, M8), both enforced here:
//   1. Keyed questions are EXCLUDED from every keyword scan (`keywordAnswers`
//      strips them out) so a keyed answer never ALSO double-matches a keyword
//      matcher elsewhere (e.g. `ceremony_location` double-matching `venueName`
//      via the `"location"` keyword).
//   2. `resolveSemanticValue` preserves participant-role scoping for the
//      client-scoped keys — a `semantic_key` selects *which field*, not *whose*;
//      role scoping (bride vs groom) still decides *whose* answer applies.
export const SEMANTIC_KEYS = [
  "venue_name",
  "venue_address",
  "city",
  "state",
  "event_date",
  "ceremony_time",
  "getting_ready_location_bride",
  "getting_ready_location_groom",
  "ceremony_location",
  "reception_location",
  "portrait_location",
  "client_full_name",
  "client_phone",
  "client_email",
  "client_instagram",
  "communication_preference",
  "referral_source",
] as const;

export type SemanticKey = typeof SEMANTIC_KEYS[number];

const SEMANTIC_KEY_SET = new Set<string>(SEMANTIC_KEYS);

export function isSemanticKey(value: string | null | undefined): value is SemanticKey {
  return typeof value === "string" && SEMANTIC_KEY_SET.has(value);
}

// The client-scoped keys where role gating (bride vs groom vs generic) matters.
// Non-client keys (venue/location/date fields) are project-scoped and never
// role-filtered.
const ROLE_SCOPED_SEMANTIC_KEYS = new Set<SemanticKey>([
  "client_full_name",
  "client_phone",
  "client_email",
  "client_instagram",
  "communication_preference",
  "referral_source",
]);

export type QuestionnaireAnswerValue = string | string[];

export type SemanticAnswer = {
  title: string;
  value: QuestionnaireAnswerValue;
  semanticKey?: string | null;
};

function normalizedTitleTokens(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Mirrors `answerAppliesToParticipant` in questionnaires.ts (kept as an
// independent tiny copy here to avoid a runtime import cycle between this
// module and questionnaires.ts; the token logic is a few lines and intentionally
// duplicated rather than shared across a cycle).
function answerAppliesToParticipant(title: string, participantRole: string | null | undefined) {
  const normalized = normalizedTitleTokens(title);
  const tokens = ["bride", "groom", "partner", "spouse"].filter((token) => normalized.includes(token));
  if (!tokens.length) return true;

  const normalizedRole = normalizedTitleTokens(participantRole ?? "");
  return tokens.some((token) => normalizedRole.includes(token));
}

/** Answers whose question carries a recognized semantic_key. */
export function keyedAnswers<T extends SemanticAnswer>(answers: T[]): T[] {
  return answers.filter((answer) => isSemanticKey(answer.semanticKey));
}

/**
 * Answers whose question carries NO recognized semantic_key — the only pool
 * every keyword matcher should scan (M8 rule 1: keyed-exclusion).
 */
export function keywordAnswers<T extends SemanticAnswer>(answers: T[]): T[] {
  return answers.filter((answer) => !isSemanticKey(answer.semanticKey));
}

/**
 * Resolve the raw answer value for a semantic key, honoring participant-role
 * scoping for client-scoped keys (M8 rule 2). Returns the raw
 * `QuestionnaireAnswerValue` (caller applies its own field-specific cleaning,
 * e.g. `cleanEmailAnswer`/`cleanInstagramAnswer`) or null when no keyed answer
 * matches (either no question carries the key, or it's role-scoped and no
 * answer applies to this participant).
 */
export function resolveSemanticValue(
  answers: SemanticAnswer[],
  key: SemanticKey,
  participantRole?: string | null,
): QuestionnaireAnswerValue | null {
  const scoped = ROLE_SCOPED_SEMANTIC_KEYS.has(key);
  const match = answers.find((answer) =>
    answer.semanticKey === key &&
    (!scoped || answerAppliesToParticipant(answer.title, participantRole)));
  return match ? match.value : null;
}

/** The title of the answer that resolved a semantic key, for diff-UI provenance. */
export function resolveSemanticAnswerTitle(
  answers: SemanticAnswer[],
  key: SemanticKey,
  participantRole?: string | null,
): string | null {
  const scoped = ROLE_SCOPED_SEMANTIC_KEYS.has(key);
  const match = answers.find((answer) =>
    answer.semanticKey === key &&
    (!scoped || answerAppliesToParticipant(answer.title, participantRole)));
  return match?.title ?? null;
}
