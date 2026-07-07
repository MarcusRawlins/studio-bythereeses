import { db } from "@/db/client";
import { questionnaireResponses } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import {
  applyClientProfileChanges,
  applyProjectEventChanges,
  applyProjectLocationsChanges,
  applyProjectProfileChanges,
  buildQuestionnaireAutofillProposal,
  questionnaireAutofillReviewEnabled,
  type FieldApplyOutcome,
  type FieldChange,
  type LocationChange,
  type QuestionnaireAutofillActor,
  type QuestionnaireAutofillProposal,
} from "@/lib/questionnaires";
import { eq } from "drizzle-orm";

// Phase 23 (CR-5) — the compute+apply orchestrator. `computeQuestionnaireAutofillProposal`
// is a thin re-export of the actual implementation in questionnaires.ts (co-located with
// the four compute halves it orchestrates, so there is exactly ONE extraction
// implementation and zero import cycle between the two modules — this module depends on
// questionnaires.ts, never the reverse). `applyQuestionnaireAutofillProposal` (below) is
// the D8/D9/M9 admin-apply orchestrator and is the one genuinely new piece here.
export {
  buildQuestionnaireAutofillProposal as computeQuestionnaireAutofillProposal,
  questionnaireAutofillReviewEnabled,
};
export type { FieldChange, LocationChange, QuestionnaireAutofillActor, QuestionnaireAutofillProposal };

export type QuestionnaireAutofillVersionToken = {
  computedAt: string;
  contentHash: string;
};

export type QuestionnaireAutofillApplyResult =
  | { rejected: true; error: string }
  | {
    rejected: false;
    applied: string[];
    alreadyApplied: string[];
    skipped: Array<{ field: string; reason: string }>;
  };

export const PROPOSAL_VERSION_MISMATCH_ERROR =
  "This proposal changed since you reviewed it (the client re-submitted). Re-review the suggested changes and apply again.";

/**
 * D8/I7 (BLOCKER B1 fix), D9 apply-time re-checks, M9 check ordering.
 *
 * Order of operations (spec §4, rev 2):
 *   1. Re-read the STORED proposal (never trust the caller's copy) and compare
 *      its version token (`computedAt` + `contentHash`) to the echoed
 *      `expectedVersion` from Tyler's review render. A mismatch means the
 *      client re-submitted between review and Apply (D4 recompute overwrote
 *      `suggested_changes_json` in place) — reject the WHOLE apply, nothing is
 *      written (B1: closes the apply-time TOCTOU where unseen values would
 *      otherwise land under `actorType:"admin"`).
 *   2. Per accepted field, each apply half (in questionnaires.ts) checks, in
 *      this exact order: (a) field allowlist -> `unknown_field`; (b)
 *      `live === proposed` -> `already_applied` no-op BEFORE (c) the D5 stale
 *      check `live !== current` -> `skipped:"changed"` (M9 — otherwise a
 *      genuinely-already-applied double-click reports every field "changed");
 *      (d) D9 re-checks (email collision, calendarSync recompute, event
 *      re-resolution; locations: `existing_missing` / per-field `changed`).
 *   3. Apply ordering: project-profile BEFORE projectEvent (D9/M6), so the
 *      event backfill inherits the freshly-applied venue/date.
 */
export async function applyQuestionnaireAutofillProposal({
  responseId,
  acceptedFields,
  expectedVersion,
  actor,
}: {
  responseId: string;
  acceptedFields: string[];
  expectedVersion: QuestionnaireAutofillVersionToken;
  actor: QuestionnaireAutofillActor;
}): Promise<QuestionnaireAutofillApplyResult> {
  const response = await db.query.questionnaireResponses.findFirst({
    where: eq(questionnaireResponses.id, responseId),
  });
  if (!response) throw new Error("Questionnaire response not found.");
  if (!response.suggestedChangesJson) {
    return { rejected: true, error: "No suggested changes to apply for this response." };
  }

  let proposal: QuestionnaireAutofillProposal;
  try {
    proposal = JSON.parse(response.suggestedChangesJson) as QuestionnaireAutofillProposal;
  } catch {
    return { rejected: true, error: "The stored proposal is corrupt. Ask the client to re-submit." };
  }

  // D8/B1: the version-identity guard. Compares the STORED proposal's own
  // token (computed at D4-recompute time) to what Tyler was shown, not a
  // freshly recomputed hash — the point is proposal IDENTITY, not content
  // re-derivation.
  if (proposal.computedAt !== expectedVersion.computedAt || proposal.contentHash !== expectedVersion.contentHash) {
    return { rejected: true, error: PROPOSAL_VERSION_MISMATCH_ERROR };
  }

  const acceptedSet = new Set(acceptedFields);
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  const skipped: Array<{ field: string; reason: string }> = [];
  const merge = (outcome: FieldApplyOutcome) => {
    applied.push(...outcome.applied);
    alreadyApplied.push(...outcome.alreadyApplied);
    skipped.push(...outcome.skipped);
  };

  const responseContext = { questionnaireId: response.questionnaireId, responseId, projectId: response.projectId, clientId: response.clientId };

  if (proposal.project.length && response.projectId) {
    merge(await applyProjectProfileChanges({
      responseContext,
      projectId: response.projectId,
      changes: proposal.project,
      acceptedFields: acceptedSet,
      actor,
    }));
  }

  // D9/M6: MUST run after project-profile so the event backfill inherits the
  // freshly-applied venue/date rather than pre-apply project values.
  if (proposal.projectEvent.length && response.projectId) {
    merge(await applyProjectEventChanges({
      responseContext,
      projectId: response.projectId,
      changes: proposal.projectEvent,
      acceptedFields: acceptedSet,
      actor,
    }));
  }

  if (proposal.locations.length && response.projectId) {
    merge(await applyProjectLocationsChanges({
      responseContext,
      projectId: response.projectId,
      changes: proposal.locations,
      acceptedFields: acceptedSet,
      actor,
    }));
  }

  if (proposal.client.length && response.clientId) {
    merge(await applyClientProfileChanges({
      responseContext,
      clientId: response.clientId,
      changes: proposal.client,
      acceptedFields: acceptedSet,
      actor,
    }));
  }

  await logActivity({
    action: "questionnaire.autofill.applied",
    projectId: response.projectId || undefined,
    clientId: response.clientId || undefined,
    actorType: actor.actorType,
    actorName: actor.actorName,
    metadata: { responseId, applied, alreadyApplied, skipped },
  });

  return { rejected: false, applied, alreadyApplied, skipped };
}
