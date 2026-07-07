# Phase 23 — Questionnaire-response autofill → review-and-apply (CR-5)

Status: spec rev 1 (build-ready — awaiting adversarial Fable spec review).
Origin: Tyler's CR-5 (2026-07-07). Risk class: **MEDIUM** — this touches the untrusted-input →
canonical-write boundary. No money, no new public endpoints. The build is **dark**; flag-off
reproduces today's behavior byte-for-byte so the flag flip is the only behavior change.

Tyler's ask (verbatim intent): "When a client submits a questionnaire, the answers should (safely)
populate project details (venue, addresses, key times, contacts) and draft the wedding-day
timeline." This spec makes that GREAT *and* guardrail-compliant.

---

## 0. The finding this phase fixes (re-verified against live code)

**Standing invariant** (`src/lib/inbound-inquiry.ts:7-24`, and guardrail 5 in
`docs/handoff-build-state.md`): *no canonical mutation from untrusted input* — client-submitted data
may only create a review item; canonical writes happen only via an explicit admin approval action
(the inbound-inquiry approvals at `src/lib/inbound-inquiry.ts:649-730` are the reference shape).

**The questionnaire system violates this today.** The UNAUTHENTICATED public submission route
`src/app/api/questionnaires/[id]/responses/route.ts` (defended only by an HMAC-signed link token via
`verifyQuestionnaireContext`, plus length caps `MAX_ANSWER_LENGTH`/`MAX_SERIALIZED_ANSWERS_LENGTH`)
calls `updateQuestionnaireResponseAnswers` (`src/lib/questionnaires.ts:1533-1660`) at
`route.ts:140-144`, which **synchronously performs canonical writes** from that untrusted payload:

| Sync fn | Lines | Canonical write from untrusted input |
|---|---|---|
| `syncQuestionnaireResponseProjectProfile` | `questionnaires.ts:1039-1111` | mutates `projects`: sets `eventDate` only if null (`:1053`), but **OVERWRITES** `venueName`/`venueAddress`/`city`/`state` whenever the answer differs (`:1084-1087`) |
| `syncQuestionnaireResponseProjectLocations` | `:880-946` | inserts/updates `project_locations` rows |
| `syncQuestionnaireResponseProjectEvent` | `:970-1037` | inserts/updates a "Wedding day" `project_events` row (notes) |
| `syncQuestionnaireResponseClientProfile` | `:660-763` | mutates `clients` (phone, instagram, email w/ collision check `:732-739`, name split, comms pref, referral) |
| `syncQuestionnaireResponseProjectSource` | `:1171-1238` | writes a `project_sources` transcript row — **harmless / non-canonical, keep as-is** |

Matching is brittle keyword-on-question-title (e.g. `title.includes("venue")` at `:1061`). All five
syncs log activity with `actorType: "system"`.

**Separately, the timeline-DRAFT flow is already correctly draft-shaped but dead-ends.**
`buildTimelineDraftFromProjectContext` (`src/lib/timeline-draft.ts:134-270`, pure — no DB) →
stored in `agent_tasks.outputJson` by `runStudioTimelineDraftTask`
(`src/lib/studio-mcp.ts:2312-2370`, output written at `:2356-2361`) → rendered **read-only** on the
project page (`src/app/projects/[id]/page.tsx:1712-1742`, parser `taskTimelineDraft` at `:180-190`).
The APPLY step does not exist anywhere. `createProjectTimelineItemsFromAgent`
(`src/lib/project-timeline.ts:145-184`, idempotent replace-by-`sourceId` at `:156-165`) is exactly
shaped to consume the draft and **is never called with it**.

---

## 1. Invariants this phase must hold

- **I1 — Flag OFF = today.** With `QUESTIONNAIRE_AUTOFILL_REVIEW !== "1"`, every code path behaves
  exactly as it does now (direct writes from `updateQuestionnaireResponseAnswers`, timeline draft
  dead-ends read-only). We cannot silently change live behavior; Tyler flips.
- **I2 — Flag ON = no canonical write from the public path.** When the flag is on, the public
  submission route may write ONLY: the `questionnaire_responses` row (already non-canonical staging),
  the `project_sources` transcript row (non-canonical), and the new proposal artifact
  (non-canonical). It writes NOTHING to `projects` / `clients` / `project_locations` /
  `project_events`.
- **I3 — Canonical writes happen only via an admin-gated apply action** (`actorType: "admin"`),
  parallel to `approveInquiryProjectCreation`.
- **I4 — No new public endpoints.** The only public write surface remains the existing submission
  route (`^/api/questionnaires/[^/]+/responses$`, the sole public bypass in
  `src/lib/origin-guard.ts:57`). Apply endpoints live under admin-gated paths.
- **I5 — The proposal artifact never carries a secret** — no context token, no HMAC. Only
  answer-derived field values (already length-capped upstream).
- **I6 — D1 has no transactions.** All migration + apply logic is per-object idempotent
  convergence, never wrapped in a transaction.

---

## 2. Design decisions (the ones that matter)

**D1 — Flag ON routes ALL autofill through a proposal, for every caller of
`updateQuestionnaireResponseAnswers`, not just the public route.** The function cannot cheaply tell
whether it was invoked from the public route or the admin edit page
(`/questionnaires/:id/responses/:responseId/edit`), and threading a `trusted` flag through every
caller is more surface than it's worth. Simpler and safer: when the flag is on, the function stops
calling the four canonical syncs and instead computes + stores a proposal, for admin edits too. The
canonical write moves to the one explicit apply action. This is a behavior change for the admin edit
path as well (it, too, becomes review-then-apply), which is acceptable — the admin gains the apply
button — and it keeps exactly one write path to reason about.

**D2 — Proposal storage: mirror the `inbound_inquiries.proposedProjectJson` precedent, as a
`suggested_changes_json` column on `questionnaire_responses`.** Rejected alternatives:
- *agent_tasks outputJson pattern* — would require minting/deduping an agent task per submission;
  `agent_tasks` has an active-dedupe unique index (`migrations/0031_unique_active_agent_tasks.sql`)
  that this would fight. The timeline draft already uses agent_tasks; the project/client proposal
  should not pile onto it.
- *separate `questionnaire_response_proposals` table* — over-modeled for a strictly 1:1 artifact.

The proposal is 1:1 with a response, is naturally overwritten on re-submission (→ convergence, D4),
co-locates with the answers that produced it, and rides along on the row the response-detail page
already loads via `getQuestionnaireResponseDetail`. This is the exact shape inbound-inquiry uses
(`proposed_project_json` on the staging row), so it is the house pattern. Add a companion
`suggested_changes_computed_at` (ISO) for the stale guard (D5) and render freshness.

**D3 — Per-field apply, default-all-checked (NOT all-or-nothing).** The specific harm we are fixing
is the blind venue overwrite (`:1084-1087`). Tyler must be able to accept `eventDate` while
rejecting a venue rename. We already compute field-level diffs, so per-field checkboxes are nearly
free. v1: checkboxes default checked; unchecking a field skips its write.

**D4 — Re-submission convergence.** Each `updateQuestionnaireResponseAnswers` call (flag ON)
recomputes the proposal from the current answers and overwrites `suggested_changes_json` +
`suggested_changes_computed_at`. The proposal is a pure function of (current answers, current
canonical row snapshot); it is idempotent — resubmitting identical answers yields an identical
proposal. Client edits answers → next submission recomputes → the diff reflects the newest answers.
No accumulation, no stale layering.

**D5 — Stale-apply rule: skip any field whose live current value changed since the proposal was
computed.** Each field entry stores `current` (the canonical value at compute time). At apply, for
every accepted field we re-read the live row; if `live !== entry.current`, the field is **skipped**
(a newer admin edit wins) and reported back in the result as `skipped: [{field, reason:"changed"}]`.
This is strictly safer than last-writer-wins (a stale proposal can never clobber a newer admin edit)
and the response-detail page always renders current-vs-proposed so Tyler sees drift before applying.
Rejected: last-writer-wins (can clobber); block-whole-apply-if-any-drift (too brittle — one changed
field shouldn't veto the rest).

**D6 — Timeline apply gated behind the SAME flag, and it IS itself an approval step.** The timeline
apply is net-new (the draft dead-ends today, so nothing regresses if it stays dark), and it is
already an explicit admin action. It does not *need* the flag for safety. But gating it behind the
same `QUESTIONNAIRE_AUTOFILL_REVIEW` keeps the whole Phase 23 surface as one rollout unit that Tyler
evaluates and flips together. Flag off ⇒ the draft still dead-ends read-only (status quo).

**D7 — Semantic mapping (§5): ship the additive `semantic_key` column now, keyword matching stays
the fallback.** Cheap, closes the brittleness Tyler's note calls out, and de-risks the keyword
guesses that drive both the proposal and the existing timeline draft. Details in §5.

---

## 3. The proposal artifact

Stored JSON (`suggested_changes_json`), shape:

```ts
type QuestionnaireAutofillProposal = {
  version: 1;
  responseId: string;
  computedAt: string;              // ISO; mirrors suggested_changes_computed_at
  project: FieldChange[];          // → projects table
  projectEvent: FieldChange[];     // → the "Wedding day" project_events notes (single "notes" field in v1)
  client: FieldChange[];           // → clients table
  locations: LocationChange[];     // → project_locations upserts
};

type FieldChange = {
  field: string;                   // e.g. "venueName", "eventDate", "phone"
  current: string | null;          // canonical value at compute time (drives D5 stale guard)
  proposed: string;                // answer-derived value
  questionTitle: string;           // provenance for the diff UI
  semanticKey?: string;            // §5, when the source question carried one
};

type LocationChange = {
  action: "create" | "update";
  type: string;                    // getting_ready | ceremony | reception | portrait | ...
  name: string; address: string | null; city: string | null; state: string | null; notes: string | null;
  existingId?: string;             // set when action === "update" (matched existing questionnaire_response location)
};
```

- **No secrets** (I5): only field values already capped by the submission route.
- Empty arrays are elided in the UI; a proposal with all-empty arrays renders "No suggested changes".
- The proposal is recomputed and overwritten every submission (D4); it is never appended to.

---

## 4. Code shape — factor each sync into compute + apply halves

For each of the four canonical syncs, split (do NOT duplicate the keyword logic — the matching
helpers `textAnswerForProject`/`textAnswerForClient`/`questionnaireLocationInputs`/
`questionnaireWeddingDayEventNotes` stay shared):

- **compute half** — `computeXProposal({ row, answers }) → FieldChange[] | LocationChange[]`: runs
  the existing extraction + the existing diff-against-current (the `changedFields` filter at
  `:1089-1092` / `:741-744`), but **returns** the field changes instead of writing. Reads the
  canonical row to populate `current`; performs no writes.
- **apply half** — `applyXProposal({ projectId/clientId, changes, admin })`: performs the `db.update`
  / `db.insert` for accepted, non-stale fields with `actorType: "admin"`.

New/changed modules:

- **`src/lib/questionnaire-autofill.ts`** (new): `computeQuestionnaireAutofillProposal({ response,
  answers })` orchestrates the four compute halves into a `QuestionnaireAutofillProposal`, and
  `applyQuestionnaireAutofillProposal({ responseId, acceptedFields, admin })` orchestrates the apply
  halves with the D5 stale guard, wrapped as a single admin action that logs
  `questionnaire.autofill.applied`.
- **`src/lib/questionnaires.ts`**: `updateQuestionnaireResponseAnswers` gains a flag branch
  (`process.env.QUESTIONNAIRE_AUTOFILL_REVIEW === "1"`, strict): flag OFF → today's four sync calls
  (`:1607-1650`) unchanged; flag ON → compute proposal, write `suggested_changes_json` +
  `suggested_changes_computed_at`, and DO NOT call the four syncs. The `project_sources` transcript
  sync (`:1593-1606`) runs in BOTH branches (non-canonical, keep). The four compute halves are
  extracted from the existing sync fns; the four apply halves are the existing write bodies.
- **`getQuestionnaireResponseDetail`** (`:1361-1409`): also select `suggested_changes_json` +
  `suggested_changes_computed_at`, parse, and re-diff each `FieldChange` against the *live* row so
  the UI shows current-vs-proposed with a "changed since computed" badge (D5).

Admin apply surfaces (both admin-gated — parallel to inbound-inquiry; the admin trust boundary is
the Pages proxy login-wall for any non-bypass path, plus `guardDirectWorkerApiRequest`; `actorName`
is sourced the way the sibling admin routes do — hardcoded `"Tyler"`, matching
`send-email/route.ts:72`):

- **`POST /api/questionnaires/[id]/responses/[responseId]/apply`** (new admin route): reads accepted
  field ids from the form, calls `applyQuestionnaireAutofillProposal`, redirects back to the
  response detail with a saved banner. Guards: `guardDirectWorkerApiRequest` (mirrors
  `route.ts` siblings); NOT added to any public bypass list in `origin-guard.ts` (I4). Idempotent
  on double-click: applying twice re-diffs against the now-updated row → the second apply finds no
  changed fields (proposed === current) and is a no-op with `applied: []`.
- **`POST /api/projects/[id]/timeline-draft/apply`** (new admin route, D6): reads the agent task id +
  its `outputJson.timelineDraft`, maps `timelineItems` → `createProjectTimelineItemInput[]`, calls
  `createProjectTimelineItemsFromAgent(projectId, { sourceType: "project_source", sourceId:
  <outputJson.projectSourceId>, replaceExistingForSource: true, timelineItems })`. Idempotent
  re-apply via the existing replace-by-source delete (`project-timeline.ts:156-165`). Gated behind
  `QUESTIONNAIRE_AUTOFILL_REVIEW`.

UI:

- **Response detail** (`src/app/questionnaires/[id]/responses/[responseId]/page.tsx`): flag-ON, a
  "Suggested changes" card above/beside Answers rendering per-field `current → proposed` rows with
  checkboxes (default checked, D3), a "changed since computed" badge per stale field, and an "Apply
  to project" submit posting to the apply route. Flag-OFF ⇒ card absent (page identical to today).
- **Project detail draft card** (`src/app/projects/[id]/page.tsx:1712-1742`): flag-ON, add an
  "Apply timeline draft" button on the existing draft card posting to the timeline-draft apply
  route; the banner already promises review-then-apply. Flag-OFF ⇒ card renders exactly as today
  (read-only).

**familyFormals / locationSuggestions in v1 (D6):** `timelineDraft.familyFormals` stay
**display-only** (no cheap canonical family-formal table to write). `timelineDraft.locationSuggestions`
also stay **display-only** — canonical `project_locations` are covered by the `locations` array of
the §3 proposal (via the extracted `syncQuestionnaireResponseProjectLocations` compute half), which
is the single reconciliation path for locations. The timeline draft's location hints are advisory
and would double-write, so they are not applied in v1.

---

## 5. Semantic mapping robustness (scoped for v1)

Add an optional `semantic_key` TEXT column on `questionnaire_questions` (additive, nullable). A
small closed vocabulary, checked in `src/lib/questionnaire-semantic-keys.ts`:

```
venue_name, venue_address, city, state, event_date,
ceremony_time, getting_ready_location_bride, getting_ready_location_groom,
ceremony_location, reception_location, portrait_location,
client_full_name, client_phone, client_email, client_instagram,
communication_preference, referral_source
```

Matching precedence in every extractor (compute halves + the pure `timeline-draft.ts`): **if a
question has a `semantic_key`, use it FIRST; otherwise fall back to the existing keyword-on-title
matching.** This is purely additive — questions with no key behave exactly as today. Admin sets the
key from the questionnaire edit page (`/questionnaires/:id` question editor) via a dropdown; a
migration does NOT auto-populate keys (that would be a canonical guess — leave existing questions
keyless → keyword fallback until Tyler assigns).

Effort/payoff: the column + vocabulary + a `resolveSemanticValue(answers, key)` helper is small, and
it directly de-risks the exact brittleness Tyler flagged. **Ship it this phase.** (If the reviewer
judges the editor-UI wiring too heavy, the fallback is to ship the column + resolver + keyword
fallback and defer the edit-page dropdown to a follow-up — the resolver reads whatever keys exist.)

---

## 6. Security framing (explicit)

- Flag ON **closes the untrusted-input → canonical-write channel** (I2): the public route can no
  longer touch `projects`/`clients`/`project_locations`/`project_events`.
- **What remains reachable from the public route when ON:** (1) the `questionnaire_responses` row
  (pre-canonical staging, already the case), (2) the `project_sources` transcript row
  (non-canonical, capped, keyed by `sourceId = responseId` — unchanged), (3) the
  `suggested_changes_json` proposal artifact (non-canonical, answer-derived, no secrets, I5). None
  of these three is a canonical business record.
- **Activity-log actor change:** the four applies move from `actorType: "system"`
  (`:755`, `:938`, `:1030`, `:1103`) to `actorType: "admin"` with `actorName: "Tyler"` on the new
  apply action; the timeline items apply logs `project.timeline_item.created` as `actorType:
  "agent"` today (`project-timeline.ts:100-114`) — v1 keeps that actor for the timeline items (the
  draft is agent-generated; the admin action is the *trigger*, logged separately as
  `questionnaire.timeline_draft.applied` with `actorType: "admin"`).
- Flag OFF is unchanged, so the existing violation persists until Tyler flips — this is a deliberate
  no-silent-change tradeoff (I1). The flag flip is the remediation.

---

## 7. Migration — numbering + 3-place mirror

Highest migration present on this branch: **`0093_observability_heartbeat.sql`**. CR-4 (scheduler
Meet links, status BUILDING) will add a `meeting_join_url` migration that most likely lands as
**0094**. This phase therefore plans **`0095_questionnaire_autofill_review.sql`**.
**At build time, CHECK `migrations/` for the actual highest number** — if CR-4's 0094 has not yet
merged, renumber this to the next free number (mirror the 0093 header note precedent).

Single additive migration, three columns, two tables (D1: no transaction; per-column idempotent):

```sql
-- 0095: Phase 23 questionnaire autofill review-and-apply. Additive + idempotent. NON-CANONICAL:
-- these columns hold a review artifact + an optional mapping hint; losing them loses no business state.
ALTER TABLE questionnaire_responses ADD COLUMN suggested_changes_json TEXT;
ALTER TABLE questionnaire_responses ADD COLUMN suggested_changes_computed_at TEXT;
ALTER TABLE questionnaire_questions ADD COLUMN semantic_key TEXT;
```

Mirror in all three places, per repo convention:
1. **`migrations/0095_questionnaire_autofill_review.sql`** — the file above.
2. **`src/db/client.ts`** — a new block after the current tail, using the existing
   `addColumnIfMissing` helper (`src/db/client.ts:23-35`; ALTER-column precedent at `:294-302`):
   ```ts
   addColumnIfMissing(database, "questionnaire_responses", "suggested_changes_json", "TEXT");
   addColumnIfMissing(database, "questionnaire_responses", "suggested_changes_computed_at", "TEXT");
   addColumnIfMissing(database, "questionnaire_questions", "semantic_key", "TEXT");
   ```
3. **`src/db/schema.ts`** — add `suggestedChangesJson`/`suggestedChangesComputedAt` to
   `questionnaireResponses` (`:270-282`) and `semanticKey` to `questionnaireQuestions` (`:257-268`).

No new tables, no indexes needed (proposal is read by response id, already the PK).

---

## 8. Task breakdown (ordered; effort / risk)

1. **Migration + 3-place mirror** (§7). Effort S / Risk L. Purely additive; verify number vs CR-4.
2. **`semantic_key` vocabulary + resolver** (`src/lib/questionnaire-semantic-keys.ts`) (§5).
   Effort S / Risk L. Pure module; keyword fallback preserved.
3. **Extract compute halves** from the four sync fns in `questionnaires.ts` (§4). Effort M / Risk M
   — must preserve today's exact extraction/diff semantics (the flag-OFF regression pin, test 4,
   proves this). Wire `semantic_key`-first into each extractor.
4. **`src/lib/questionnaire-autofill.ts`** — `computeQuestionnaireAutofillProposal` +
   `applyQuestionnaireAutofillProposal` (D5 stale guard, per-field, admin actor, activity log).
   Effort M / Risk M.
5. **Flag branch in `updateQuestionnaireResponseAnswers`** (D1/D2/I2). Effort S / Risk M — the
   invariant hinge; the transcript sync must stay in both branches.
6. **`getQuestionnaireResponseDetail`** returns + re-diffs the proposal (D5 badge). Effort S / Risk L.
7. **Apply route** `POST /api/questionnaires/[id]/responses/[responseId]/apply` + guards (I4).
   Effort S / Risk M.
8. **Response-detail "Suggested changes" card** with per-field checkboxes + Apply button (D3).
   Effort M / Risk L (flag-gated; off = today).
9. **Timeline-draft apply route** `POST /api/projects/[id]/timeline-draft/apply` calling
   `createProjectTimelineItemsFromAgent` with replace-by-source (D6). Effort S / Risk M.
10. **Timeline draft card "Apply" button** on the project page (D6). Effort S / Risk L.
11. **Tests** (§9). Effort M / Risk L.
12. **Docs**: changelog stub (§11), CR-5 status → DARK, note the flag in
    `docs/handoff-build-state.md`. Effort S / Risk L.

---

## 9. Test plan (tsx; follow the sibling patterns in
`src/lib/questionnaire-response-management.test.ts` and `src/lib/project-timeline.test.ts` — each
sets `DATABASE_PATH` to a temp db and imports the real fns)

1. **Proposal computed, not applied (flag ON, public shape).** Seed project+client+participant,
   submit answers (venue rename, new phone, new instagram) via `updateQuestionnaireResponseAnswers`
   with `QUESTIONNAIRE_AUTOFILL_REVIEW=1` → assert `projects`/`clients`/`project_locations`/
   `project_events` rows UNCHANGED; `suggested_changes_json` present with correct field-level diffs
   (`current → proposed`); `project_sources` transcript row STILL written.
2. **Apply writes + logs + idempotent.** Apply the proposal (admin) → canonical rows now updated;
   activity log has `actorType:"admin"`; a second apply is a no-op (`applied: []`, rows unchanged).
3. **Per-field select (D3).** Accept only `eventDate`, reject `venueName` → eventDate written, venue
   untouched.
4. **Stale-proposal rule (D5).** Compute proposal; admin edits `venueName` directly on the project;
   apply the (now stale) proposal that also touched `venueName` → venue field SKIPPED
   (`skipped:[{field:"venueName",reason:"changed"}]`), other accepted fields still applied.
5. **Flag-OFF unchanged (regression pin, I1).** Same submission with the flag unset → today's
   direct-write behavior: `projects`/`clients` mutated in-place, NO `suggested_changes_json`. This
   pins that the flag flip is the ONLY behavior change.
6. **Timeline-draft apply.** Seed a completed Timeline Agent task with an `outputJson.timelineDraft`
   + `projectSourceId`; POST the apply → `project_timeline_items` rows created with
   `sourceType:"project_source"`/`sourceId:<projectSourceId>`; re-apply → replace-by-source leaves
   the SAME count (idempotent, no duplicates).
7. **Re-submission convergence (D4).** Submit answers A → proposal_A; submit answers B (edited) →
   proposal_B reflects B only (no A residue); resubmit B identically → byte-identical proposal.
8. **`semantic_key` precedence (§5).** A question titled ambiguously but tagged
   `semantic_key:"venue_name"` maps to venueName even when the title keyword would miss; a keyless
   question still matches by keyword.
9. **No-secrets guard (I5).** Assert `suggested_changes_json` contains no `context`/token substring.

Gate: `npm run lint` exit 0; `npm run build` EXIT=0 (type errors print after "Compiled
successfully"); `npm test` all pass.

---

## 10. Rollout

- **Default:** `QUESTIONNAIRE_AUTOFILL_REVIEW` unset ⇒ flag OFF ⇒ today's direct-write behavior +
  read-only timeline draft (I1).
- **Enable:** Tyler sets `QUESTIONNAIRE_AUTOFILL_REVIEW=1`. Public submissions then produce
  proposals only; admin applies via one click; timeline drafts gain the Apply button.
- **Rollback:** unset the var ⇒ instantly reverts to direct-write. No data migration needed on
  rollback (the additive columns are simply ignored when off; existing proposals are inert).
- **Deploy ordering:** apply the migration BEFORE enabling the flag (the compute path writes
  `suggested_changes_json`). Migration is additive/idempotent and safe to deploy dark ahead of time.

---

## 11. Hard scope guarantees

- **No money.** Nothing in this phase touches payments, refunds, invoices, or any charge/send path.
- **No new public endpoints.** The only public write surface remains the existing submission route
  (`^/api/questionnaires/[^/]+/responses$`). Both apply routes are admin-gated (not in any
  `origin-guard.ts` public-bypass list) (I4).
- **No canonical writes from the public path when the flag is ON.** Public route touches only the
  response row, the `project_sources` transcript, and the proposal artifact — all non-canonical (I2).
- **Flag OFF = today, byte-for-byte** — the flag flip is the only behavior change (I1, pinned by
  test 5).
- **No transactions in migration or apply** — per-object idempotent convergence only (I6, D1 rule).

---

## 12. Changelog

### Rev 1 — 2026-07-07
Initial build-ready spec. Converts questionnaire autofill from unconditional untrusted-input
canonical writes to flag-gated review-and-apply; wires the missing "Apply timeline draft" step; adds
an optional `semantic_key` mapping column. Dark behind `QUESTIONNAIRE_AUTOFILL_REVIEW`. Awaiting
adversarial Fable spec review.
